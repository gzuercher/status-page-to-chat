import { TableClient, TableServiceClient } from "@azure/data-tables";
import { logger } from "../lib/logger.js";
import type { DiffResult, NormalizedIncident, StoredIncident } from "../lib/types.js";

const TABLE_NAME = "incidents";

/**
 * Creates a TableClient for the incidents table.
 * Creates the table if it does not exist.
 */
export async function createTableClient(connectionString?: string): Promise<TableClient> {
  const connStr = connectionString ?? process.env.AzureWebJobsStorage;
  if (!connStr) {
    throw new Error("AzureWebJobsStorage is not set");
  }

  const serviceClient = TableServiceClient.fromConnectionString(connStr);
  await serviceClient.createTable(TABLE_NAME).catch((err: { statusCode?: number }) => {
    // Table already exists → not an error
    if (err.statusCode !== 409) throw err;
  });

  return TableClient.fromConnectionString(connStr, TABLE_NAME);
}

/**
 * Loads all stored incidents for a specific provider.
 */
export async function getStoredIncidents(
  client: TableClient,
  providerKey: string,
): Promise<Map<string, StoredIncident>> {
  const results = new Map<string, StoredIncident>();

  const entities = client.listEntities<StoredIncident>({
    queryOptions: {
      filter: `PartitionKey eq '${providerKey}'`,
    },
  });

  for await (const entity of entities) {
    results.set(entity.rowKey ?? "", {
      partitionKey: entity.partitionKey ?? "",
      rowKey: entity.rowKey ?? "",
      title: entity.title ?? "",
      status: entity.status ?? "open",
      startedAt: entity.startedAt ?? "",
      updatedAt: entity.updatedAt ?? "",
      url: entity.url ?? "",
      notifiedOpened: entity.notifiedOpened ?? false,
      notifiedResolved: entity.notifiedResolved ?? false,
    });
  }

  return results;
}

/**
 * Compares current incidents against the stored state
 * and determines which actions are needed.
 */
export function diffIncidents(
  current: NormalizedIncident[],
  stored: Map<string, StoredIncident>,
): DiffResult[] {
  const results: DiffResult[] = [];

  for (const incident of current) {
    const existing = stored.get(incident.externalId);

    if (!existing && incident.status === "open") {
      // New open incident → notify
      results.push({ incident, action: "notify_opened" });
    } else if (existing && existing.status === "open" && incident.status === "resolved") {
      // Was open, is now resolved → notify
      results.push({ incident, action: "notify_resolved" });
    } else {
      // No state change
      results.push({ incident, action: "none" });
    }
  }

  return results;
}

/**
 * Inserts or updates an incident in Table Storage.
 */
export async function upsertIncident(
  client: TableClient,
  incident: NormalizedIncident,
  notifiedOpened: boolean,
  notifiedResolved: boolean,
): Promise<void> {
  await client.upsertEntity(
    {
      partitionKey: incident.providerKey,
      rowKey: incident.externalId,
      title: incident.title,
      status: incident.status,
      startedAt: incident.startedAt,
      updatedAt: incident.updatedAt,
      url: incident.url,
      notifiedOpened,
      notifiedResolved,
    },
    "Replace",
  );

  logger.debug(
    { providerKey: incident.providerKey, externalId: incident.externalId, status: incident.status },
    "Incident written to Table Storage",
  );
}

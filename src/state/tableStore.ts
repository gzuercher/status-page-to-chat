import { TableClient, TableServiceClient } from "@azure/data-tables";
import { logger } from "../lib/logger.js";
import type { DiffResult, NormalizedIncident, StoredIncident } from "../lib/types.js";

const TABLE_NAME = "incidents";

/**
 * Erstellt einen TableClient fuer die Incidents-Tabelle.
 * Legt die Tabelle an, falls sie nicht existiert.
 */
export async function createTableClient(connectionString?: string): Promise<TableClient> {
  const connStr = connectionString ?? process.env.AzureWebJobsStorage;
  if (!connStr) {
    throw new Error("AzureWebJobsStorage ist nicht gesetzt");
  }

  const serviceClient = TableServiceClient.fromConnectionString(connStr);
  await serviceClient.createTable(TABLE_NAME).catch((err: { statusCode?: number }) => {
    // Tabelle existiert bereits → kein Fehler
    if (err.statusCode !== 409) throw err;
  });

  return TableClient.fromConnectionString(connStr, TABLE_NAME);
}

/**
 * Laedt alle gespeicherten Incidents fuer einen bestimmten Provider.
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
 * Vergleicht aktuelle Incidents mit dem gespeicherten Zustand
 * und bestimmt, welche Aktionen noetig sind.
 */
export function diffIncidents(
  current: NormalizedIncident[],
  stored: Map<string, StoredIncident>,
): DiffResult[] {
  const results: DiffResult[] = [];

  for (const incident of current) {
    const existing = stored.get(incident.externalId);

    if (!existing && incident.status === "open") {
      // Neuer offener Incident → benachrichtigen
      results.push({ incident, action: "notify_opened" });
    } else if (existing && existing.status === "open" && incident.status === "resolved") {
      // War offen, ist jetzt behoben → benachrichtigen
      results.push({ incident, action: "notify_resolved" });
    } else {
      // Kein Zustandswechsel
      results.push({ incident, action: "none" });
    }
  }

  return results;
}

/**
 * Speichert oder aktualisiert einen Incident in Table Storage.
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
    "Incident in Table Storage geschrieben",
  );
}

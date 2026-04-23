import Database from "better-sqlite3";
import { logger } from "../lib/logger.js";
import type { DiffResult, NormalizedIncident, StoredIncident } from "../lib/types.js";

export type Store = Database.Database;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS incidents (
    provider_key       TEXT    NOT NULL,
    external_id        TEXT    NOT NULL,
    title              TEXT    NOT NULL,
    status             TEXT    NOT NULL CHECK (status IN ('open','resolved')),
    started_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL,
    url                TEXT    NOT NULL,
    notified_opened    INTEGER NOT NULL DEFAULT 0,
    notified_resolved  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_key, external_id)
  );
`;

/**
 * Opens the SQLite store and ensures the schema exists.
 *
 * Path resolution order: explicit `dbPath` argument, then `STATE_DB_PATH`
 * env var, then `/data/state.sqlite` (the default for the containerised
 * deployment). The final path must be writable by the process.
 */
export function createStore(dbPath?: string): Store {
  const path = dbPath ?? process.env.STATE_DB_PATH ?? "/data/state.sqlite";
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(CREATE_TABLE_SQL);
  logger.debug({ path }, "State store opened");
  return db;
}

/**
 * Closes the underlying SQLite connection.
 */
export function closeStore(store: Store): void {
  store.close();
}

type IncidentRow = {
  provider_key: string;
  external_id: string;
  title: string;
  status: "open" | "resolved";
  started_at: string;
  updated_at: string;
  url: string;
  notified_opened: number;
  notified_resolved: number;
};

/**
 * Loads all stored incidents for a specific provider, keyed by externalId.
 *
 * Wrapped in Promise to keep the interface symmetric with the old
 * Table-Storage implementation, even though SQLite access is synchronous.
 */
export async function getStoredIncidents(
  store: Store,
  providerKey: string,
): Promise<Map<string, StoredIncident>> {
  const rows = store
    .prepare<[string], IncidentRow>(
      `SELECT provider_key, external_id, title, status,
              started_at, updated_at, url,
              notified_opened, notified_resolved
         FROM incidents
        WHERE provider_key = ?`,
    )
    .all(providerKey);

  const results = new Map<string, StoredIncident>();
  for (const row of rows) {
    results.set(row.external_id, {
      partitionKey: row.provider_key,
      rowKey: row.external_id,
      title: row.title,
      status: row.status,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      url: row.url,
      notifiedOpened: row.notified_opened === 1,
      notifiedResolved: row.notified_resolved === 1,
    });
  }
  return results;
}

/**
 * Compares current incidents against the stored state and determines
 * which actions are needed. Pure function — unchanged from the previous
 * Table-Storage implementation.
 */
export function diffIncidents(
  current: NormalizedIncident[],
  stored: Map<string, StoredIncident>,
): DiffResult[] {
  const results: DiffResult[] = [];

  for (const incident of current) {
    const existing = stored.get(incident.externalId);

    if (!existing && incident.status === "open") {
      results.push({ incident, action: "notify_opened" });
    } else if (existing && existing.status === "open" && incident.status === "resolved") {
      results.push({ incident, action: "notify_resolved" });
    } else {
      results.push({ incident, action: "none" });
    }
  }

  return results;
}

/**
 * Inserts or updates an incident.
 */
export async function upsertIncident(
  store: Store,
  incident: NormalizedIncident,
  notifiedOpened: boolean,
  notifiedResolved: boolean,
): Promise<void> {
  store
    .prepare(
      `INSERT INTO incidents (
         provider_key, external_id, title, status,
         started_at, updated_at, url,
         notified_opened, notified_resolved
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_key, external_id) DO UPDATE SET
         title             = excluded.title,
         status            = excluded.status,
         started_at        = excluded.started_at,
         updated_at        = excluded.updated_at,
         url               = excluded.url,
         notified_opened   = excluded.notified_opened,
         notified_resolved = excluded.notified_resolved`,
    )
    .run(
      incident.providerKey,
      incident.externalId,
      incident.title,
      incident.status,
      incident.startedAt,
      incident.updatedAt,
      incident.url,
      notifiedOpened ? 1 : 0,
      notifiedResolved ? 1 : 0,
    );

  logger.debug(
    { providerKey: incident.providerKey, externalId: incident.externalId, status: incident.status },
    "Incident written to state store",
  );
}

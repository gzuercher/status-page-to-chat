import Database from "better-sqlite3";
import { logger } from "../lib/logger.js";
import type { DiffResult, NormalizedIncident, StoredIncident } from "../lib/types.js";

export type Store = Database.Database;

/** ISO timestamp of the last completed poll cycle, in the metadata table. */
export const LAST_RUN_METADATA_KEY = "last_run_at";

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
  CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS translations (
    source_hash  TEXT NOT NULL,
    target_lang  TEXT NOT NULL,
    translated   TEXT NOT NULL,
    PRIMARY KEY (source_hash, target_lang)
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
 * Returns a Promise although better-sqlite3 is synchronous — keeps the
 * call-site idiomatic alongside async adapters and notifiers.
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
      providerKey: row.provider_key,
      externalId: row.external_id,
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
 * which actions are needed. Pure function — safe to call from anywhere.
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

/**
 * Loads all stored incidents across every provider as a flat list.
 * Used by the API server to expose the current open-incidents view.
 */
export function getAllStoredIncidents(store: Store): StoredIncident[] {
  const rows = store
    .prepare<[], IncidentRow>(
      `SELECT provider_key, external_id, title, status,
              started_at, updated_at, url,
              notified_opened, notified_resolved
         FROM incidents
        ORDER BY provider_key, started_at DESC`,
    )
    .all();

  return rows.map((row) => ({
    providerKey: row.provider_key,
    externalId: row.external_id,
    title: row.title,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    url: row.url,
    notifiedOpened: row.notified_opened === 1,
    notifiedResolved: row.notified_resolved === 1,
  }));
}

/**
 * Stores a single string metadata value, overwriting any prior value for the key.
 */
export function setMetadata(store: Store, key: string, value: string): void {
  store
    .prepare(
      `INSERT INTO metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

/**
 * Reads a single string metadata value. Returns undefined if absent.
 */
export function getMetadata(store: Store, key: string): string | undefined {
  const row = store
    .prepare<[string], { value: string }>(`SELECT value FROM metadata WHERE key = ?`)
    .get(key);
  return row?.value;
}

/**
 * Reads a cached machine-translation. `sourceHash` is a hash of the source
 * text (the translator owns the hashing). Returns undefined on a cache miss.
 */
export function getCachedTranslation(
  store: Store,
  sourceHash: string,
  targetLang: string,
): string | undefined {
  const row = store
    .prepare<[string, string], { translated: string }>(
      `SELECT translated FROM translations WHERE source_hash = ? AND target_lang = ?`,
    )
    .get(sourceHash, targetLang);
  return row?.translated;
}

/**
 * Stores a machine-translation, overwriting any prior value for the
 * (sourceHash, targetLang) pair.
 */
export function setCachedTranslation(
  store: Store,
  sourceHash: string,
  targetLang: string,
  translated: string,
): void {
  store
    .prepare(
      `INSERT INTO translations (source_hash, target_lang, translated)
         VALUES (?, ?, ?)
         ON CONFLICT(source_hash, target_lang) DO UPDATE SET translated = excluded.translated`,
    )
    .run(sourceHash, targetLang, translated);
}

/** One incident row reduced to what the statistics report needs. */
export type ReportIncidentRow = {
  providerKey: string;
  status: "open" | "resolved";
  startedAt: string;
  updatedAt: string;
};

/**
 * Loads every stored incident that *started* within the given window.
 *
 * The store only ever holds incidents we actually reported — anything
 * suppressed by `componentFilter` or `minImpact`, and anything already
 * resolved when we first saw it, never lands here. The statistics are
 * therefore "what we told you about", which is exactly what a report on
 * notification volume should count.
 */
export function getIncidentsBetween(
  store: Store,
  fromIso: string,
  toIso: string,
): ReportIncidentRow[] {
  return store
    .prepare<[string, string], IncidentRow>(
      `SELECT provider_key, external_id, title, status,
              started_at, updated_at, url,
              notified_opened, notified_resolved
         FROM incidents
        WHERE started_at >= ? AND started_at < ?`,
    )
    .all(fromIso, toIso)
    .map((row) => ({
      providerKey: row.provider_key,
      status: row.status,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }));
}

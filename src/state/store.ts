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
  CREATE TABLE IF NOT EXISTS provider_health (
    provider_key        TEXT NOT NULL PRIMARY KEY,
    first_seen_at       TEXT NOT NULL,
    last_polled_at      TEXT NOT NULL,
    last_upstream_count INTEGER
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
 * External IDs this provider has stored as `open` — the incidents we have
 * reported and still owe a resolution card for.
 *
 * Read before polling and handed to the adapter as {@link FetchContext}, so
 * filters cannot drop an incident that is already in flight. See the type's
 * documentation for why that matters.
 */
export async function getOpenIncidentIds(
  store: Store,
  providerKey: string,
): Promise<ReadonlySet<string>> {
  const rows = store
    .prepare<[string], { external_id: string }>(
      `SELECT external_id FROM incidents WHERE provider_key = ? AND status = 'open'`,
    )
    .all(providerKey);

  return new Set(rows.map((row) => row.external_id));
}

/**
 * Closes incidents that have been `open` without any upstream update for
 * longer than the cutoff, **without** sending a resolution card.
 *
 * Every route by which an incident can get stuck open ends in the same
 * state — a card in the channel claiming an outage continues, months after
 * it ended. The causes differ (a provider that never closes its maintenance
 * windows, an incident aged out of a 50-entry API window, wording no
 * keyword list matches) and patching each one individually is a losing
 * game. This is the catch-all.
 *
 * Deliberately silent: an all-clear two months late informs nobody and
 * reads as a fresh event. The row is marked `notified_resolved` so no
 * later cycle mistakes it for a card still owed.
 *
 * `updated_at` is left untouched on purpose. The reports derive downtime
 * from `updated_at - started_at`, so stamping "now" would book the entire
 * silent stretch as outage time and turn a forgotten maintenance banner
 * into weeks of fictitious downtime. The last real update is the best
 * evidence we have of when it actually ended.
 *
 * Only ever called after a **successful** poll: an adapter that is simply
 * broken must not quietly retire the incidents it can no longer see.
 *
 * @returns the rows that were closed, for logging.
 */
export async function closeStaleIncidents(
  store: Store,
  providerKey: string,
  cutoffIso: string,
): Promise<StoredIncident[]> {
  const rows = store
    .prepare<[string, string], IncidentRow>(
      `SELECT provider_key, external_id, title, status,
              started_at, updated_at, url,
              notified_opened, notified_resolved
         FROM incidents
        WHERE provider_key = ? AND status = 'open' AND updated_at < ?`,
    )
    .all(providerKey, cutoffIso);

  if (rows.length === 0) return [];

  store
    .prepare(
      `UPDATE incidents
          SET status = 'resolved', notified_resolved = 1
        WHERE provider_key = ? AND status = 'open' AND updated_at < ?`,
    )
    .run(providerKey, cutoffIso);

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

/** Observation bookkeeping per provider, independent of any incident. */
export type ProviderHealthRow = {
  providerKey: string;
  /** When this provider was first polled — the baseline for "never reported". */
  firstSeenAt: string;
  lastPolledAt: string;
  /**
   * Incidents the provider's own page returned on the last poll, *before*
   * our filters. Distinguishes "this page is genuinely quiet" from "the
   * page is busy but nothing of it reaches us".
   */
  lastUpstreamCount: number | null;
};

/**
 * Records that a provider was polled successfully.
 *
 * `first_seen_at` is written once and never updated — it is what makes
 * "configured 40 days ago, never reported anything" a statement we can
 * actually make. A provider removed and re-added starts over, which is the
 * intended reading.
 */
export function recordProviderPoll(
  store: Store,
  providerKey: string,
  polledAt: string,
  upstreamCount: number | null,
): void {
  store
    .prepare(
      `INSERT INTO provider_health (provider_key, first_seen_at, last_polled_at, last_upstream_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_key) DO UPDATE SET
         last_polled_at      = excluded.last_polled_at,
         last_upstream_count = excluded.last_upstream_count`,
    )
    .run(providerKey, polledAt, polledAt, upstreamCount);
}

/** Observation bookkeeping for every provider we have ever polled. */
export function getProviderHealth(store: Store): Map<string, ProviderHealthRow> {
  const rows = store
    .prepare<
      [],
      {
        provider_key: string;
        first_seen_at: string;
        last_polled_at: string;
        last_upstream_count: number | null;
      }
    >(
      `SELECT provider_key, first_seen_at, last_polled_at, last_upstream_count FROM provider_health`,
    )
    .all();
  return new Map(
    rows.map((r) => [
      r.provider_key,
      {
        providerKey: r.provider_key,
        firstSeenAt: r.first_seen_at,
        lastPolledAt: r.last_polled_at,
        lastUpstreamCount: r.last_upstream_count,
      },
    ]),
  );
}

/** Most recent incident start per provider, across the whole history. */
export function getLastIncidentPerProvider(store: Store): Map<string, string> {
  const rows = store
    .prepare<[], { provider_key: string; last_started: string }>(
      `SELECT provider_key, MAX(started_at) AS last_started FROM incidents GROUP BY provider_key`,
    )
    .all();
  return new Map(rows.map((r) => [r.provider_key, r.last_started]));
}

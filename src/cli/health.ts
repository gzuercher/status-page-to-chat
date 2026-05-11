import { LAST_RUN_METADATA_KEY, closeStore, createStore, getMetadata } from "../state/store.js";

const DEFAULT_MAX_AGE_SECONDS = 15 * 60;

/**
 * Subcommand: docker HEALTHCHECK.
 *
 * Healthy when the SQLite store opens and the most recent poll completion
 * is younger than HEALTH_MAX_AGE_SECONDS (default 15 min). Detects the
 * "process up but poll loop hung" failure mode that pure container-level
 * liveness checks miss.
 *
 * Exits 0 (healthy) or 1 (unhealthy). Writes a single status line to stdout
 * so `docker inspect` shows useful context.
 */
export function runHealthcheck(): void {
  const maxAgeSeconds = Number(process.env.HEALTH_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);

  let store;
  try {
    store = createStore();
  } catch (err) {
    process.stdout.write(`unhealthy: cannot open state store: ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    const lastRunAt = getMetadata(store, LAST_RUN_METADATA_KEY);
    if (!lastRunAt) {
      // No poll has completed yet. Treat as healthy during startup window
      // — the container is "up but warming". docker-compose's start_period
      // covers this; once a poll completes the metadata is set.
      process.stdout.write("healthy: no poll completed yet (warming up)\n");
      process.exit(0);
    }

    const ageMs = Date.now() - new Date(lastRunAt).getTime();
    const ageSeconds = Math.floor(ageMs / 1000);

    if (Number.isNaN(ageMs) || ageSeconds > maxAgeSeconds) {
      process.stdout.write(`unhealthy: last poll was ${ageSeconds}s ago (max ${maxAgeSeconds}s)\n`);
      process.exit(1);
    }

    process.stdout.write(`healthy: last poll was ${ageSeconds}s ago\n`);
    process.exit(0);
  } finally {
    closeStore(store);
  }
}

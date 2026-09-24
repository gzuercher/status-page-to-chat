import {
  LAST_DELIVERY_ATTEMPT_METADATA_KEY,
  LAST_DELIVERY_OK_METADATA_KEY,
  LAST_RUN_METADATA_KEY,
  LAST_SUCCESSFUL_POLL_METADATA_KEY,
  closeStore,
  createStore,
  getMetadata,
  type Store,
} from "../state/store.js";

const DEFAULT_POLL_MAX_AGE_SECONDS = 15 * 60;
const DEFAULT_DELIVERY_MAX_AGE_SECONDS = 2 * 60 * 60;

export type HealthCheckResult = {
  healthy: boolean;
  message: string;
};

/**
 * Age in whole seconds between an ISO timestamp and `now`, or null if the
 * timestamp does not parse.
 */
function ageSeconds(iso: string, now: number): number | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / 1000);
}

/**
 * Pure evaluation of container health, separated from `process.exit` so it
 * is unit-testable without spawning a process.
 *
 * Checks two things, deliberately kept independent — the 2026-09-20 outage
 * showed why conflating them is exactly how a 23-hour outage goes
 * unnoticed:
 *
 *   1. **Poll path.** Is a provider actually being fetched successfully?
 *      `LAST_SUCCESSFUL_POLL_METADATA_KEY` is only stamped when at least
 *      one provider fetch succeeds this cycle — unlike
 *      `LAST_RUN_METADATA_KEY`, which is stamped every cycle regardless of
 *      outcome and therefore cannot tell "polling works" from "the poll
 *      loop completes but every provider fails" (a DNS/network outage kept
 *      the latter fresh for 23 hours while reporting nothing).
 *
 *   2. **Delivery path.** Did the last attempt to reach the chat target
 *      (webhook/Logic App) actually succeed, and recently? A dead webhook
 *      during a quiet stretch with no incidents to report would otherwise
 *      produce zero failed deliveries — "no failures" is not "delivery
 *      works". main.ts's request-free reachability probe (see
 *      maybeProbeWebhookReachability) exists so this signal cannot go
 *      stale just because nothing newsworthy happened.
 *
 * Both failure modes are reported together when both apply, so `docker
 * inspect` shows the full picture rather than whichever check ran first.
 */
export function evaluateHealth(store: Store, now: number = Date.now()): HealthCheckResult {
  const lastRunAt = getMetadata(store, LAST_RUN_METADATA_KEY);
  if (!lastRunAt) {
    // No cycle has completed at all yet — still starting up. The
    // container's HEALTHCHECK start-period covers this window; once the
    // first cycle completes, both signals below are expected to exist —
    // see maybeProbeWebhookReachability: it fires unconditionally on the
    // very first cycle, independent of poll outcome.
    return { healthy: true, message: "healthy: no poll cycle completed yet (warming up)" };
  }

  const pollMaxAgeSeconds = Number(
    process.env.HEALTH_MAX_AGE_SECONDS ?? DEFAULT_POLL_MAX_AGE_SECONDS,
  );
  const deliveryMaxAgeSeconds = Number(
    process.env.DELIVERY_MAX_AGE_SECONDS ?? DEFAULT_DELIVERY_MAX_AGE_SECONDS,
  );

  const problems: string[] = [];

  const lastSuccessfulPollAt = getMetadata(store, LAST_SUCCESSFUL_POLL_METADATA_KEY);
  if (!lastSuccessfulPollAt) {
    problems.push("poll: no provider has ever been fetched successfully");
  } else {
    const age = ageSeconds(lastSuccessfulPollAt, now);
    if (age === null || age > pollMaxAgeSeconds) {
      problems.push(`poll: last success ${age ?? "unparseable"}s ago (max ${pollMaxAgeSeconds}s)`);
    }
  }

  const lastAttemptAt = getMetadata(store, LAST_DELIVERY_ATTEMPT_METADATA_KEY);
  const lastOkAt = getMetadata(store, LAST_DELIVERY_OK_METADATA_KEY);
  if (!lastAttemptAt) {
    problems.push("delivery: no delivery has ever been attempted");
  } else if (!lastOkAt || new Date(lastOkAt).getTime() < new Date(lastAttemptAt).getTime()) {
    problems.push("delivery: last attempt failed");
  } else {
    const age = ageSeconds(lastOkAt, now);
    if (age === null || age > deliveryMaxAgeSeconds) {
      problems.push(
        `delivery: last success ${age ?? "unparseable"}s ago (max ${deliveryMaxAgeSeconds}s)`,
      );
    }
  }

  if (problems.length > 0) {
    return { healthy: false, message: `unhealthy: ${problems.join("; ")}` };
  }
  return { healthy: true, message: "healthy: poll and delivery both current" };
}

/**
 * Subcommand: docker HEALTHCHECK.
 *
 * Exits 0 (healthy) or 1 (unhealthy). Writes a single status line to stdout
 * so `docker inspect` shows useful context.
 */
export function runHealthcheck(): void {
  let store: Store;
  try {
    store = createStore();
  } catch (err) {
    process.stdout.write(`unhealthy: cannot open state store: ${(err as Error).message}\n`);
    process.exit(1);
    return;
  }

  try {
    const result = evaluateHealth(store);
    process.stdout.write(`${result.message}\n`);
    process.exit(result.healthy ? 0 : 1);
  } finally {
    closeStore(store);
  }
}

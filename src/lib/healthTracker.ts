/**
 * In-memory health tracker for status-page adapters.
 *
 * Two failure modes are detected:
 *
 *   1. **Down** — an adapter throws on N consecutive polls. We fire one
 *      "adapter unhealthy" message and stay silent until it recovers.
 *      Recovery is M consecutive successes after a down state, fires
 *      one "recovered" message.
 *
 *   2. **Half-dead** — an adapter polls cleanly but never returns any
 *      incident at all for HALF_DEAD_DAYS. Almost always indicates a
 *      misconfigured baseUrl (e.g. operator pointed it at a valid but
 *      wrong status page via the MCP API). One message, never repeated
 *      once the flag is set, reset only by the adapter actually
 *      returning an incident or by a config change to adapter/baseUrl.
 *
 * Global suppression: if more than GLOBAL_SUPPRESS_FRACTION of all
 * configured adapters fail in the same poll cycle, no "down" message is
 * emitted that cycle — the cause is almost certainly local (DNS,
 * upstream network) and would just produce a flood of false-positive
 * provider alerts. Recovery messages still fire normally.
 *
 * State is held in-memory only. On container restart the tracker rebuilds
 * its view over the next few poll cycles; worst case we re-fire one down
 * alert that we already fired before the restart. That's an acceptable
 * trade-off for the simpler implementation.
 */

/** Consecutive failures before a "down" alert is fired. 24 polls × 5 min = 2 h. */
export const DOWN_THRESHOLD = 24;

/** Consecutive successes (after a down state) before a "recovered" alert is fired. */
export const RECOVERY_THRESHOLD = 2;

/** Days an adapter must poll cleanly with zero incidents before "half-dead" fires. */
export const HALF_DEAD_DAYS = 7;

/** Suppress per-provider down alerts when more than this fraction fail in one cycle. */
export const GLOBAL_SUPPRESS_FRACTION = 0.5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PollOutcome =
  { kind: "success"; hasIncidents: boolean } | { kind: "failure"; errorCategory: string };

export type PollResult = {
  providerKey: string;
  providerName: string;
  /**
   * Stable fingerprint of the provider's configuration. When the
   * fingerprint changes between polls, the tracker resets that
   * provider's counters — a different adapter or baseUrl is effectively
   * a different provider for health-tracking purposes.
   */
  fingerprint: string;
  logoUrl?: string;
  outcome: PollOutcome;
};

export type HealthEvent =
  | {
      kind: "down";
      providerKey: string;
      providerName: string;
      logoUrl?: string;
      errorCategory: string;
      /** Approximate duration the adapter has been failing. */
      downForMs: number;
    }
  | {
      kind: "recovered";
      providerKey: string;
      providerName: string;
      logoUrl?: string;
      downForMs: number;
    }
  | {
      kind: "halfDead";
      providerKey: string;
      providerName: string;
      logoUrl?: string;
      sinceMs: number;
    };

type ProviderState = {
  fingerprint: string;
  firstSeenAt: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  firstFailureAt: number | null;
  downAlertSent: boolean;
  hasEverReturnedIncident: boolean;
  halfDeadAlertSent: boolean;
};

export class HealthTracker {
  private readonly state = new Map<string, ProviderState>();
  private readonly downThreshold: number;
  private readonly recoveryThreshold: number;
  private readonly halfDeadMs: number;
  private readonly suppressFraction: number;
  private readonly now: () => number;

  constructor(
    opts: {
      downThreshold?: number;
      recoveryThreshold?: number;
      halfDeadDays?: number;
      suppressFraction?: number;
      now?: () => number;
    } = {},
  ) {
    this.downThreshold = opts.downThreshold ?? DOWN_THRESHOLD;
    this.recoveryThreshold = opts.recoveryThreshold ?? RECOVERY_THRESHOLD;
    this.halfDeadMs = (opts.halfDeadDays ?? HALF_DEAD_DAYS) * MS_PER_DAY;
    this.suppressFraction = opts.suppressFraction ?? GLOBAL_SUPPRESS_FRACTION;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Records the outcome of one poll cycle for every configured provider
   * and returns the set of health events that should be notified.
   *
   * Providers that have disappeared from the config since the last call
   * are dropped from the tracker so a re-added provider starts fresh.
   */
  ingest(results: PollResult[]): HealthEvent[] {
    const events: HealthEvent[] = [];
    const seenKeys = new Set<string>();
    const now = this.now();

    // Suppression needs at least a handful of providers to be a meaningful
    // signal. With one or two providers there is no "rest of the system"
    // to compare against, and suppression would just disable the feature
    // for small setups.
    const failureCount = results.filter((r) => r.outcome.kind === "failure").length;
    const suppressDown =
      results.length >= 3 && failureCount / results.length > this.suppressFraction;

    for (const result of results) {
      seenKeys.add(result.providerKey);
      const state = this.getOrInit(result, now);

      // Provider re-configured (adapter or baseUrl changed) — reset counters.
      if (state.fingerprint !== result.fingerprint) {
        this.resetState(state, result.fingerprint, now);
      }

      if (result.outcome.kind === "success") {
        const event = this.recordSuccess(state, result, now);
        if (event) events.push(event);

        const halfDead = this.checkHalfDead(state, result, now);
        if (halfDead) events.push(halfDead);
      } else {
        const event = this.recordFailure(state, result, now, suppressDown);
        if (event) events.push(event);
      }
    }

    // Forget providers that vanished from config.
    for (const key of this.state.keys()) {
      if (!seenKeys.has(key)) this.state.delete(key);
    }

    return events;
  }

  private getOrInit(result: PollResult, now: number): ProviderState {
    const existing = this.state.get(result.providerKey);
    if (existing) return existing;
    const fresh: ProviderState = {
      fingerprint: result.fingerprint,
      firstSeenAt: now,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      firstFailureAt: null,
      downAlertSent: false,
      hasEverReturnedIncident: false,
      halfDeadAlertSent: false,
    };
    this.state.set(result.providerKey, fresh);
    return fresh;
  }

  private resetState(state: ProviderState, fingerprint: string, now: number): void {
    state.fingerprint = fingerprint;
    state.firstSeenAt = now;
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses = 0;
    state.firstFailureAt = null;
    state.downAlertSent = false;
    state.hasEverReturnedIncident = false;
    state.halfDeadAlertSent = false;
  }

  private recordSuccess(state: ProviderState, result: PollResult, now: number): HealthEvent | null {
    const wasDown = state.downAlertSent;
    const downSince = state.firstFailureAt;
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses += 1;
    if (result.outcome.kind === "success" && result.outcome.hasIncidents) {
      state.hasEverReturnedIncident = true;
      // An adapter that finally produced an incident is definitively
      // wired up correctly; clear the half-dead flag so it can re-fire
      // later if the config is genuinely broken again.
      state.halfDeadAlertSent = false;
    }

    if (wasDown && state.consecutiveSuccesses >= this.recoveryThreshold) {
      state.downAlertSent = false;
      state.firstFailureAt = null;
      return {
        kind: "recovered",
        providerKey: result.providerKey,
        providerName: result.providerName,
        logoUrl: result.logoUrl,
        downForMs: downSince ? now - downSince : 0,
      };
    }

    if (state.consecutiveSuccesses >= this.recoveryThreshold) {
      state.firstFailureAt = null;
    }

    return null;
  }

  private recordFailure(
    state: ProviderState,
    result: PollResult,
    now: number,
    suppressDown: boolean,
  ): HealthEvent | null {
    state.consecutiveSuccesses = 0;
    state.consecutiveFailures += 1;
    if (state.firstFailureAt === null) state.firstFailureAt = now;

    if (
      !state.downAlertSent &&
      state.consecutiveFailures >= this.downThreshold &&
      !suppressDown &&
      result.outcome.kind === "failure"
    ) {
      state.downAlertSent = true;
      return {
        kind: "down",
        providerKey: result.providerKey,
        providerName: result.providerName,
        logoUrl: result.logoUrl,
        errorCategory: result.outcome.errorCategory,
        downForMs: now - state.firstFailureAt,
      };
    }

    return null;
  }

  private checkHalfDead(state: ProviderState, result: PollResult, now: number): HealthEvent | null {
    if (state.halfDeadAlertSent) return null;
    if (state.hasEverReturnedIncident) return null;
    if (now - state.firstSeenAt < this.halfDeadMs) return null;

    state.halfDeadAlertSent = true;
    return {
      kind: "halfDead",
      providerKey: result.providerKey,
      providerName: result.providerName,
      logoUrl: result.logoUrl,
      sinceMs: now - state.firstSeenAt,
    };
  }
}

/**
 * Formats an elapsed millisecond value as a short human label, e.g.
 * "2h 15min", "30min", "7 days".
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return "<1min";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  if (days >= 1) {
    return days === 1 ? "1 day" : `${days} days`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}min`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}min`;
}

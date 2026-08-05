import { describe, it, expect } from "vitest";
import { HealthTracker, formatDuration, type PollResult } from "../../src/lib/healthTracker.js";

function fakeNow(initial: number): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * A clean poll. `configDrift` defaults to true: the half-dead checks below
 * are about a filter that no longer matches anything, which is the only
 * situation that warrants an alert.
 */
function success(
  key: string,
  opts: {
    hasIncidents?: boolean;
    configDrift?: boolean;
    fingerprint?: string;
  } = {},
): PollResult {
  return {
    providerKey: key,
    providerName: key,
    fingerprint: opts.fingerprint ?? `${key}-fp`,
    outcome: {
      kind: "success",
      hasIncidents: opts.hasIncidents ?? false,
      configDrift: opts.configDrift ?? true,
    },
  };
}

function failure(key: string, category: string, fingerprint?: string): PollResult {
  return {
    providerKey: key,
    providerName: key,
    fingerprint: fingerprint ?? `${key}-fp`,
    outcome: { kind: "failure", errorCategory: category },
  };
}

describe("HealthTracker — down detection", () => {
  it("does not alert until DOWN_THRESHOLD consecutive failures", () => {
    const clock = fakeNow(0);
    const tracker = new HealthTracker({
      downThreshold: 3,
      recoveryThreshold: 2,
      halfDeadDays: 9999,
      now: clock.now,
    });

    expect(tracker.ingest([failure("a", "HTTP 503")])).toEqual([]);
    expect(tracker.ingest([failure("a", "HTTP 503")])).toEqual([]);

    clock.advance(15 * 60_000);
    const events = tracker.ingest([failure("a", "HTTP 503")]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("down");
    if (events[0].kind === "down") {
      expect(events[0].errorCategory).toBe("HTTP 503");
      expect(events[0].downForMs).toBeGreaterThan(0);
    }
  });

  it("fires the down alert exactly once even if failures continue", () => {
    const tracker = new HealthTracker({
      downThreshold: 2,
      recoveryThreshold: 2,
      halfDeadDays: 9999,
    });
    tracker.ingest([failure("a", "Timeout")]);
    expect(tracker.ingest([failure("a", "Timeout")])).toHaveLength(1);
    expect(tracker.ingest([failure("a", "Timeout")])).toEqual([]);
    expect(tracker.ingest([failure("a", "Timeout")])).toEqual([]);
  });

  it("resets the failure counter on a single success but still requires RECOVERY_THRESHOLD before recovered fires", () => {
    const tracker = new HealthTracker({
      downThreshold: 2,
      recoveryThreshold: 2,
      halfDeadDays: 9999,
    });
    tracker.ingest([failure("a", "Timeout")]);
    tracker.ingest([failure("a", "Timeout")]); // down alert fires
    expect(tracker.ingest([success("a")])).toEqual([]); // 1 success, not enough
    const events = tracker.ingest([success("a")]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("recovered");
  });
});

describe("HealthTracker — global suppression", () => {
  it("suppresses down alerts when more than half of adapters fail in the same cycle", () => {
    const tracker = new HealthTracker({
      downThreshold: 1,
      recoveryThreshold: 1,
      halfDeadDays: 9999,
      suppressFraction: 0.5,
    });
    // 3 of 4 failing → 0.75 > 0.5 → suppress
    const events = tracker.ingest([
      failure("a", "DNS lookup failed"),
      failure("b", "DNS lookup failed"),
      failure("c", "DNS lookup failed"),
      success("d"),
    ]);
    expect(events).toEqual([]);
  });

  it("still fires recovery events during a suppressed cycle", () => {
    const tracker = new HealthTracker({
      downThreshold: 2,
      recoveryThreshold: 1,
      halfDeadDays: 9999,
      suppressFraction: 0.5,
    });
    tracker.ingest([failure("a", "Timeout"), success("b"), success("c"), success("d")]);
    tracker.ingest([failure("a", "Timeout"), success("b"), success("c"), success("d")]); // a → down
    // Now suppress: only a is fine, b/c/d fail.
    const events = tracker.ingest([
      success("a"),
      failure("b", "DNS lookup failed"),
      failure("c", "DNS lookup failed"),
      failure("d", "DNS lookup failed"),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("recovered");
  });
});

describe("HealthTracker — half-dead detection", () => {
  it("fires once after HALF_DEAD_DAYS of a filter that matches nothing", () => {
    const clock = fakeNow(1_000_000);
    const tracker = new HealthTracker({
      downThreshold: 999,
      recoveryThreshold: 999,
      halfDeadDays: 7,
      now: clock.now,
    });

    expect(tracker.ingest([success("a")])).toEqual([]);
    clock.advance(6 * 24 * 60 * 60 * 1000);
    expect(tracker.ingest([success("a")])).toEqual([]); // still below threshold

    clock.advance(2 * 24 * 60 * 60 * 1000); // now > 7d
    const events = tracker.ingest([success("a")]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("halfDead");

    // Never fires again.
    expect(tracker.ingest([success("a")])).toEqual([]);
  });

  it("clears the half-dead flag the moment the adapter returns an incident", () => {
    const clock = fakeNow(1_000_000);
    const tracker = new HealthTracker({
      downThreshold: 999,
      recoveryThreshold: 999,
      halfDeadDays: 1,
      now: clock.now,
    });

    // Seed firstSeenAt, then advance past the half-dead window.
    tracker.ingest([success("a")]);
    clock.advance(2 * 24 * 60 * 60 * 1000);
    expect(tracker.ingest([success("a")])[0].kind).toBe("halfDead");

    // An incident arrives — half-dead flag must reset.
    tracker.ingest([success("a", { hasIncidents: true })]);

    clock.advance(10 * 24 * 60 * 60 * 1000);
    expect(tracker.ingest([success("a")])).toEqual([]); // would re-fire if flag had persisted
  });

  it("stays silent for a healthy provider that simply has no incidents", () => {
    // Regression: a genuinely quiet status page (WEDOS: `"incidents": []`,
    // `"status": "ok"`) and a narrow-but-valid filter on a busy page
    // (kaseya-itglue: "IT Glue" exists, just no recent incident) both used
    // to earn a false half-dead card every 7 days.
    const clock = fakeNow(1_000_000);
    const tracker = new HealthTracker({
      downThreshold: 999,
      recoveryThreshold: 999,
      halfDeadDays: 1,
      now: clock.now,
    });

    tracker.ingest([success("quiet", { configDrift: false })]);
    clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(tracker.ingest([success("quiet", { configDrift: false })])).toEqual([]);
  });

  it("stops alerting once the drift verdict clears, without a restart", () => {
    const clock = fakeNow(1_000_000);
    const tracker = new HealthTracker({
      downThreshold: 999,
      recoveryThreshold: 999,
      halfDeadDays: 1,
      now: clock.now,
    });

    tracker.ingest([success("a", { configDrift: true })]);
    clock.advance(2 * 24 * 60 * 60 * 1000);
    // Operator fixes the filter before the window elapses on a fresh state.
    expect(tracker.ingest([success("a", { configDrift: false })])).toEqual([]);
  });

  it("stays silent when the adapter reports no drift verdict at all", () => {
    const clock = fakeNow(1_000_000);
    const tracker = new HealthTracker({
      downThreshold: 999,
      recoveryThreshold: 999,
      halfDeadDays: 1,
      now: clock.now,
    });

    const unknown: PollResult = {
      providerKey: "unknown",
      providerName: "unknown",
      fingerprint: "unknown-fp",
      outcome: { kind: "success", hasIncidents: false },
    };

    tracker.ingest([unknown]);
    clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(tracker.ingest([unknown])).toEqual([]);
  });
});

describe("HealthTracker — config-change reset", () => {
  it("resets counters when the provider's fingerprint changes", () => {
    const tracker = new HealthTracker({
      downThreshold: 2,
      recoveryThreshold: 2,
      halfDeadDays: 9999,
    });
    tracker.ingest([failure("a", "Timeout", "atlas:host1")]);
    tracker.ingest([failure("a", "Timeout", "atlas:host1")]); // down alert fires
    // Operator switches the adapter — fingerprint changes — counters reset.
    expect(tracker.ingest([failure("a", "Timeout", "hund:host2")])).toEqual([]);
  });
});

describe("HealthTracker — provider lifecycle", () => {
  it("forgets a provider that disappears from the config", () => {
    const tracker = new HealthTracker({
      downThreshold: 2,
      recoveryThreshold: 2,
      halfDeadDays: 9999,
    });
    tracker.ingest([failure("a", "Timeout"), failure("b", "Timeout")]);
    tracker.ingest([failure("a", "Timeout"), failure("b", "Timeout")]); // both down
    // b removed from config — only a present in the next ingest.
    tracker.ingest([success("a")]);
    // Now b is re-added. Should start fresh, no double-recovery fire.
    expect(tracker.ingest([failure("b", "Timeout")])).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("renders short durations", () => {
    expect(formatDuration(0)).toBe("<1min");
    expect(formatDuration(45_000)).toBe("<1min");
    expect(formatDuration(60_000)).toBe("1min");
    expect(formatDuration(30 * 60_000)).toBe("30min");
  });

  it("renders hours with optional minutes", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15min");
  });

  it("renders days language-neutrally for long durations", () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe("1d");
    expect(formatDuration(7 * 24 * 60 * 60_000)).toBe("7d");
  });
});

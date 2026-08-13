import { describe, it, expect } from "vitest";
import {
  closeStaleIncidents,
  closeStore,
  createStore,
  diffIncidents,
  getStoredIncidents,
  upsertIncident,
} from "../../src/state/store.js";
import type { NormalizedIncident, StoredIncident } from "../../src/lib/types.js";

describe("diffIncidents", () => {
  const makeIncident = (id: string, status: "open" | "resolved"): NormalizedIncident => ({
    externalId: id,
    providerKey: "test",
    displayName: "Test",
    title: `Incident ${id}`,
    status,
    url: `https://example.com/${id}`,
    startedAt: "2026-04-15T10:00:00Z",
    updatedAt: "2026-04-15T10:30:00Z",
  });

  const makeStored = (id: string, status: "open" | "resolved"): StoredIncident => ({
    providerKey: "test",
    externalId: id,
    title: `Incident ${id}`,
    status,
    startedAt: "2026-04-15T10:00:00Z",
    updatedAt: "2026-04-15T10:30:00Z",
    url: `https://example.com/${id}`,
    notifiedOpened: true,
    notifiedResolved: status === "resolved",
  });

  it("erkennt neuen offenen Incident", () => {
    const current = [makeIncident("inc-1", "open")];
    const stored = new Map<string, StoredIncident>();

    const results = diffIncidents(current, stored);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("notify_opened");
  });

  it("erkennt behobenen Incident", () => {
    const current = [makeIncident("inc-1", "resolved")];
    const stored = new Map([["inc-1", makeStored("inc-1", "open")]]);

    const results = diffIncidents(current, stored);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("notify_resolved");
  });

  it("erkennt unveraenderten offenen Incident", () => {
    const current = [makeIncident("inc-1", "open")];
    const stored = new Map([["inc-1", makeStored("inc-1", "open")]]);

    const results = diffIncidents(current, stored);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("none");
  });

  it("erkennt unveraenderten resolved Incident", () => {
    const current = [makeIncident("inc-1", "resolved")];
    const stored = new Map([["inc-1", makeStored("inc-1", "resolved")]]);

    const results = diffIncidents(current, stored);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("none");
  });

  it("ignoriert neuen resolved Incident (kein notify_resolved ohne vorheriges open)", () => {
    const current = [makeIncident("inc-1", "resolved")];
    const stored = new Map<string, StoredIncident>();

    const results = diffIncidents(current, stored);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("none");
  });

  it("verarbeitet mehrere Incidents korrekt", () => {
    const current = [
      makeIncident("inc-1", "open"),
      makeIncident("inc-2", "resolved"),
      makeIncident("inc-3", "open"),
    ];
    const stored = new Map([
      ["inc-2", makeStored("inc-2", "open")],
      ["inc-3", makeStored("inc-3", "open")],
    ]);

    const results = diffIncidents(current, stored);

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.incident.externalId === "inc-1")?.action).toBe("notify_opened");
    expect(results.find((r) => r.incident.externalId === "inc-2")?.action).toBe("notify_resolved");
    expect(results.find((r) => r.incident.externalId === "inc-3")?.action).toBe("none");
  });
});

describe("SQLite store (in-memory)", () => {
  const makeIncident = (id: string, status: "open" | "resolved"): NormalizedIncident => ({
    externalId: id,
    providerKey: "acme",
    displayName: "Acme",
    title: `Title ${id}`,
    status,
    url: `https://example.com/${id}`,
    startedAt: "2026-04-15T10:00:00Z",
    updatedAt: "2026-04-15T10:30:00Z",
  });

  it("gibt leere Map fuer unbekannten Provider zurueck", async () => {
    const store = createStore(":memory:");
    try {
      const result = await getStoredIncidents(store, "unknown");
      expect(result.size).toBe(0);
    } finally {
      closeStore(store);
    }
  });

  it("persistiert Insert und Lesen", async () => {
    const store = createStore(":memory:");
    try {
      await upsertIncident(store, makeIncident("inc-1", "open"), true, false);

      const result = await getStoredIncidents(store, "acme");

      expect(result.size).toBe(1);
      const entry = result.get("inc-1");
      expect(entry?.status).toBe("open");
      expect(entry?.title).toBe("Title inc-1");
      expect(entry?.notifiedOpened).toBe(true);
      expect(entry?.notifiedResolved).toBe(false);
    } finally {
      closeStore(store);
    }
  });

  it("aktualisiert bestehenden Incident bei Upsert", async () => {
    const store = createStore(":memory:");
    try {
      await upsertIncident(store, makeIncident("inc-1", "open"), true, false);
      await upsertIncident(store, makeIncident("inc-1", "resolved"), true, true);

      const result = await getStoredIncidents(store, "acme");

      expect(result.size).toBe(1);
      expect(result.get("inc-1")?.status).toBe("resolved");
      expect(result.get("inc-1")?.notifiedResolved).toBe(true);
    } finally {
      closeStore(store);
    }
  });

  it("trennt Incidents nach Provider", async () => {
    const store = createStore(":memory:");
    try {
      await upsertIncident(store, makeIncident("inc-1", "open"), true, false);
      await upsertIncident(
        store,
        { ...makeIncident("inc-2", "open"), providerKey: "other" },
        true,
        false,
      );

      expect((await getStoredIncidents(store, "acme")).size).toBe(1);
      expect((await getStoredIncidents(store, "other")).size).toBe(1);
    } finally {
      closeStore(store);
    }
  });
});

/**
 * The catch-all for incidents that get stuck open. Every route into that
 * state — a provider that never closes its maintenance banners, an incident
 * aged out of a 50-entry API window, wording no keyword list matches — ends
 * in the same place: a card claiming an outage continues, long after it
 * ended. Twelve rows were stuck this way, the oldest by three months.
 */
describe("closeStaleIncidents", () => {
  const CUTOFF = "2026-08-01T00:00:00.000Z";

  const incident = (
    id: string,
    status: "open" | "resolved",
    updatedAt: string,
  ): NormalizedIncident => ({
    externalId: id,
    providerKey: "acme",
    displayName: "Acme",
    title: `Title ${id}`,
    status,
    url: `https://example.com/${id}`,
    startedAt: "2026-06-01T10:00:00.000Z",
    updatedAt,
  });

  it("closes an incident whose last update predates the cutoff", async () => {
    const store = createStore(":memory:");
    try {
      await upsertIncident(store, incident("old", "open", "2026-07-01T10:00:00.000Z"), true, false);

      const closed = await closeStaleIncidents(store, "acme", CUTOFF);

      expect(closed.map((c) => c.externalId)).toEqual(["old"]);
      expect((await getStoredIncidents(store, "acme")).get("old")?.status).toBe("resolved");
    } finally {
      closeStore(store);
    }
  });

  it("marks it as notified so no resolution card is ever owed", async () => {
    // An all-clear months late informs nobody and reads as a fresh event.
    const store = createStore(":memory:");
    try {
      await upsertIncident(store, incident("old", "open", "2026-07-01T10:00:00.000Z"), true, false);

      await closeStaleIncidents(store, "acme", CUTOFF);

      expect((await getStoredIncidents(store, "acme")).get("old")?.notifiedResolved).toBe(true);
    } finally {
      closeStore(store);
    }
  });

  it("leaves updatedAt untouched so reports do not book fictitious downtime", async () => {
    // Reports derive downtime from updatedAt - startedAt. Stamping "now"
    // would turn a forgotten maintenance banner into weeks of outage.
    const store = createStore(":memory:");
    try {
      await upsertIncident(store, incident("old", "open", "2026-07-01T10:00:00.000Z"), true, false);

      await closeStaleIncidents(store, "acme", CUTOFF);

      expect((await getStoredIncidents(store, "acme")).get("old")?.updatedAt).toBe(
        "2026-07-01T10:00:00.000Z",
      );
    } finally {
      closeStore(store);
    }
  });

  it("keeps a recently updated incident open", async () => {
    const store = createStore(":memory:");
    try {
      await upsertIncident(
        store,
        incident("fresh", "open", "2026-08-10T10:00:00.000Z"),
        true,
        false,
      );

      const closed = await closeStaleIncidents(store, "acme", CUTOFF);

      expect(closed).toHaveLength(0);
      expect((await getStoredIncidents(store, "acme")).get("fresh")?.status).toBe("open");
    } finally {
      closeStore(store);
    }
  });

  it("does not touch other providers", async () => {
    const store = createStore(":memory:");
    try {
      await upsertIncident(
        store,
        { ...incident("old", "open", "2026-07-01T10:00:00.000Z"), providerKey: "other" },
        true,
        false,
      );

      const closed = await closeStaleIncidents(store, "acme", CUTOFF);

      expect(closed).toHaveLength(0);
      expect((await getStoredIncidents(store, "other")).get("old")?.status).toBe("open");
    } finally {
      closeStore(store);
    }
  });

  it("returns nothing when there is no stale incident", async () => {
    const store = createStore(":memory:");
    try {
      expect(await closeStaleIncidents(store, "acme", CUTOFF)).toEqual([]);
    } finally {
      closeStore(store);
    }
  });
});

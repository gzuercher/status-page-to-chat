import { describe, it, expect } from "vitest";
import {
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
    partitionKey: "test",
    rowKey: id,
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

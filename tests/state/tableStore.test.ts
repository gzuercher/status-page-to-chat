import { describe, it, expect } from "vitest";
import { diffIncidents } from "../../src/state/tableStore.js";
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

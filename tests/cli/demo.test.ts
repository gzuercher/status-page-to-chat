import { describe, it, expect, vi } from "vitest";
import { demoTypes, sampleIncident, sampleAlert, sendDemo } from "../../src/cli/demo.js";
import type { AdapterHealthAlert, NormalizedIncident, Notifier } from "../../src/lib/types.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

/** Notifier that records what it was asked to send. */
class RecordingNotifier implements Notifier {
  public opened: NormalizedIncident[] = [];
  public resolved: NormalizedIncident[] = [];
  public health: AdapterHealthAlert[] = [];
  async notifyOpened(incident: NormalizedIncident): Promise<void> {
    this.opened.push(incident);
  }
  async notifyResolved(incident: NormalizedIncident): Promise<void> {
    this.resolved.push(incident);
  }
  async notifyAdapterHealth(alert: AdapterHealthAlert): Promise<void> {
    this.health.push(alert);
  }
}

describe("demoTypes", () => {
  it("returns all five types when no argument is given", () => {
    expect(demoTypes()).toEqual(["opened", "resolved", "down", "recovered", "halfdead"]);
  });

  it("resolves aliases", () => {
    expect(demoTypes("open")).toEqual(["opened"]);
    expect(demoTypes("half-dead")).toEqual(["halfdead"]);
    expect(demoTypes("RECOVER")).toEqual(["recovered"]);
  });

  it("throws on an unknown type", () => {
    expect(() => demoTypes("bogus")).toThrow(/Unknown demo type/);
  });
});

describe("sample builders", () => {
  it("labels the incident as a demo via the description", () => {
    expect(sampleIncident("open").description).toMatch(/Beispielkarte/);
  });

  it("builds each adapter-health kind", () => {
    expect(sampleAlert("down").kind).toBe("down");
    expect(sampleAlert("recovered").kind).toBe("recovered");
    expect(sampleAlert("halfDead").kind).toBe("halfDead");
  });
});

describe("sendDemo", () => {
  it("sends one card of every type for a full run", async () => {
    const notifier = new RecordingNotifier();
    await sendDemo(notifier, demoTypes());

    expect(notifier.opened).toHaveLength(1);
    expect(notifier.resolved).toHaveLength(1);
    expect(notifier.health.map((a) => a.kind)).toEqual(["down", "recovered", "halfDead"]);
    expect(notifier.opened[0].status).toBe("open");
    expect(notifier.resolved[0].status).toBe("resolved");
  });

  it("sends only the requested type", async () => {
    const notifier = new RecordingNotifier();
    await sendDemo(notifier, demoTypes("down"));

    expect(notifier.opened).toHaveLength(0);
    expect(notifier.resolved).toHaveLength(0);
    expect(notifier.health).toHaveLength(1);
    expect(notifier.health[0].kind).toBe("down");
  });
});

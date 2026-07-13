import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamsJsonNotifier } from "../../src/notifiers/teamsJson.js";
import type { NormalizedIncident } from "../../src/lib/types.js";

vi.mock("../../src/lib/httpClient.js", () => ({
  httpPost: vi.fn(),
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpPost } from "../../src/lib/httpClient.js";

const mockedHttpPost = vi.mocked(httpPost);

const testIncident: NormalizedIncident = {
  externalId: "inc-001",
  providerKey: "webflow",
  displayName: "Webflow",
  title: "CDN Degradation",
  status: "open",
  url: "https://stspg.io/test001",
  startedAt: "2026-04-15T10:00:00Z",
  updatedAt: "2026-04-15T10:30:00Z",
};

/** The payload sent in the most recent httpPost call. */
function lastPayload(): Record<string, unknown> {
  const calls = mockedHttpPost.mock.calls;
  const [, payload] = calls[calls.length - 1];
  return payload as Record<string, unknown>;
}

function newNotifier(): TeamsJsonNotifier {
  return new TeamsJsonNotifier("https://logic-app.example/trigger", "de");
}

describe("TeamsJsonNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the raw incident envelope (not an Adaptive Card) for an opened incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
    const [url, payload] = mockedHttpPost.mock.calls[0];
    expect(url).toBe("https://logic-app.example/trigger");

    const p = payload as Record<string, unknown>;
    // It is data, not presentation: no card markers.
    expect(p.type).toBeUndefined();
    expect(p.body).toBeUndefined();
    expect(p).toMatchObject({
      schemaVersion: 2,
      source: "status-page-to-chat",
      event: "incident.opened",
      severity: "problem",
      language: "de",
    });
    // Every incident field is present verbatim (title untranslated).
    expect(p.incident).toMatchObject({ ...testIncident });
  });

  it("always includes optional fields as null so the key set is stable across variants", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    // testIncident has neither description nor logoUrl.
    await newNotifier().notifyOpened(testIncident);

    const incident = lastPayload().incident as Record<string, unknown>;
    expect(incident).toHaveProperty("description", null);
    expect(incident).toHaveProperty("logoUrl", null);
  });

  it("emits null errorCategory for non-down adapter alerts, string for down", async () => {
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyAdapterHealth({
      kind: "recovered",
      providerKey: "wedos",
      providerName: "WEDOS",
      durationLabel: "2h",
    });
    const recovered = lastPayload();
    expect(recovered).toMatchObject({ event: "adapter.recovered", severity: "ok" });
    expect(recovered.alert as Record<string, unknown>).toMatchObject({
      logoUrl: null,
      errorCategory: null,
    });

    await newNotifier().notifyAdapterHealth({
      kind: "down",
      providerKey: "wedos",
      providerName: "WEDOS",
      errorCategory: "HTTP 503",
      durationLabel: "2h",
    });
    expect((lastPayload().alert as Record<string, unknown>).errorCategory).toBe("HTTP 503");
  });

  it("emits the incident title verbatim (no translation in JSON mode)", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened(testIncident);

    const incident = lastPayload().incident as NormalizedIncident;
    expect(incident.title).toBe("CDN Degradation");
  });

  it("uses the incident.resolved event for a resolved incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const resolved = { ...testIncident, status: "resolved" as const };
    await newNotifier().notifyResolved(resolved);

    expect(lastPayload()).toMatchObject({ event: "incident.resolved" });
  });

  it("maps an adapter-health alert kind onto the adapter.* event and nests the alert", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyAdapterHealth({
      kind: "down",
      providerKey: "bitwarden",
      providerName: "Bitwarden",
      errorCategory: "timeout",
      durationLabel: "15 minutes",
    });

    const p = lastPayload();
    expect(p).toMatchObject({
      schemaVersion: 2,
      source: "status-page-to-chat",
      event: "adapter.down",
      severity: "problem",
    });
    expect(p.alert).toMatchObject({ kind: "down", providerKey: "bitwarden" });
  });

  it("throws on a non-2xx response and calls httpPost once (retry lives in the client)", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 500, contentType: "", body: "Internal Error" });

    await expect(newNotifier().notifyOpened(testIncident)).rejects.toThrow("HTTP 500");
    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });
});

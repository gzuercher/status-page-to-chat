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

/** The payload sent in the first httpPost call. */
function lastPayload(): Record<string, unknown> {
  const [, payload] = mockedHttpPost.mock.calls[0];
  return payload as Record<string, unknown>;
}

function newNotifier(): TeamsJsonNotifier {
  return new TeamsJsonNotifier("https://logic-app.example/trigger");
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
      schemaVersion: 1,
      source: "status-page-to-chat",
      event: "incident.opened",
    });
    expect(p.incident).toEqual(testIncident);
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
      schemaVersion: 1,
      source: "status-page-to-chat",
      event: "adapter.down",
    });
    expect(p.alert).toMatchObject({ kind: "down", providerKey: "bitwarden" });
  });

  it("retries once on first failure", async () => {
    mockedHttpPost
      .mockRejectedValueOnce(new Error("Timeout"))
      .mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    await newNotifier().notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledTimes(2);
  });

  it("throws when both attempts fail", async () => {
    mockedHttpPost
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ status: 500, contentType: "", body: "Internal Error" });

    await expect(newNotifier().notifyOpened(testIncident)).rejects.toThrow("Retry failed");
    expect(mockedHttpPost).toHaveBeenCalledTimes(2);
  });
});

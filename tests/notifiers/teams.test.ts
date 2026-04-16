import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamsNotifier } from "../../src/notifiers/teams.js";
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

describe("TeamsNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sendet Adaptive Card fuer geoeffneten Incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const notifier = new TeamsNotifier("https://teams.webhook.office.com/test");
    await notifier.notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
    const [url, payload] = mockedHttpPost.mock.calls[0];
    expect(url).toBe("https://teams.webhook.office.com/test");

    const msg = payload as { type: string; attachments: Array<{ contentType: string }> };
    expect(msg.type).toBe("message");
    expect(msg.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
  });

  it("sendet Adaptive Card fuer resolved Incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const resolved = { ...testIncident, status: "resolved" as const };
    const notifier = new TeamsNotifier("https://teams.webhook.office.com/test");
    await notifier.notifyResolved(resolved);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });

  it("macht Retry bei erstem Fehler", async () => {
    mockedHttpPost
      .mockRejectedValueOnce(new Error("Timeout"))
      .mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const notifier = new TeamsNotifier("https://teams.webhook.office.com/test");
    await notifier.notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledTimes(2);
  });
});

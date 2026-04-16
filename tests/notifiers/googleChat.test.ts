import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleChatNotifier } from "../../src/notifiers/googleChat.js";
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
  providerKey: "bexio",
  displayName: "Bexio",
  title: "API nicht erreichbar",
  status: "open",
  url: "https://stspg.io/test001",
  startedAt: "2026-04-15T10:00:00Z",
  updatedAt: "2026-04-15T10:30:00Z",
};

describe("GoogleChatNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sendet Card v2 mit korrektem Format fuer geoeffneten Incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");
    await notifier.notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
    const [url, payload] = mockedHttpPost.mock.calls[0];
    expect(url).toBe("https://chat.googleapis.com/test");

    const card = payload as { cardsV2: Array<{ card: { header: { title: string } } }> };
    expect(card.cardsV2[0].card.header.title).toContain("Bexio");
  });

  it("sendet Card v2 fuer resolved Incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const resolved = { ...testIncident, status: "resolved" as const };
    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");
    await notifier.notifyResolved(resolved);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });

  it("macht Retry bei erstem Fehler", async () => {
    mockedHttpPost
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");
    await notifier.notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledTimes(2);
  });

  it("wirft Fehler wenn Retry auch fehlschlaegt", async () => {
    mockedHttpPost
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ status: 500, contentType: "", body: "Internal Error" });

    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");

    await expect(notifier.notifyOpened(testIncident)).rejects.toThrow("Retry fehlgeschlagen");
  });
});

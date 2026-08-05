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
  title: "API unreachable",
  status: "open",
  url: "https://stspg.io/test001",
  startedAt: "2026-04-15T10:00:00Z",
  updatedAt: "2026-04-15T10:30:00Z",
};

describe("GoogleChatNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends Card v2 with correct format for opened incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");
    await notifier.notifyOpened(testIncident);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
    const [url, payload] = mockedHttpPost.mock.calls[0];
    expect(url).toBe("https://chat.googleapis.com/test");

    const card = payload as { cardsV2: Array<{ card: { header: { title: string } } }> };
    expect(card.cardsV2[0].card.header.title).toContain("Bexio");
  });

  it("sends Card v2 for resolved incident", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const resolved = { ...testIncident, status: "resolved" as const };
    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");
    await notifier.notifyResolved(resolved);

    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });

  it("throws on a non-2xx response and calls httpPost once (retry lives in the client)", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 500, contentType: "", body: "Internal Error" });

    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");
    await expect(notifier.notifyOpened(testIncident)).rejects.toThrow("HTTP 500");
    expect(mockedHttpPost).toHaveBeenCalledOnce();
  });

  it("renders an adapter-health card with system header and provider in the body", async () => {
    mockedHttpPost.mockResolvedValueOnce({ status: 200, contentType: "", body: "" });

    const notifier = new GoogleChatNotifier("https://chat.googleapis.com/test");
    await notifier.notifyAdapterHealth({
      kind: "halfDead",
      providerKey: "cloudflare",
      providerName: "Cloudflare",
      logoUrl: "https://logo.example/cloudflare.png",
      durationLabel: "7d",
    });

    const [, payload] = mockedHttpPost.mock.calls[0];
    const json = JSON.stringify(payload);
    expect(json).toContain("status-page-to-chat");
    expect(json).toContain("🛠️");
    expect(json).toContain("Cloudflare");
    expect(json).toContain("componentFilter");
    expect(json).toContain("7d");
  });
});

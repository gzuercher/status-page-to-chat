import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MetanetRssAdapter } from "../../src/adapters/metanetRss.js";
import type { ProviderConfig } from "../../src/lib/config.js";

vi.mock("../../src/lib/httpClient.js", () => ({ httpGet: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

const rssFixture = readFileSync(resolve(__dirname, "../fixtures/metanet-rss.xml"), "utf-8");

const config: ProviderConfig = {
  key: "metanet",
  displayName: "Metanet",
  adapter: "metanet-rss",
};

describe("MetanetRssAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parst RSS-Items und filtert Wartungsarbeiten", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/rss+xml",
      body: rssFixture,
    });

    const adapter = new MetanetRssAdapter(config);
    const incidents = await adapter.fetchIncidents();

    // 3 Items, davon 1 Wartungsarbeiten → 2 uebrig
    expect(incidents).toHaveLength(2);
  });

  it("erkennt offene Stoerung", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/rss+xml",
      body: rssFixture,
    });

    const adapter = new MetanetRssAdapter(config);
    const incidents = await adapter.fetchIncidents();

    const open = incidents.filter((i) => i.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0].title).toContain("Betriebsunterbruch");
  });

  it("erkennt behobene Stoerung anhand Keyword", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/rss+xml",
      body: rssFixture,
    });

    const adapter = new MetanetRssAdapter(config);
    const incidents = await adapter.fetchIncidents();

    const resolved = incidents.filter((i) => i.status === "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toContain("behoben");
  });

  it("wirft Fehler bei HTTP-Fehler", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 503,
      contentType: "text/html",
      body: "Error",
    });

    const adapter = new MetanetRssAdapter(config);
    await expect(adapter.fetchIncidents()).rejects.toThrow("HTTP 503");
  });
});

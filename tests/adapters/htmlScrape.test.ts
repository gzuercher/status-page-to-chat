import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HtmlScrapeAdapter } from "../../src/adapters/htmlScrape.js";
import type { ProviderConfig } from "../../src/lib/config.js";

vi.mock("../../src/lib/httpClient.js", () => ({
  httpGet: vi.fn(),
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, "..", "fixtures", name), "utf-8");
}

function mockHtmlResponse(body: string, status = 200) {
  return {
    status,
    contentType: "text/html; charset=utf-8",
    body,
  };
}

describe("HtmlScrapeAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const checkcentralConfig: ProviderConfig = {
    key: "checkcentral",
    displayName: "CheckCentral",
    adapter: "html-scrape",
    baseUrl: "https://status.checkcentral.cc",
    selector: ".StatusDot > div",
    healthyMatch: "success",
  };

  const sophosConfig: ProviderConfig = {
    key: "sophos",
    displayName: "Sophos",
    adapter: "html-scrape",
    baseUrl: "https://status.sophos.com",
    selector: ".page-status .status",
    healthyMatch: "All Systems Operational",
  };

  it("CheckCentral: success class → keine Incidents", async () => {
    mockedHttpGet.mockResolvedValueOnce(mockHtmlResponse(fixture("checkcentral-healthy.html")));

    const adapter = new HtmlScrapeAdapter(checkcentralConfig);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(0);
  });

  it("CheckCentral: andere Klasse → synthetischer Incident", async () => {
    mockedHttpGet.mockResolvedValueOnce(mockHtmlResponse(fixture("checkcentral-unhealthy.html")));

    const adapter = new HtmlScrapeAdapter(checkcentralConfig);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("open");
    expect(incidents[0].providerKey).toBe("checkcentral");
    expect(incidents[0].displayName).toBe("CheckCentral");
    expect(incidents[0].url).toBe("https://status.checkcentral.cc");
    expect(incidents[0].title).toContain("danger");
    expect(incidents[0].externalId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("CheckCentral: externalId ist stabil ueber wiederholte Polls", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockHtmlResponse(fixture("checkcentral-unhealthy.html")))
      .mockResolvedValueOnce(mockHtmlResponse(fixture("checkcentral-unhealthy.html")));

    const adapter = new HtmlScrapeAdapter(checkcentralConfig);
    const first = await adapter.fetchIncidents();
    const second = await adapter.fetchIncidents();

    expect(first[0].externalId).toBe(second[0].externalId);
  });

  it("Sophos: All Systems Operational → keine Incidents", async () => {
    mockedHttpGet.mockResolvedValueOnce(mockHtmlResponse(fixture("sophos-healthy.html")));

    const adapter = new HtmlScrapeAdapter(sophosConfig);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(0);
  });

  it("Sophos: Major Outage → ein offener Incident mit Outage-Text", async () => {
    mockedHttpGet.mockResolvedValueOnce(mockHtmlResponse(fixture("sophos-unhealthy.html")));

    const adapter = new HtmlScrapeAdapter(sophosConfig);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("open");
    expect(incidents[0].title).toContain("Major Service Outage");
  });

  it("titleTemplate Override wird angewendet", async () => {
    mockedHttpGet.mockResolvedValueOnce(mockHtmlResponse(fixture("sophos-unhealthy.html")));

    const adapter = new HtmlScrapeAdapter({
      ...sophosConfig,
      titleTemplate: "Sophos: {matchedText}",
    });
    const incidents = await adapter.fetchIncidents();

    expect(incidents[0].title).toBe("Sophos: Major Service Outage");
  });

  it("healthyMatch als Regex (/.../i) wird erkannt", async () => {
    mockedHttpGet.mockResolvedValueOnce(mockHtmlResponse(fixture("sophos-healthy.html")));

    const adapter = new HtmlScrapeAdapter({
      ...sophosConfig,
      healthyMatch: "/^all systems operational$/i",
    });
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(0);
  });

  it("wirft Fehler bei HTTP-Fehler (z.B. Sophos 403)", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 403,
      contentType: "text/html",
      body: "Invalid request blocked (v1)",
    });

    const adapter = new HtmlScrapeAdapter(sophosConfig);

    await expect(adapter.fetchIncidents()).rejects.toThrow("HTTP 403");
  });

  it("wirft Fehler wenn Selector nicht matched", async () => {
    mockedHttpGet.mockResolvedValueOnce(mockHtmlResponse("<html><body><p>nope</p></body></html>"));

    const adapter = new HtmlScrapeAdapter(checkcentralConfig);

    await expect(adapter.fetchIncidents()).rejects.toThrow("did not match");
  });

  it("wirft Fehler bei nicht-HTML Content-Type", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });

    const adapter = new HtmlScrapeAdapter(checkcentralConfig);

    await expect(adapter.fetchIncidents()).rejects.toThrow("Unexpected Content-Type");
  });
});

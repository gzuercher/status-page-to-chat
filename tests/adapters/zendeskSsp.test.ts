import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZendeskSspAdapter } from "../../src/adapters/zendeskSsp.js";
import type { ProviderConfig } from "../../src/lib/config.js";
import incidentsFixture from "../fixtures/zendesk-ssp-incidents.json";
import servicesFixture from "../fixtures/zendesk-ssp-services.json";

vi.mock("../../src/lib/httpClient.js", () => ({ httpGet: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

const baseConfig: ProviderConfig = {
  key: "zendesk",
  displayName: "Zendesk",
  adapter: "zendesk-ssp",
  baseUrl: "https://status.zendesk.com",
};

function mockIncidents() {
  mockedHttpGet.mockResolvedValueOnce({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(incidentsFixture),
  });
}

function mockServices() {
  mockedHttpGet.mockResolvedValueOnce({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(servicesFixture),
  });
}

describe("ZendeskSspAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps SSP incidents to normalized model and detects resolved via status field", async () => {
    mockIncidents();
    const incidents = await new ZendeskSspAdapter(baseConfig).fetchIncidents();
    expect(incidents).toHaveLength(3);

    const resolved = incidents.filter((i) => i.status === "resolved");
    const open = incidents.filter((i) => i.status === "open");
    expect(resolved).toHaveLength(2);
    expect(open).toHaveLength(1);
    expect(open[0].externalId).toBe("9002");
    expect(open[0].title).toContain("Help Center");
  });

  it("filters by componentFilter substring against incident name (case-insensitive)", async () => {
    mockIncidents();
    mockServices();
    const incidents = await new ZendeskSspAdapter({
      ...baseConfig,
      componentFilter: "help center",
    }).fetchIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].externalId).toBe("9002");
  });

  it("does not fetch services when no componentFilter is set", async () => {
    mockIncidents();
    await new ZendeskSspAdapter(baseConfig).fetchIncidents();
    expect(mockedHttpGet).toHaveBeenCalledTimes(1);
  });

  it("links every incident to the status-page homepage (no per-incident URL exists)", async () => {
    mockIncidents();
    const incidents = await new ZendeskSspAdapter(baseConfig).fetchIncidents();
    incidents.forEach((i) => expect(i.url).toBe("https://status.zendesk.com"));
  });

  it("throws on non-200 incidents response", async () => {
    mockedHttpGet.mockResolvedValueOnce({ status: 500, contentType: "", body: "" });
    await expect(new ZendeskSspAdapter(baseConfig).fetchIncidents()).rejects.toThrow(/HTTP 500/);
  });
});

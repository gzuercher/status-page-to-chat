import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZendeskSspAdapter } from "../../src/adapters/zendeskSsp.js";
import type { ProviderConfig } from "../../src/lib/config.js";
import incidentsFixture from "../fixtures/zendesk-ssp-incidents.json";

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

  it("filters by the service name carried in included[] (case-insensitive)", async () => {
    mockIncidents();
    const incidents = await new ZendeskSspAdapter({
      ...baseConfig,
      componentFilter: ["knowledge"],
    }).fetchIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].externalId).toBe("9002");
  });

  it("matches no incident when the filter names a service that no longer exists", async () => {
    // Regression: "Help Center" was renamed "Knowledge" upstream. The old
    // code matched the filter against incident *titles*, which made this
    // look like it worked for some incidents and silently broke others.
    mockIncidents();
    const incidents = await new ZendeskSspAdapter({
      ...baseConfig,
      componentFilter: ["Help Center"],
    }).fetchIncidents();
    expect(incidents).toHaveLength(0);
  });

  it("falls back to the incident title when no service reference resolves", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: "9500",
            type: "incident",
            attributes: {
              name: "Help Center Slow Page Loads",
              status: "investigating",
              startedAt: "2026-07-01T10:00:00.000Z",
              resolvedAt: null,
            },
          },
        ],
      }),
    });
    const incidents = await new ZendeskSspAdapter({
      ...baseConfig,
      componentFilter: ["help center"],
    }).fetchIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].externalId).toBe("9500");
  });

  it("never issues a second request — service names come from included[]", async () => {
    mockIncidents();
    await new ZendeskSspAdapter({ ...baseConfig, componentFilter: ["knowledge"] }).fetchIncidents();
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

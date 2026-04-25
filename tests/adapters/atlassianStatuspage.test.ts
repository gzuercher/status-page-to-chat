import { describe, it, expect, vi, beforeEach } from "vitest";
import { AtlassianStatuspageAdapter } from "../../src/adapters/atlassianStatuspage.js";
import type { ProviderConfig } from "../../src/lib/config.js";
import unresolvedFixture from "../fixtures/atlassian-unresolved.json";
import recentFixture from "../fixtures/atlassian-recent.json";

// HTTP-Client mocken
vi.mock("../../src/lib/httpClient.js", () => ({
  httpGet: vi.fn(),
}));

// Logger mocken (keine Ausgabe in Tests)
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

function mockJsonResponse(data: unknown) {
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(data),
  };
}

describe("AtlassianStatuspageAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseConfig: ProviderConfig = {
    key: "test-provider",
    displayName: "Test Provider",
    adapter: "atlassian-statuspage",
    baseUrl: "https://status.example.com",
  };

  it("gibt offene und resolved Incidents zurueck", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
      .mockResolvedValueOnce(mockJsonResponse(recentFixture));

    const adapter = new AtlassianStatuspageAdapter(baseConfig);
    const incidents = await adapter.fetchIncidents();

    // 3 unresolved + 3 recent, davon inc-001 dedupliziert = 5 unique
    expect(incidents).toHaveLength(5);

    const open = incidents.filter((i) => i.status === "open");
    const resolved = incidents.filter((i) => i.status === "resolved");

    expect(open).toHaveLength(3);
    expect(resolved).toHaveLength(2);
  });

  it("mappt Status korrekt", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
      .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));

    const adapter = new AtlassianStatuspageAdapter(baseConfig);
    const incidents = await adapter.fetchIncidents();

    // investigating, identified, monitoring → alle "open"
    expect(incidents.every((i) => i.status === "open")).toBe(true);
  });

  it("filtert nach einzelnem componentFilter (String)", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
      .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));

    const config: ProviderConfig = {
      ...baseConfig,
      componentFilter: "IT Glue",
    };
    const adapter = new AtlassianStatuspageAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].title).toBe("Stoerung im IT Glue Modul");
  });

  it("filtert nach componentFilter-Liste (OR-Logik)", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }))
      .mockResolvedValueOnce(mockJsonResponse(recentFixture));

    const config: ProviderConfig = {
      ...baseConfig,
      componentFilter: ["cloudgz.gravityzone", "cloud.gravityzone"],
    };
    const adapter = new AtlassianStatuspageAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].externalId).toBe("inc-005");
  });

  it("gibt alle Incidents zurueck wenn kein componentFilter gesetzt", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
      .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));

    const adapter = new AtlassianStatuspageAdapter(baseConfig);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(3);
  });

  it("wirft Fehler bei nicht-JSON Content-Type (Sophos-Fall)", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<html><body>Not Found</body></html>",
    });

    const adapter = new AtlassianStatuspageAdapter(baseConfig);

    await expect(adapter.fetchIncidents()).rejects.toThrow("the JSON API may be disabled");
  });

  it("wirft Fehler bei HTTP-Fehler", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 503,
      contentType: "text/html",
      body: "Service Unavailable",
    });

    const adapter = new AtlassianStatuspageAdapter(baseConfig);

    await expect(adapter.fetchIncidents()).rejects.toThrow("HTTP 503");
  });

  it("setzt providerKey und displayName korrekt", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
      .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));

    const adapter = new AtlassianStatuspageAdapter(baseConfig);
    const incidents = await adapter.fetchIncidents();

    for (const incident of incidents) {
      expect(incident.providerKey).toBe("test-provider");
      expect(incident.displayName).toBe("Test Provider");
    }
  });

  it("componentFilter ist case-insensitive", async () => {
    mockedHttpGet
      .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
      .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));

    const config: ProviderConfig = {
      ...baseConfig,
      componentFilter: "it glue", // Kleinbuchstaben
    };
    const adapter = new AtlassianStatuspageAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].title).toBe("Stoerung im IT Glue Modul");
  });
});

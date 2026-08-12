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

/**
 * Component catalogue matching the incident fixtures, shaped like a real
 * `/api/v2/components.json`: groups are components with `group: true`, and
 * members point back via `group_id`. `comp-6` sits inside a group whose
 * name is the only place the cloud instance is mentioned — exactly the
 * Bitdefender/Kaseya layout that name-only filtering cannot express.
 */
const CATALOGUE = [
  {
    id: "grp-1",
    name: "GravityZone Cloud Instance 1 (cloudgz.gravityzone.bitdefender.com)",
    group: true,
    group_id: null,
  },
  { id: "comp-1", name: "API", group: false, group_id: null },
  { id: "comp-2", name: "Dashboard", group: false, group_id: null },
  { id: "comp-3", name: "Authentication", group: false, group_id: null },
  { id: "comp-4", name: "IT Glue", group: false, group_id: null },
  { id: "comp-5", name: "VSA", group: false, group_id: null },
  { id: "comp-6", name: "Management Console", group: false, group_id: "grp-1" },
];

/** Queues the two incident endpoints followed by the component catalogue. */
function mockEndpoints(
  unresolved: unknown,
  recent: unknown,
  components: unknown = CATALOGUE,
): void {
  mockedHttpGet
    .mockResolvedValueOnce(mockJsonResponse(unresolved))
    .mockResolvedValueOnce(mockJsonResponse(recent))
    .mockResolvedValueOnce(mockJsonResponse({ components }));
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

  describe("componentFilter drift detection", () => {
    // Feeds the two incident endpoints, then a flat component catalogue.
    function mockIncidentsThenComponents(componentNames: string[]) {
      mockEndpoints(
        { incidents: [] },
        recentFixture,
        componentNames.map((name, i) => ({ id: `c-${i}`, name, group: false, group_id: null })),
      );
    }

    it("reports drift when the filter matches no current component", async () => {
      mockIncidentsThenComponents(["Management Console", "Email Security"]);
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["Member experience"],
      });

      expect(await adapter.fetchIncidents()).toHaveLength(0);
      expect(adapter.lastConfigDrift).toBe(true);
    });

    it("reports no drift for a narrow but valid filter that simply had no incident", async () => {
      // kaseya-itglue in production: "IT Glue" is a real component, it just
      // had no incident among the most recent ones. Healthy, not half-dead.
      mockIncidentsThenComponents(["IT Glue", "Backup", "KaseyaOne"]);
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["IT Glue"],
      });

      expect(await adapter.fetchIncidents()).toHaveLength(0);
      expect(adapter.lastConfigDrift).toBe(false);
    });

    it("reports no drift when a filter naming a group resolves to its members", async () => {
      // gravityzone-bitdefender in production: the filter names a cloud
      // instance, which Statuspage models as a group. Resolving it yields
      // real components, so the config is healthy — not drifted.
      mockEndpoints({ incidents: [] }, recentFixture);
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["cloudgz.gravityzone.bitdefender.com"],
      });

      expect((await adapter.fetchIncidents()).length).toBeGreaterThan(0);
      expect(adapter.lastConfigDrift).toBe(false);
    });

    it("reports drift when the filter only matches a group that has no members", async () => {
      // A group name that resolves to nothing is as dead as a missing one.
      mockEndpoints({ incidents: [] }, recentFixture, [
        { id: "grp-9", name: "Empty Group", group: true, group_id: null },
        { id: "comp-9", name: "Something Else", group: false, group_id: null },
      ]);
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["Empty Group"],
      });

      expect(await adapter.fetchIncidents()).toHaveLength(0);
      expect(adapter.lastConfigDrift).toBe(true);
    });

    it("reports no drift when there is no filter at all", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter(baseConfig);

      expect(await adapter.fetchIncidents()).toHaveLength(0);
      expect(adapter.lastConfigDrift).toBe(false);
      expect(mockedHttpGet).toHaveBeenCalledTimes(2);
    });

    it("keeps filtering by name when the catalogue is unreachable", async () => {
      // A transient components.json failure must not silence the provider.
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }))
        .mockRejectedValueOnce(new Error("ECONNRESET"));
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["IT Glue"],
      });

      const incidents = await adapter.fetchIncidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0].externalId).toBe("inc-003");
      expect(adapter.lastConfigDrift).toBeUndefined();
    });

    it("does not fetch the catalogue when no filter is configured", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse(unresolvedFixture))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter(baseConfig);

      await adapter.fetchIncidents();
      expect(mockedHttpGet).toHaveBeenCalledTimes(2);
    });

    it("stays undecided when the catalogue is unreachable", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }))
        .mockResolvedValueOnce(mockJsonResponse(recentFixture))
        .mockRejectedValueOnce(new Error("ECONNRESET"));
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["Member experience"],
      });

      await adapter.fetchIncidents();
      expect(adapter.lastConfigDrift).toBeUndefined();
    });
  });

  describe("minImpact", () => {
    const incidents = {
      incidents: [
        {
          id: "i-crit",
          name: "Total outage",
          status: "investigating",
          impact: "critical",
          created_at: "2026-08-01T10:00:00Z",
          updated_at: "2026-08-01T10:00:00Z",
        },
        {
          id: "i-major",
          name: "Degraded API",
          status: "identified",
          impact: "major",
          created_at: "2026-08-01T10:00:00Z",
          updated_at: "2026-08-01T10:00:00Z",
        },
        {
          id: "i-minor",
          name: "Network blip in Bangalore",
          status: "monitoring",
          impact: "minor",
          created_at: "2026-08-01T10:00:00Z",
          updated_at: "2026-08-01T10:00:00Z",
        },
        {
          id: "i-none",
          name: "Informational notice",
          status: "investigating",
          impact: "none",
          created_at: "2026-08-01T10:00:00Z",
          updated_at: "2026-08-01T10:00:00Z",
        },
      ],
    };

    it("reports everything when minImpact is unset", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse(incidents))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter(baseConfig);

      expect(await adapter.fetchIncidents()).toHaveLength(4);
    });

    it("suppresses minor and none at minImpact major", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse(incidents))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter({ ...baseConfig, minImpact: "major" });

      const result = await adapter.fetchIncidents();
      expect(result.map((i) => i.externalId).sort()).toEqual(["i-crit", "i-major"]);
    });

    it("keeps only critical at minImpact critical", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse(incidents))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter({ ...baseConfig, minImpact: "critical" });

      const result = await adapter.fetchIncidents();
      expect(result.map((i) => i.externalId)).toEqual(["i-crit"]);
    });

    it("reports an incident whose impact is missing or unknown", async () => {
      // Never hide what we cannot classify — that is the surprising case.
      mockedHttpGet
        .mockResolvedValueOnce(
          mockJsonResponse({
            incidents: [
              {
                id: "i-noimpact",
                name: "Legacy incident",
                status: "investigating",
                created_at: "2026-08-01T10:00:00Z",
                updated_at: "2026-08-01T10:00:00Z",
              },
              {
                id: "i-weird",
                name: "Odd",
                status: "investigating",
                impact: "maintenance",
                created_at: "2026-08-01T10:00:00Z",
                updated_at: "2026-08-01T10:00:00Z",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter({ ...baseConfig, minImpact: "critical" });

      expect(await adapter.fetchIncidents()).toHaveLength(2);
    });
  });

  /**
   * Regression: a reported incident must reach its resolution card.
   *
   * Filters gate entry, not exit. Statuspage downgrades `major` to `minor`
   * once an incident reaches monitoring, and editing `minImpact` or
   * `componentFilter` strands whatever is in flight — in both cases the
   * incident silently leaves the watched set and the all-clear never fires,
   * leaving readers to believe an outage is ongoing.
   */
  describe("trackedOpenIds", () => {
    const downgraded = {
      incidents: [
        {
          id: "i-downgraded",
          name: "Degraded performance for multiple models",
          status: "monitoring",
          impact: "minor",
          created_at: "2026-08-01T10:00:00Z",
          updated_at: "2026-08-01T12:00:00Z",
        },
      ],
    };

    it("keeps an already-reported incident that fell below minImpact", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse(downgraded))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter({ ...baseConfig, minImpact: "major" });

      const result = await adapter.fetchIncidents({
        trackedOpenIds: new Set(["i-downgraded"]),
      });

      expect(result.map((i) => i.externalId)).toEqual(["i-downgraded"]);
    });

    it("still drops the same incident when it was never reported", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(mockJsonResponse(downgraded))
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter({ ...baseConfig, minImpact: "major" });

      const result = await adapter.fetchIncidents({ trackedOpenIds: new Set() });

      expect(result).toHaveLength(0);
    });

    it("delivers the resolution of a tracked incident", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(
          mockJsonResponse({
            incidents: [{ ...downgraded.incidents[0], status: "resolved" }],
          }),
        )
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }));
      const adapter = new AtlassianStatuspageAdapter({ ...baseConfig, minImpact: "major" });

      const result = await adapter.fetchIncidents({
        trackedOpenIds: new Set(["i-downgraded"]),
      });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("resolved");
    });

    it("keeps a tracked incident that no longer matches componentFilter", async () => {
      mockedHttpGet
        .mockResolvedValueOnce(
          mockJsonResponse({
            incidents: [
              {
                id: "i-renamed",
                name: "Outage",
                status: "resolved",
                impact: "critical",
                created_at: "2026-08-01T10:00:00Z",
                updated_at: "2026-08-01T12:00:00Z",
                components: [{ id: "c1", name: "Renamed Component" }],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(mockJsonResponse({ incidents: [] }))
        .mockResolvedValueOnce(mockJsonResponse({ components: [] }));
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["Old Component"],
      });

      const result = await adapter.fetchIncidents({
        trackedOpenIds: new Set(["i-renamed"]),
      });

      expect(result.map((i) => i.externalId)).toEqual(["i-renamed"]);
    });

    it("applies minImpact on top of componentFilter, not instead of it", async () => {
      mockEndpoints(
        {
          incidents: [
            {
              id: "i-a",
              name: "IT Glue major",
              status: "investigating",
              impact: "major",
              created_at: "2026-08-01T10:00:00Z",
              updated_at: "2026-08-01T10:00:00Z",
              components: [{ id: "comp-4", name: "IT Glue" }],
            },
            {
              id: "i-b",
              name: "IT Glue minor",
              status: "investigating",
              impact: "minor",
              created_at: "2026-08-01T10:00:00Z",
              updated_at: "2026-08-01T10:00:00Z",
              components: [{ id: "comp-4", name: "IT Glue" }],
            },
            {
              id: "i-c",
              name: "Other major",
              status: "investigating",
              impact: "major",
              created_at: "2026-08-01T10:00:00Z",
              updated_at: "2026-08-01T10:00:00Z",
              components: [{ id: "comp-1", name: "API" }],
            },
          ],
        },
        { incidents: [] },
      );
      const adapter = new AtlassianStatuspageAdapter({
        ...baseConfig,
        componentFilter: ["IT Glue"],
        minImpact: "major",
      });

      const result = await adapter.fetchIncidents();
      expect(result.map((i) => i.externalId)).toEqual(["i-a"]);
      // Filtering everything out by severity is not config drift.
      expect(adapter.lastConfigDrift).toBe(false);
    });
  });

  it("filtert nach einzelnem componentFilter", async () => {
    mockEndpoints(unresolvedFixture, { incidents: [] });

    const config: ProviderConfig = {
      ...baseConfig,
      componentFilter: ["IT Glue"],
    };
    const adapter = new AtlassianStatuspageAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].title).toBe("Stoerung im IT Glue Modul");
  });

  it("filtert nach componentFilter-Liste (OR-Logik)", async () => {
    mockEndpoints({ incidents: [] }, recentFixture);

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
    mockEndpoints(unresolvedFixture, { incidents: [] });

    const config: ProviderConfig = {
      ...baseConfig,
      componentFilter: ["it glue"], // Kleinbuchstaben
    };
    const adapter = new AtlassianStatuspageAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].title).toBe("Stoerung im IT Glue Modul");
  });
});

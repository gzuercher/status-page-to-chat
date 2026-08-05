import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BetterStackFeedAdapter } from "../../src/adapters/betterstackFeed.js";
import type { ProviderConfig } from "../../src/lib/config.js";

vi.mock("../../src/lib/httpClient.js", () => ({ httpGet: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

const fixture = readFileSync(join(__dirname, "../fixtures/betterstack-feed.xml"), "utf-8");
const guidFixture = readFileSync(join(__dirname, "../fixtures/betterstack-feed-guid.xml"), "utf-8");

const config: ProviderConfig = {
  key: "langdock",
  displayName: "Langdock",
  adapter: "betterstack-feed",
  baseUrl: "https://status.example.com",
};

function mockFeed() {
  mockedHttpGet.mockResolvedValueOnce({
    status: 200,
    contentType: "application/rss+xml",
    body: fixture,
  });
}

describe("BetterStackFeedAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers().setSystemTime(new Date("2026-05-16T13:00:00Z"));
  });

  describe("guid-based feeds (current BetterStack generation)", () => {
    function mockGuidFeed() {
      mockedHttpGet.mockResolvedValueOnce({
        status: 200,
        contentType: "application/atom+xml",
        body: guidFixture,
      });
    }

    it("derives the incident id from the guid fragment when link has no /incident/ path", async () => {
      // Regression: BetterStack dropped the per-incident <link>. Reading the
      // id only from <link> made extractIncidentId return null for every
      // item, so the adapter silently reported zero incidents forever.
      vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
      mockGuidFeed();
      const incidents = await new BetterStackFeedAdapter(config).fetchIncidents();

      expect(incidents).toHaveLength(2);
      expect(incidents.map((i) => i.externalId).sort()).toEqual(["aaa111", "bbb222"]);
    });

    it('treats "recovered" as resolved so monitor-driven incidents close', async () => {
      // Regression: RESOLVED_KEYWORDS lacked "recovered", which is exactly
      // how BetterStack words its automatic recovery updates. Every such
      // incident stayed "open" — a channel flood waiting to happen.
      vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
      mockGuidFeed();
      const incidents = await new BetterStackFeedAdapter(config).fetchIncidents();

      const recovered = incidents.find((i) => i.externalId === "aaa111");
      const stillDown = incidents.find((i) => i.externalId === "bbb222");
      expect(recovered?.status).toBe("resolved");
      expect(stillDown?.status).toBe("open");
    });

    it("reports the pre-age-cap incident count for health tracking", async () => {
      vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
      mockGuidFeed();
      const adapter = new BetterStackFeedAdapter(config);
      await adapter.fetchIncidents();
      expect(adapter.lastUpstreamCount).toBe(2);
    });
  });

  it("deduplicates updates by incident link and classifies resolved", async () => {
    mockFeed();
    const incidents = await new BetterStackFeedAdapter(config).fetchIncidents();
    // Incident 100 (2 updates → 1) resolved, 200 open, 1 dropped as too old.
    expect(incidents).toHaveLength(2);
    const i100 = incidents.find((i) => i.externalId === "100");
    const i200 = incidents.find((i) => i.externalId === "200");
    expect(i100?.status).toBe("resolved");
    expect(i100?.title).toBe("File uploads resolved");
    expect(i100?.startedAt).toBe("2026-05-16T11:00:00.000Z");
    expect(i100?.updatedAt).toBe("2026-05-16T12:00:00.000Z");
    expect(i200?.status).toBe("open");
  });

  it("drops incidents whose newest update is older than the 7-day cap", async () => {
    mockFeed();
    const incidents = await new BetterStackFeedAdapter(config).fetchIncidents();
    expect(incidents.find((i) => i.externalId === "1")).toBeUndefined();
  });

  it("sets logoUrl derived from baseUrl host", async () => {
    mockFeed();
    const incidents = await new BetterStackFeedAdapter(config).fetchIncidents();
    expect(incidents[0].logoUrl).toContain("status.example.com");
  });

  it("throws on non-200 response", async () => {
    mockedHttpGet.mockResolvedValueOnce({ status: 503, contentType: "", body: "" });
    await expect(new BetterStackFeedAdapter(config).fetchIncidents()).rejects.toThrow(/HTTP 503/);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HundAtomAdapter } from "../../src/adapters/hundAtom.js";
import type { ProviderConfig } from "../../src/lib/config.js";

vi.mock("../../src/lib/httpClient.js", () => ({ httpGet: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

const fixture = readFileSync(join(__dirname, "../fixtures/hund-feed.xml"), "utf-8");

const config: ProviderConfig = {
  key: "bitwarden",
  displayName: "Bitwarden",
  adapter: "hund-atom",
  baseUrl: "https://status.example.com",
};

function mockFeed() {
  mockedHttpGet.mockResolvedValueOnce({
    status: 200,
    contentType: "application/atom+xml",
    body: fixture,
  });
}

describe("HundAtomAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies bracket-prefix states correctly", async () => {
    mockFeed();
    const incidents = await new HundAtomAdapter(config).fetchIncidents();
    expect(incidents).toHaveLength(5);

    const byId = Object.fromEntries(incidents.map((i) => [i.externalId, i]));
    expect(byId["aaa111"].status).toBe("resolved"); // [Ended]
    expect(byId["bbb222"].status).toBe("open"); // [Investigating]
    expect(byId["ccc333"].status).toBe("resolved"); // [Gelöst]
    expect(byId["ddd444"].status).toBe("resolved"); // [Beendet]
    expect(byId["eee555"].status).toBe("open"); // [Information] — no resolved keyword
  });

  it("extracts external ID from the trailing tag URI segment", async () => {
    mockFeed();
    const incidents = await new HundAtomAdapter(config).fetchIncidents();
    expect(incidents.map((i) => i.externalId).sort()).toEqual([
      "aaa111",
      "bbb222",
      "ccc333",
      "ddd444",
      "eee555",
    ]);
  });

  it("sets URL from atom link href and logoUrl from baseUrl host", async () => {
    mockFeed();
    const incidents = await new HundAtomAdapter(config).fetchIncidents();
    expect(incidents[0].url).toBe("https://status.example.com/issues/aaa111");
    expect(incidents[0].logoUrl).toContain("status.example.com");
  });

  it("throws on non-200 response", async () => {
    mockedHttpGet.mockResolvedValueOnce({ status: 500, contentType: "", body: "" });
    await expect(new HundAtomAdapter(config).fetchIncidents()).rejects.toThrow(/HTTP 500/);
  });
});

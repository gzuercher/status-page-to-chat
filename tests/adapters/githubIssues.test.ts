import { describe, it, expect, vi, beforeEach } from "vitest";
import { GithubIssuesAdapter } from "../../src/adapters/githubIssues.js";
import type { ProviderConfig } from "../../src/lib/config.js";
import fixture from "../fixtures/github-issues.json";

vi.mock("../../src/lib/httpClient.js", () => ({ httpGet: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

const config: ProviderConfig = {
  key: "onetimesecret",
  displayName: "Onetime Secret",
  adapter: "github-issues",
  owner: "onetimesecret",
  repo: "status",
};

describe("GithubIssuesAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filtert Pull Requests heraus", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });

    const adapter = new GithubIssuesAdapter(config);
    const incidents = await adapter.fetchIncidents();

    // 3 Items, davon 1 PR → 2 Issues
    expect(incidents).toHaveLength(2);
    expect(incidents.every((i) => !i.externalId.includes("13"))).toBe(true);
  });

  it("mappt offene und geschlossene Issues korrekt", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });

    const adapter = new GithubIssuesAdapter(config);
    const incidents = await adapter.fetchIncidents();

    const open = incidents.filter((i) => i.status === "open");
    const resolved = incidents.filter((i) => i.status === "resolved");

    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(1);
  });

  it("setzt html_url als url", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });

    const adapter = new GithubIssuesAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents[0].url).toContain("github.com/onetimesecret/status/issues");
  });

  it("wirft Fehler bei Rate Limit", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 403,
      contentType: "application/json",
      body: '{"message":"API rate limit exceeded"}',
    });

    const adapter = new GithubIssuesAdapter(config);
    await expect(adapter.fetchIncidents()).rejects.toThrow("HTTP 403");
  });
});

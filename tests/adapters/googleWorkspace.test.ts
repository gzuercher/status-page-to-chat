import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleWorkspaceAdapter } from "../../src/adapters/googleWorkspace.js";
import type { ProviderConfig } from "../../src/lib/config.js";
import fixture from "../fixtures/google-workspace.json";

vi.mock("../../src/lib/httpClient.js", () => ({ httpGet: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

const config: ProviderConfig = {
  key: "google-workspace",
  displayName: "Google Workspace",
  adapter: "google-workspace",
};

describe("GoogleWorkspaceAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("erkennt offene und resolved Incidents", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });

    const adapter = new GoogleWorkspaceAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(2);

    const open = incidents.filter((i) => i.status === "open");
    const resolved = incidents.filter((i) => i.status === "resolved");

    expect(open).toHaveLength(1);
    expect(open[0].title).toBe("Gmail: Zustellverzoegerungen");

    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toBe("Google Drive: Dateizugriff eingeschraenkt");
  });

  it("setzt providerKey und displayName korrekt", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });

    const adapter = new GoogleWorkspaceAdapter(config);
    const incidents = await adapter.fetchIncidents();

    for (const inc of incidents) {
      expect(inc.providerKey).toBe("google-workspace");
      expect(inc.displayName).toBe("Google Workspace");
    }
  });

  it("wirft Fehler bei HTTP-Fehler", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 500,
      contentType: "text/html",
      body: "Error",
    });

    const adapter = new GoogleWorkspaceAdapter(config);
    await expect(adapter.fetchIncidents()).rejects.toThrow("HTTP 500");
  });
});

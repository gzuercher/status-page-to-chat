import { describe, it, expect, vi, beforeEach } from "vitest";
import { WedosStatusOnlineAdapter } from "../../src/adapters/wedosStatusOnline.js";
import type { ProviderConfig } from "../../src/lib/config.js";
import fixture from "../fixtures/wedos-incidents.json";

vi.mock("../../src/lib/httpClient.js", () => ({ httpGet: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpGet } from "../../src/lib/httpClient.js";

const mockedHttpGet = vi.mocked(httpGet);

const config: ProviderConfig = {
  key: "wedos",
  displayName: "WEDOS",
  adapter: "wedos-status-online",
  baseUrl: "https://wedos.status.online",
};

describe("WedosStatusOnlineAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("erkennt offene und resolved Incidents", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });

    const adapter = new WedosStatusOnlineAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents).toHaveLength(2);

    const open = incidents.filter((i) => i.status === "open");
    const resolved = incidents.filter((i) => i.status === "resolved");

    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(1);
  });

  it("setzt URL korrekt", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });

    const adapter = new WedosStatusOnlineAdapter(config);
    const incidents = await adapter.fetchIncidents();

    expect(incidents[0].url).toBe("https://wedos.status.online/en/incident/501");
  });

  it("wirft Fehler bei nicht-JSON Content-Type", async () => {
    mockedHttpGet.mockResolvedValueOnce({
      status: 200,
      contentType: "text/html",
      body: "<html></html>",
    });

    const adapter = new WedosStatusOnlineAdapter(config);
    await expect(adapter.fetchIncidents()).rejects.toThrow("Unerwarteter Content-Type");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startApiServer, type LastRunRef } from "../../src/api/server.js";
import { createStore, closeStore, type Store } from "../../src/state/store.js";

const YAML = `chatTarget: teamsJson
providers:
  - key: only
    displayName: Only
    adapter: atlassian-statuspage
    baseUrl: https://example.com
`;

let dir: string;
let server: Server;
let store: Store;
let lastRun: LastRunRef;
let baseUrl: string;

async function bringUp(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "auth-modes-"));
  const configPath = join(dir, "providers.yaml");
  writeFileSync(configPath, YAML, "utf-8");
  process.env.CONFIG_PATH = configPath;

  store = createStore(join(dir, "state.sqlite"));
  lastRun = { current: null };
  server = startApiServer({ store, lastRun }, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function tearDown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CONFIG_PATH;
  delete process.env.API_TOKEN;
  delete process.env.API_AUTH_DISABLED;
}

describe("API auth modes", () => {
  describe("API_AUTH_DISABLED=true", () => {
    beforeEach(async () => {
      delete process.env.API_TOKEN;
      process.env.API_AUTH_DISABLED = "true";
      await bringUp();
    });
    afterEach(tearDown);

    it("allows protected endpoints without a token", async () => {
      const r = await fetch(`${baseUrl}/api/providers`);
      expect(r.status).toBe(200);
    });

    it("ignores any presented token (still 200)", async () => {
      const r = await fetch(`${baseUrl}/api/providers`, {
        headers: { Authorization: "Bearer anything" },
      });
      expect(r.status).toBe(200);
    });
  });

  describe("API_TOKEN unset and auth not explicitly disabled", () => {
    beforeEach(async () => {
      delete process.env.API_TOKEN;
      delete process.env.API_AUTH_DISABLED;
      await bringUp();
    });
    afterEach(tearDown);

    it("returns 401 (not 503) on protected endpoints, with generic body", async () => {
      const r = await fetch(`${baseUrl}/api/providers`);
      expect(r.status).toBe(401);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
    });

    it("still serves /api/health without auth", async () => {
      const r = await fetch(`${baseUrl}/api/health`);
      expect(r.status).toBe(200);
    });
  });

  describe("API_AUTH_DISABLED with non-canonical truthy values", () => {
    beforeEach(async () => {
      delete process.env.API_TOKEN;
      process.env.API_AUTH_DISABLED = "True"; // uppercase T — must NOT disable
      await bringUp();
    });
    afterEach(tearDown);

    it("does NOT bypass auth for 'True' (only literal 'true' opts out)", async () => {
      const r = await fetch(`${baseUrl}/api/providers`);
      expect(r.status).toBe(401);
    });
  });
});

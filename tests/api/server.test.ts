import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startApiServer, type LastRunRef } from "../../src/api/server.js";
import { createStore, closeStore, type Store } from "../../src/state/store.js";

const STARTER_YAML = `chatTarget: googleChat
providers:
  - key: bitbucket
    displayName: Bitbucket
    adapter: atlassian-statuspage
    baseUrl: https://bitbucket.status.atlassian.com

  - key: figma
    displayName: Figma
    adapter: atlassian-statuspage
    baseUrl: https://status.figma.com
`;

const TOKEN = "secret-token-for-tests";

let dir: string;
let configPath: string;
let store: Store;
let server: Server;
let baseUrl: string;
let lastRun: LastRunRef;

async function request(
  path: string,
  init?: { method?: string; body?: unknown; token?: string | null },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (init?.token !== null) {
    headers["Authorization"] = `Bearer ${init?.token ?? TOKEN}`;
  }
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(() => {
  process.env.API_TOKEN = TOKEN;
  delete process.env.API_AUTH_DISABLED;
});

afterAll(() => {
  delete process.env.API_TOKEN;
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "api-"));
  configPath = join(dir, "providers.yaml");
  writeFileSync(configPath, STARTER_YAML, "utf-8");
  process.env.CONFIG_PATH = configPath;

  store = createStore(join(dir, "state.sqlite"));
  lastRun = { current: null };
  server = startApiServer({ store, lastRun }, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CONFIG_PATH;
});

describe("API server", () => {
  it("serves /api/health without auth", async () => {
    const r = await request("/api/health", { token: null });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("ok");
  });

  it("serves /api/openapi.json without auth", async () => {
    const r = await request("/api/openapi.json", { token: null });
    expect(r.status).toBe(200);
    expect((r.body as { openapi: string }).openapi).toBe("3.1.0");
  });

  it("requires auth on protected endpoints", async () => {
    const r = await request("/api/providers", { token: null });
    expect(r.status).toBe(401);
  });

  it("rejects an invalid bearer token", async () => {
    const r = await request("/api/providers", { token: "wrong" });
    expect(r.status).toBe(401);
  });

  it("lists current providers", async () => {
    const r = await request("/api/providers");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect((r.body as Array<{ key: string }>).map((p) => p.key).sort()).toEqual([
      "bitbucket",
      "figma",
    ]);
  });

  it("returns a single provider by key", async () => {
    const r = await request("/api/providers/bitbucket");
    expect(r.status).toBe(200);
    expect((r.body as { displayName: string }).displayName).toBe("Bitbucket");
  });

  it("returns 404 for unknown provider key", async () => {
    const r = await request("/api/providers/missing");
    expect(r.status).toBe(404);
  });

  it("creates a provider with PUT (201)", async () => {
    const r = await request("/api/providers/webflow", {
      method: "PUT",
      body: {
        key: "webflow",
        displayName: "Webflow",
        adapter: "atlassian-statuspage",
        baseUrl: "https://status.webflow.com",
      },
    });
    expect(r.status).toBe(201);
    expect(readFileSync(configPath, "utf-8")).toContain("key: webflow");
  });

  it("updates an existing provider with PUT (200)", async () => {
    const r = await request("/api/providers/figma", {
      method: "PUT",
      body: {
        key: "figma",
        displayName: "Figma Updated",
        adapter: "atlassian-statuspage",
        baseUrl: "https://status.figma.com",
      },
    });
    expect(r.status).toBe(200);
    expect(readFileSync(configPath, "utf-8")).toContain("displayName: Figma Updated");
  });

  it("rejects PUT where path key and body key disagree", async () => {
    const r = await request("/api/providers/figma", {
      method: "PUT",
      body: {
        key: "different",
        displayName: "Bad",
        adapter: "atlassian-statuspage",
        baseUrl: "https://example.com",
      },
    });
    expect(r.status).toBe(400);
  });

  it("validates payload without saving", async () => {
    const before = readFileSync(configPath, "utf-8");
    const r = await request("/api/providers/validate", {
      method: "POST",
      body: {
        key: "test",
        displayName: "Test",
        adapter: "atlassian-statuspage",
        baseUrl: "https://example.com",
      },
    });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("rejects an invalid payload with field errors", async () => {
    const r = await request("/api/providers/validate", {
      method: "POST",
      body: {
        key: "bad",
        displayName: "",
        adapter: "atlassian-statuspage",
      },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/invalid/i);
  });

  it("deletes a provider with DELETE (204)", async () => {
    const r = await request("/api/providers/figma", { method: "DELETE" });
    expect(r.status).toBe(204);
    expect(readFileSync(configPath, "utf-8")).not.toContain("key: figma");
  });

  it("returns 404 when deleting an unknown key", async () => {
    const r = await request("/api/providers/missing", { method: "DELETE" });
    expect(r.status).toBe(404);
  });

  it("returns 404 on /api/last-run before first poll", async () => {
    const r = await request("/api/last-run");
    expect(r.status).toBe(404);
  });

  it("returns the last-run summary once populated", async () => {
    lastRun.current = {
      providersTotal: 2,
      providersSucceeded: 2,
      providersFailed: 0,
      incidentsOpen: 0,
      incidentsResolved: 0,
      notificationsSent: 0,
      notificationsFailed: 0,
      durationMs: 1234,
      completedAt: new Date().toISOString(),
    };
    const r = await request("/api/last-run");
    expect(r.status).toBe(200);
    expect((r.body as { durationMs: number }).durationMs).toBe(1234);
  });

  it("returns empty open-incidents list initially", async () => {
    const r = await request("/api/incidents/open");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

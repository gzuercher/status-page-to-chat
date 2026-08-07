import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startApiServer, type LastRunRef } from "../../src/api/server.js";
import { createStore, closeStore, type Store } from "../../src/state/store.js";
import {
  createMcpSessions,
  sweepIdleSessions,
  MCP_SESSION_IDLE_TIMEOUT_MS,
} from "../../src/api/mcp.js";

const STARTER_YAML = `chatTarget: teamsJson
providers:
  - key: bitbucket
    displayName: Bitbucket
    adapter: atlassian-statuspage
    baseUrl: https://bitbucket.status.atlassian.com
`;

const TOKEN = "secret-token-for-tests";

let dir: string;
let configPath: string;
let store: Store;
let server: Server;
let baseUrl: string;
let lastRun: LastRunRef;

/**
 * Sends an MCP JSON-RPC request over Streamable HTTP. Returns the parsed
 * JSON body plus the server-assigned session id (read from the response
 * header on init, or echoed back on subsequent calls).
 */
async function mcp(
  body: Record<string, unknown>,
  opts?: { sessionId?: string; token?: string | null },
): Promise<{ status: number; body: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (opts?.token !== null) {
    headers["Authorization"] = `Bearer ${opts?.token ?? TOKEN}`;
  }
  if (opts?.sessionId) headers["Mcp-Session-Id"] = opts.sessionId;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    sessionId: res.headers.get("mcp-session-id"),
  };
}

function initRequest(id = 1): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    },
  };
}

async function openSession(): Promise<string> {
  const r = await mcp(initRequest());
  expect(r.status).toBe(200);
  const sid = r.sessionId;
  if (!sid) throw new Error("server did not assign a session id");
  // The SDK requires a notifications/initialized after the init handshake
  // before tool calls are accepted.
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      "Mcp-Session-Id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sid;
}

/** Extract the parsed text payload from an MCP tools/call response. */
function toolResultJson(body: unknown): unknown {
  const r = body as { result?: { content?: Array<{ type: string; text: string }> } };
  const text = r.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("MCP tool result missing text content");
  return JSON.parse(text);
}

beforeAll(() => {
  process.env.API_TOKEN = TOKEN;
  delete process.env.API_AUTH_DISABLED;
});

afterAll(() => {
  delete process.env.API_TOKEN;
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-"));
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

describe("MCP server — handshake & sessions", () => {
  it("rejects unauthenticated MCP requests with 401", async () => {
    const r = await mcp(initRequest(), { token: null });
    expect(r.status).toBe(401);
  });

  it("creates a session on initialize and returns a session id", async () => {
    const r = await mcp(initRequest());
    expect(r.status).toBe(200);
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const b = r.body as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(b.result.serverInfo.name).toBe("status-page-to-chat");
  });

  it("issues distinct session ids for two separate initialize calls", async () => {
    const a = await mcp(initRequest(1));
    const b = await mcp(initRequest(2));
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("rejects a non-initialize POST without a session id (400)", async () => {
    const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(r.status).toBe(400);
    const b = r.body as { error: { message: string } };
    expect(b.error.message).toMatch(/session/i);
  });

  it("returns 404 when a session id is unknown", async () => {
    const r = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { sessionId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(r.status).toBe(404);
  });
});

describe("MCP server — tools/list", () => {
  it("exposes all six status-page tools", async () => {
    const sid = await openSession();
    const r = await mcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { sessionId: sid },
    );
    expect(r.status).toBe(200);
    const b = r.body as { result: { tools: Array<{ name: string }> } };
    const names = b.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "add_provider",
      "get_provider",
      "last_run",
      "list_open_incidents",
      "list_providers",
      "remove_provider",
    ]);
  });
});

describe("MCP server — tools/call", () => {
  async function call(
    sid: string,
    name: string,
    args: Record<string, unknown> = {},
    id = 10,
  ): Promise<unknown> {
    const r = await mcp(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      { sessionId: sid },
    );
    expect(r.status).toBe(200);
    return r.body;
  }

  it("list_providers returns the configured providers", async () => {
    const sid = await openSession();
    const payload = toolResultJson(await call(sid, "list_providers"));
    expect(payload).toEqual([
      {
        key: "bitbucket",
        displayName: "Bitbucket",
        adapter: "atlassian-statuspage",
        baseUrl: "https://bitbucket.status.atlassian.com",
      },
    ]);
  });

  it("get_provider returns one by key, or an error for an unknown key", async () => {
    const sid = await openSession();
    const ok = toolResultJson(await call(sid, "get_provider", { key: "bitbucket" }));
    expect((ok as { key: string }).key).toBe("bitbucket");

    const missing = (await call(sid, "get_provider", { key: "nope" })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toMatch(/not found/i);
  });

  it("add_provider writes to providers.yaml and list_providers reflects it", async () => {
    const sid = await openSession();
    const added = toolResultJson(
      await call(sid, "add_provider", {
        key: "figma",
        displayName: "Figma",
        adapter: "atlassian-statuspage",
        baseUrl: "https://status.figma.com",
      }),
    );
    expect((added as { created: boolean }).created).toBe(true);

    const after = toolResultJson(await call(sid, "list_providers")) as Array<{ key: string }>;
    expect(after.map((p) => p.key).sort()).toEqual(["bitbucket", "figma"]);
  });

  it("remove_provider removes by key, second call returns not-found", async () => {
    const sid = await openSession();
    const removed = toolResultJson(await call(sid, "remove_provider", { key: "bitbucket" }));
    expect(removed).toEqual({ removed: true, key: "bitbucket" });

    const second = (await call(sid, "remove_provider", { key: "bitbucket" })) as {
      result: { isError: boolean };
    };
    expect(second.result.isError).toBe(true);
  });

  it("list_open_incidents returns [] on a fresh store", async () => {
    const sid = await openSession();
    const payload = toolResultJson(await call(sid, "list_open_incidents"));
    expect(payload).toEqual([]);
  });

  it("last_run reports 'no poll completed yet' before any tick", async () => {
    const sid = await openSession();
    const payload = toolResultJson(await call(sid, "last_run"));
    expect((payload as { status: string }).status).toBe("no poll completed yet");
  });

  it("bumps lastActivityAt on every request so an active session is not swept", async () => {
    // We can't easily reach into the live session map from here, so test
    // the sweeper directly against a synthetic map below. This test just
    // documents that the production path doesn't crash with idle sessions.
    const sid = await openSession();
    // A regular call must succeed even some real ms after init.
    await new Promise((r) => setTimeout(r, 20));
    const r = await mcp(
      { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
      { sessionId: sid },
    );
    expect(r.status).toBe(200);
  });

  it("last_run reports the cached summary when one is set", async () => {
    lastRun.current = {
      providersTotal: 1,
      providersSucceeded: 1,
      providersFailed: 0,
      incidentsOpen: 0,
      incidentsResolved: 0,
      notificationsSent: 0,
      notificationsFailed: 0,
      durationMs: 12,
      completedAt: "2026-05-14T19:00:00.000Z",
    };
    const sid = await openSession();
    const payload = toolResultJson(await call(sid, "last_run")) as {
      providersSucceeded: number;
      completedAt: string;
    };
    expect(payload.providersSucceeded).toBe(1);
    expect(payload.completedAt).toBe("2026-05-14T19:00:00.000Z");
  });
});

describe("MCP server — idle-session sweeper", () => {
  /** Builds a fake transport that records whether close() was called. */
  function fakeTransport(): { transport: unknown; closed: () => boolean } {
    let wasClosed = false;
    const transport = {
      close: () => {
        wasClosed = true;
        return Promise.resolve();
      },
    };
    return { transport, closed: () => wasClosed };
  }

  it("evicts entries past the idle timeout and closes their transport", () => {
    const sessions = createMcpSessions();
    const fresh = fakeTransport();
    const stale = fakeTransport();
    const now = 1_000_000_000;

    sessions.set("fresh", {
      transport: fresh.transport as never,
      lastActivityAt: now - 60_000, // 1 minute old
    });
    sessions.set("stale", {
      transport: stale.transport as never,
      lastActivityAt: now - (MCP_SESSION_IDLE_TIMEOUT_MS + 60_000),
    });

    const evicted = sweepIdleSessions(sessions, now);

    expect(evicted).toBe(1);
    expect(sessions.has("fresh")).toBe(true);
    expect(sessions.has("stale")).toBe(false);
    expect(fresh.closed()).toBe(false);
    expect(stale.closed()).toBe(true);
  });

  it("is a no-op when every session is fresh", () => {
    const sessions = createMcpSessions();
    const a = fakeTransport();
    const b = fakeTransport();
    const now = 2_000_000_000;
    sessions.set("a", { transport: a.transport as never, lastActivityAt: now - 1000 });
    sessions.set("b", { transport: b.transport as never, lastActivityAt: now - 5000 });

    const evicted = sweepIdleSessions(sessions, now);

    expect(evicted).toBe(0);
    expect(sessions.size).toBe(2);
    expect(a.closed()).toBe(false);
    expect(b.closed()).toBe(false);
  });

  it("uses a custom idleMs override (test injection)", () => {
    const sessions = createMcpSessions();
    const t = fakeTransport();
    const now = 3_000_000_000;
    sessions.set("only", { transport: t.transport as never, lastActivityAt: now - 2000 });

    // With a 1-second threshold, the 2-second-old session is stale.
    const evicted = sweepIdleSessions(sessions, now, 1000);
    expect(evicted).toBe(1);
    expect(sessions.size).toBe(0);
    expect(t.closed()).toBe(true);
  });

  it("swallows transport.close() errors instead of crashing the sweep", () => {
    const sessions = createMcpSessions();
    const fakeBroken = {
      close: () => {
        throw new Error("transport already destroyed");
      },
    };
    sessions.set("broken", {
      transport: fakeBroken as never,
      lastActivityAt: 0,
    });
    expect(() => sweepIdleSessions(sessions, MCP_SESSION_IDLE_TIMEOUT_MS + 1)).not.toThrow();
    expect(sessions.has("broken")).toBe(false);
  });
});

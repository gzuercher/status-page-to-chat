import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { parseConfig, providerSchema, type ProviderConfig } from "../lib/config.js";
import { upsertProviderInYaml, removeProviderFromYaml } from "../lib/configWriter.js";
import { logger } from "../lib/logger.js";
import type { RunSummary, StoredIncident } from "../lib/types.js";
import { getAllStoredIncidents, type Store } from "../state/store.js";
import { z } from "zod";
import { createMcpSessions, handleMcpRequest, type McpSessions } from "./mcp.js";

// CJS build (no "type": "module"). __dirname is available as a CJS global,
// which after tsc compile points at dist/src/api at runtime.
const OPENAPI_PATH = resolve(__dirname, "openapi.json");

/** Subset of StoredIncident exposed to the API (drops the notified-* flags). */
type IncidentDto = {
  providerKey: string;
  externalId: string;
  title: string;
  status: "open" | "resolved";
  url: string;
  startedAt: string;
  updatedAt: string;
};

function toIncidentDto(stored: StoredIncident): IncidentDto {
  return {
    providerKey: stored.providerKey,
    externalId: stored.externalId,
    title: stored.title,
    status: stored.status,
    url: stored.url,
    startedAt: stored.startedAt,
    updatedAt: stored.updatedAt,
  };
}

/** Last-run cache, populated by main() at the end of each poll cycle. */
export type LastRunRef = { current: (RunSummary & { completedAt: string }) | null };

export type ApiContext = {
  store: Store;
  lastRun: LastRunRef;
};

/** Re-export so existing call sites keep working. */
const providerPayloadSchema = providerSchema;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body).toString());
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string, details?: unknown): void {
  sendJson(res, status, { error: message, ...(details ? { details } : {}) });
}

function sendNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let total = 0;
    let aborted = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        rejectPromise(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      resolvePromise(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      rejectPromise(err);
    });
  });
}

async function parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendError(res, 413, (err as Error).message);
    return undefined;
  }
  if (!raw) {
    sendError(res, 400, "request body is empty");
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    sendError(res, 400, "request body is not valid JSON", { message: (err as Error).message });
    return undefined;
  }
}

/**
 * Constant-time string comparison via timingSafeEqual. Avoids leaking the
 * configured token length or prefix through response timing on short tokens.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Bearer-token check. Required by default; bypassed only when the operator
 * explicitly sets API_AUTH_DISABLED=true (with a startup warning logged in
 * configureAuth()). Returns true when the request may proceed.
 *
 * Every failure mode returns the same 401 with a generic message — no
 * 503/401 oracle that would tell an attacker whether the service is open,
 * mis-configured, or simply rejecting their token.
 */
function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (process.env.API_AUTH_DISABLED === "true") return true;

  const token = process.env.API_TOKEN;
  const header = req.headers["authorization"];

  if (!token || !header || !header.startsWith("Bearer ")) {
    sendError(res, 401, "unauthorized");
    return false;
  }
  const presented = header.slice("Bearer ".length).trim();
  if (!tokensMatch(presented, token)) {
    sendError(res, 401, "unauthorized");
    return false;
  }
  return true;
}

/**
 * Logs the chosen auth posture once at server start. Centralising this
 * makes the "you forgot to set a token" case visible in container logs.
 */
function configureAuth(): void {
  if (process.env.API_AUTH_DISABLED === "true") {
    logger.warn({}, "API auth explicitly disabled — endpoints are open");
    return;
  }
  if (!process.env.API_TOKEN) {
    logger.warn(
      {},
      "API_TOKEN not set and API_AUTH_DISABLED not true — API will reject all requests",
    );
    return;
  }
  logger.info({}, "API auth enabled (bearer token)");
}

let cachedOpenapi: string | undefined;
function getOpenapiDocument(): string {
  if (!cachedOpenapi) {
    cachedOpenapi = readFileSync(OPENAPI_PATH, "utf-8");
  }
  return cachedOpenapi;
}

type Provider = ProviderConfig;

function listProviders(): Provider[] {
  const result = parseConfig();
  if (!result.ok) {
    throw new Error(`config unavailable: ${result.error.message}`);
  }
  return result.config.providers;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function formatZodError(err: z.ZodError): any {
  return err.flatten();
}

async function handlePutProvider(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  const body = await parseJsonBody<Provider>(req, res);
  if (!body) return;

  if (body.key && body.key !== key) {
    sendError(res, 400, "key in path must match key in body");
    return;
  }
  const merged: Provider = { ...body, key };

  const parsed = providerPayloadSchema.safeParse(merged);
  if (!parsed.success) {
    sendError(res, 400, "invalid provider payload", formatZodError(parsed.error));
    return;
  }

  try {
    const { created } = upsertProviderInYaml(parsed.data);
    sendJson(res, created ? 201 : 200, parsed.data);
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
}

async function handleValidateProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<unknown>(req, res);
  if (body === undefined) return;
  const parsed = providerPayloadSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid provider payload", formatZodError(parsed.error));
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * Tiny manual router. Keeping it explicit avoids pulling in a web
 * framework for ~9 endpoints.
 */
async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  mcpSessions: McpSessions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Public endpoints
  if (method === "GET" && path === "/api/openapi.json") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(getOpenapiDocument());
    return;
  }
  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      lastRunAt: ctx.lastRun.current?.completedAt ?? null,
    });
    return;
  }

  if (!checkAuth(req, res)) return;

  // MCP endpoint — same bearer-token gate as REST. POST init creates a
  // new session; subsequent POST/GET/DELETE require the Mcp-Session-Id
  // header. Per-session transports live in mcpSessions.
  if (path === "/mcp") {
    await handleMcpRequest(req, res, ctx, mcpSessions);
    return;
  }

  if (method === "GET" && path === "/api/providers") {
    sendJson(res, 200, listProviders());
    return;
  }
  if (method === "POST" && path === "/api/providers/validate") {
    await handleValidateProvider(req, res);
    return;
  }

  const providerMatch = path.match(/^\/api\/providers\/([a-z0-9-]+)$/);
  if (providerMatch) {
    const key = providerMatch[1];
    if (method === "GET") {
      const found = listProviders().find((p) => p.key === key);
      if (!found) {
        sendError(res, 404, `provider not found: ${key}`);
        return;
      }
      sendJson(res, 200, found);
      return;
    }
    if (method === "PUT") {
      await handlePutProvider(req, res, key);
      return;
    }
    if (method === "DELETE") {
      try {
        const removed = removeProviderFromYaml(key);
        if (!removed) {
          sendError(res, 404, `provider not found: ${key}`);
          return;
        }
        sendNoContent(res);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }
  }

  if (method === "GET" && path === "/api/incidents/open") {
    const all = getAllStoredIncidents(ctx.store);
    sendJson(res, 200, all.filter((i) => i.status === "open").map(toIncidentDto));
    return;
  }
  if (method === "GET" && path === "/api/last-run") {
    if (!ctx.lastRun.current) {
      sendError(res, 404, "no poll has completed yet");
      return;
    }
    sendJson(res, 200, ctx.lastRun.current);
    return;
  }

  sendError(res, 404, `no route for ${method} ${path}`);
}

/**
 * Starts the HTTP server. Returns the underlying Node server so the
 * entrypoint can close it cleanly on SIGTERM.
 */
export function startApiServer(ctx: ApiContext, port = 8080): Server {
  configureAuth();
  const mcpSessions = createMcpSessions();
  const server = createServer((req, res) => {
    route(req, res, ctx, mcpSessions).catch((err: unknown) => {
      logger.error({ err, url: req.url }, "Unhandled error in API route");
      if (!res.headersSent) {
        sendError(res, 500, "internal error");
      } else {
        res.end();
      }
    });
  });
  server.listen(port, () => {
    logger.info({ port }, "API server listening (REST under /api/, MCP under /mcp)");
  });
  return server;
}

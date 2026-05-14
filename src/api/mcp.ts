import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseConfig, providerSchema, type ProviderConfig } from "../lib/config.js";
import { upsertProviderInYaml, removeProviderFromYaml } from "../lib/configWriter.js";
import { getAllStoredIncidents, type Store } from "../state/store.js";
import { logger } from "../lib/logger.js";
import type { LastRunRef } from "./server.js";

/**
 * Per-session McpServer registry. The MCP SDK requires one transport per
 * session — a single shared transport rejects every init after the first
 * one with "Server already initialized". We map session-id → transport
 * here, create new entries on init, and remove them when a client
 * disconnects.
 */
export type McpContext = { store: Store; lastRun: LastRunRef };
export type McpSessions = Map<string, StreamableHTTPServerTransport>;

/**
 * Registers all status-page-to-chat tools on a fresh McpServer instance.
 * Called once per session — the server stays bound to that session's
 * transport for the session's lifetime.
 */
function registerTools(server: McpServer, ctx: McpContext): void {
  /** Helper: serialise a JS value as the JSON-text content block expected by MCP. */
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });

  const error = (message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: message }],
  });

  server.registerTool(
    "list_providers",
    { description: "List all status pages currently being monitored." },
    async () => {
      const r = parseConfig();
      if (!r.ok) return error(r.error.message);
      return json(r.config.providers);
    },
  );

  server.registerTool(
    "get_provider",
    {
      description: "Fetch a single monitored provider by its key.",
      inputSchema: { key: z.string().describe("The provider's unique key.") },
    },
    async ({ key }) => {
      const r = parseConfig();
      if (!r.ok) return error(r.error.message);
      const found = r.config.providers.find((p) => p.key === key);
      if (!found) return error(`Provider not found: ${key}`);
      return json(found);
    },
  );

  server.registerTool(
    "add_provider",
    {
      description:
        "Add a new monitored status page, or update an existing one with the same key. " +
        "Adapter must be one of 'atlassian-statuspage', 'google-workspace', 'metanet-rss', " +
        "'wedos-status-online', or 'github-issues'. baseUrl is required for " +
        "'atlassian-statuspage' and 'wedos-status-online'. owner + repo are required for " +
        "'github-issues'. componentFilter is an optional substring or list of substrings " +
        "to narrow Atlassian Statuspage notifications to specific components.",
      inputSchema: {
        key: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .describe("Unique identifier, lowercase ASCII letters, digits and hyphens only."),
        displayName: z.string().min(1).describe("Human-readable name shown in chat messages."),
        adapter: z.enum([
          "atlassian-statuspage",
          "google-workspace",
          "metanet-rss",
          "wedos-status-online",
          "github-issues",
        ]),
        baseUrl: z.string().url().optional(),
        owner: z.string().optional(),
        repo: z.string().optional(),
        componentFilter: z.union([z.string(), z.array(z.string())]).optional(),
        userAgent: z.string().optional(),
      },
    },
    async (input) => {
      const parsed = providerSchema.safeParse(input);
      if (!parsed.success) return error(JSON.stringify(parsed.error.flatten()));
      try {
        const { created } = upsertProviderInYaml(parsed.data as ProviderConfig);
        return json({ created, provider: parsed.data });
      } catch (err) {
        return error((err as Error).message);
      }
    },
  );

  server.registerTool(
    "remove_provider",
    {
      description: "Stop monitoring a status page by its key.",
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      try {
        const removed = removeProviderFromYaml(key);
        if (!removed) return error(`Provider not found: ${key}`);
        return json({ removed: true, key });
      } catch (err) {
        return error((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_open_incidents",
    { description: "Show currently open incidents across all monitored providers." },
    async () => {
      const all = getAllStoredIncidents(ctx.store);
      const open = all
        .filter((i) => i.status === "open")
        .map((i) => ({
          providerKey: i.providerKey,
          externalId: i.externalId,
          title: i.title,
          url: i.url,
          startedAt: i.startedAt,
          updatedAt: i.updatedAt,
        }));
      return json(open);
    },
  );

  server.registerTool(
    "last_run",
    {
      description:
        "Show the summary of the most recent poll cycle: provider counts, incident counts, " +
        "notifications sent, duration, and completion time. Returns 'no poll yet' if the " +
        "container just started.",
    },
    async () => {
      if (!ctx.lastRun.current) return json({ status: "no poll completed yet" });
      return json(ctx.lastRun.current);
    },
  );
}

/** Creates the shared session map. Stored in the API context. */
export function createMcpSessions(): McpSessions {
  return new Map();
}

/**
 * Reads the JSON body from an incoming request. Used to detect whether
 * a POST is an MCP initialize request when no session id is present yet.
 */
async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let aborted = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    });
  });
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
  );
}

/**
 * Routes a single /mcp request to the right transport. Standard MCP
 * session pattern:
 *   - POST with `initialize` body + no session header → create a new
 *     transport + McpServer, register tools, generate session id, store
 *     in the sessions map, hand the request to the new transport.
 *   - POST/GET/DELETE with a session header → look up the transport in
 *     the map and delegate.
 *   - Anything else → 400.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McpContext,
  sessions: McpSessions,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"];
  const sessionIdStr = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  // GET (SSE listen) and DELETE (session terminate) — must have an
  // existing session.
  if (req.method === "GET" || req.method === "DELETE") {
    if (!sessionIdStr) {
      sendJsonError(res, 400, "Bad Request: Mcp-Session-Id header is required");
      return;
    }
    const transport = sessions.get(sessionIdStr);
    if (!transport) {
      sendJsonError(res, 404, "Session not found");
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    sendJsonError(res, 405, "Method Not Allowed");
    return;
  }

  // POST — read the body once so we can decide whether to create or
  // dispatch. The transport.handleRequest signature accepts a pre-parsed
  // body via the third argument.
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJsonError(res, 400, `Invalid request body: ${(err as Error).message}`);
    return;
  }

  // Existing session → dispatch.
  if (sessionIdStr) {
    const transport = sessions.get(sessionIdStr);
    if (!transport) {
      sendJsonError(res, 404, "Session not found");
      return;
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  // No session yet — only an initialize call may proceed.
  if (!isInitializeRequest(body)) {
    sendJsonError(res, 400, "Bad Request: No valid session ID. Send an `initialize` first.");
    return;
  }

  // Create a fresh server + transport for this session.
  const server = new McpServer({ name: "status-page-to-chat", version: "1.0.0" });
  registerTools(server, ctx);

  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      sessions.set(sid, transport);
      logger.info({ sessionId: sid, sessionCount: sessions.size }, "MCP session created");
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
      logger.info({ sessionId: sid, sessionCount: sessions.size }, "MCP session closed");
    },
  });

  transport.onerror = (err) => {
    logger.error({ err, sessionId: transport.sessionId }, "MCP transport.onerror");
  };
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

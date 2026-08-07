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

/**
 * Per-session entry. `lastActivityAt` is bumped on every request and
 * used by sweepIdleSessions() to evict sessions that the client never
 * cleanly closed — e.g. Langdock does not send DELETE on disconnect, so
 * without this the map grows unbounded.
 */
type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  lastActivityAt: number;
};
export type McpSessions = Map<string, SessionEntry>;

/** Idle timeout after which a session is force-closed. 30 minutes. */
export const MCP_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** How often the sweeper runs in production. */
const MCP_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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
      description: [
        "Add a new monitored status page, or update an existing one with the same key.",
        "",
        "HOW TO CHOOSE THE RIGHT ADAPTER — pick by what the source actually serves, not by",
        "what the URL looks like. Each adapter is wired to a specific data shape; using the",
        "wrong one silently fetches the wrong data.",
        "",
        "  atlassian-statuspage — Atlassian's hosted Statuspage product. Look for a page",
        "    that serves JSON at `<baseUrl>/api/v2/incidents.json` (always present on this",
        "    platform). The HTML page typically shows an 'All Systems Operational' banner",
        "    over a component list, and exposes RSS at `/history.rss`, atom at",
        "    `/history.atom`, JSON at `/api/v2/...`. Use the SITE ROOT as baseUrl — no path",
        "    suffix, no `.rss`, no `/api/...`. Examples of this platform: status.claude.com,",
        "    bitbucket.status.atlassian.com, status.figma.com, status.openai.com,",
        "    www.githubstatus.com, status.linear.app, status.notion.so, status.slack.com,",
        "    status.cloudflare.com. If unsure, this is the safest first guess for any",
        "    public 'status.*' page — quickly verify by fetching",
        "    `<baseUrl>/api/v2/summary.json` (200 + JSON → confirmed).",
        "",
        "  google-workspace — Hard-wired to the Google Workspace Status Dashboard",
        "    (status.cloud.google.com / appsstatus). NOT a generic Google adapter — only",
        "    use it for Google Workspace services (Gmail, Drive, Calendar, Meet, etc.).",
        "    baseUrl is ignored.",
        "",
        "  wedos-status-online — Vendor-specific for the WEDOS Internet status.online",
        "    platform (status.online.wedos.com and its sub-pages). The source serves",
        "    `<baseUrl>/en/json/incidents.json`. Only correct for WEDOS-hosted status pages.",
        "",
        "  github-issues — Treats a GitHub repository's Issues list as the incident feed.",
        "    Use when a project publishes incidents via GitHub Issues (sometimes a dedicated",
        "    `<project>/status` repo). Requires `owner` + `repo`, no baseUrl. Example:",
        "    owner='onetimesecret', repo='status'.",
        "",
        "  betterstack-feed — BetterStack-hosted status pages, which publish an RSS feed",
        "    at `<baseUrl>/feed.atom` (the name says Atom, the payload is RSS). Recognisable",
        "    by a 'Powered by Better Stack' footer.",
        "",
        "  hund-atom — Status pages on the Hund.io platform, which publish an Atom feed at",
        "    `<baseUrl>/feed.atom`. Used e.g. for Bitwarden.",
        "",
        "  zendesk-ssp — Zendesk's own status backend (status.zendesk.com), which serves",
        "    `<baseUrl>/api/ssp/incidents.json`. Only correct for Zendesk itself, not for",
        "    the Zendesk-hosted help centres of other vendors.",
        "",
        "  html-scrape — Last resort for pages with no JSON and no feed. Requires `selector`",
        "    (CSS selector for the element carrying the status) and `healthyMatch` (the text",
        "    or class meaning 'all good'); anything else becomes a synthetic open incident.",
        "    Optional `titleTemplate` with a {matchedText} placeholder.",
        "",
        "DECISION FLOW — when the user just gives a URL:",
        "  1. If the URL contains `github.com/<owner>/<repo>` and incidents live in Issues",
        "     → github-issues with that owner/repo.",
        "  2. If the host is status.cloud.google.com or the user says 'Google Workspace'",
        "     → google-workspace.",
        "  3. If the host is status.online.wedos.com or a sub-page of it",
        "     → wedos-status-online.",
        "  4. If the host is status.zendesk.com → zendesk-ssp.",
        "  5. If the page says 'Powered by Better Stack' → betterstack-feed; if it runs on",
        "     Hund.io → hund-atom. Both serve `<baseUrl>/feed.atom`, so fetching that and",
        "     looking at the payload settles it: RSS (<rss><channel>) → betterstack-feed,",
        "     Atom (<feed><entry>) → hund-atom.",
        "  6. Otherwise (any other public 'status.*' page, including ones with `.rss` or",
        "     `/history` suffixes) → atlassian-statuspage with the site root as baseUrl.",
        "     Only if that page serves no `/api/v2/summary.json` either, fall back to",
        "     html-scrape with an explicit selector and healthyMatch.",
        "     If you are not certain, STATE THE GUESS and the assumption to the user before",
        "     calling this tool, so they can correct it in one step rather than after a",
        "     wrong write.",
        "",
        "componentFilter optionally narrows a provider to specific components/services.",
        "Case-INsensitive substring match, OR logic. Pass a list of strings; a single",
        "comma-separated string is also accepted and split on commas. Supported by the",
        "atlassian-statuspage and zendesk-ssp adapters. A filter entry may also name a",
        "component GROUP, which matches all of its members.",
        "",
        "CAUTION: providers rename their components, and a filter that no longer matches",
        "makes the provider go permanently silent. Verify the names against",
        "<baseUrl>/api/v2/components.json before writing, and prefer no filter over a",
        "guessed one.",
        "",
        "minImpact optionally suppresses low-severity incidents: 'none' | 'minor' |",
        "'major' | 'critical'. 'major' drops minor and none, which removes roughly",
        "three quarters of the card volume on busy pages. atlassian-statuspage only.",
        "Omit it to inherit the deployment-wide default from providers.yaml.",
      ].join("\n"),
      inputSchema: {
        key: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .describe("Unique identifier, lowercase ASCII letters, digits and hyphens only."),
        displayName: z.string().min(1).describe("Human-readable name shown in chat messages."),
        adapter: z.enum([
          "atlassian-statuspage",
          "google-workspace",
          "wedos-status-online",
          "github-issues",
          "betterstack-feed",
          "hund-atom",
          "zendesk-ssp",
          "html-scrape",
        ]),
        description: z
          .string()
          .min(1)
          .max(280)
          .optional()
          .describe("One-line service blurb shown on the card, in the deployment's language."),
        baseUrl: z.string().url().optional(),
        owner: z.string().optional(),
        repo: z.string().optional(),
        selector: z.string().min(1).optional().describe("CSS selector, html-scrape only."),
        healthyMatch: z
          .string()
          .min(1)
          .optional()
          .describe('Pattern meaning "no incident", html-scrape only.'),
        titleTemplate: z
          .string()
          .min(1)
          .optional()
          .describe("Title override with a {matchedText} placeholder, html-scrape only."),
        logoUrl: z
          .string()
          .url()
          .optional()
          .describe("Overrides the favicon derived from the baseUrl host."),
        componentFilter: z.union([z.string(), z.array(z.string())]).optional(),
        minImpact: z.enum(["none", "minor", "major", "critical"]).optional(),
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
 * Closes every session whose lastActivityAt is older than `idleMs`.
 * Returns the number of evicted sessions (useful for tests and logging).
 *
 * Exposed as a pure function so tests can drive eviction with a forced
 * `now` instead of relying on real timers; production drives it from
 * the interval started by startMcpSessionSweeper().
 */
export function sweepIdleSessions(
  sessions: McpSessions,
  now: number = Date.now(),
  idleMs: number = MCP_SESSION_IDLE_TIMEOUT_MS,
): number {
  let evicted = 0;
  for (const [sid, entry] of sessions) {
    if (now - entry.lastActivityAt > idleMs) {
      try {
        void entry.transport.close();
      } catch (err) {
        logger.warn({ err, sessionId: sid }, "Error closing idle MCP transport");
      }
      sessions.delete(sid);
      evicted++;
    }
  }
  if (evicted > 0) {
    logger.info({ evicted, remaining: sessions.size }, "Swept idle MCP sessions");
  }
  return evicted;
}

/**
 * Starts the periodic idle-session sweeper. Returns a stop function the
 * server's shutdown handler can call to clear the interval on SIGTERM.
 */
export function startMcpSessionSweeper(
  sessions: McpSessions,
  intervalMs: number = MCP_SESSION_SWEEP_INTERVAL_MS,
): () => void {
  const handle = setInterval(() => {
    sweepIdleSessions(sessions);
  }, intervalMs);
  // Don't keep the event loop alive just for the sweeper — the API
  // server's listening socket is the intended liveness anchor.
  handle.unref();
  return () => clearInterval(handle);
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
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
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
    const entry = sessions.get(sessionIdStr);
    if (!entry) {
      sendJsonError(res, 404, "Session not found");
      return;
    }
    entry.lastActivityAt = Date.now();
    await entry.transport.handleRequest(req, res);
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
    const entry = sessions.get(sessionIdStr);
    if (!entry) {
      sendJsonError(res, 404, "Session not found");
      return;
    }
    entry.lastActivityAt = Date.now();
    await entry.transport.handleRequest(req, res, body);
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
      sessions.set(sid, { transport, lastActivityAt: Date.now() });
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

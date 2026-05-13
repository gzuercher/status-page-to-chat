import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseConfig, providerSchema, type ProviderConfig } from "../lib/config.js";
import { upsertProviderInYaml, removeProviderFromYaml } from "../lib/configWriter.js";
import { getAllStoredIncidents, type Store } from "../state/store.js";
import { logger } from "../lib/logger.js";
import type { LastRunRef } from "./server.js";

/**
 * Builds the MCP server and registers tools that mirror the REST API.
 * Returns the server plus a single Streamable-HTTP transport, both wired
 * together. Stateful mode — each client performs one `initialize` call
 * and reuses the returned Mcp-Session-Id for subsequent calls.
 */
export function createMcpServer(ctx: { store: Store; lastRun: LastRunRef }): {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
} {
  const server = new McpServer({
    name: "status-page-to-chat",
    version: "1.0.0",
  });

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
    {
      description: "List all status pages currently being monitored.",
    },
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
    {
      description: "Show currently open incidents across all monitored providers.",
    },
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

  // Stateful mode: each MCP client (e.g. a Langdock assistant) performs
  // one `initialize` call, receives an Mcp-Session-Id header, and includes
  // it on subsequent requests. The SDK explicitly forbids reusing a
  // stateless transport, so this is the right pattern even for our single-
  // tenant deployment.
  //
  // enableJsonResponse short-circuits the SSE streaming path. Responses
  // come back as single JSON documents which is what Langdock expects.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });

  transport.onerror = (err) => {
    logger.error({ err }, "MCP transport.onerror");
  };

  void server.connect(transport).then(
    () => logger.info({}, "MCP server connected to transport"),
    (err) => logger.error({ err }, "MCP server.connect failed"),
  );
  logger.info({}, "MCP server initialised");

  return { server, transport };
}

/**
 * Reads the JSON body from an incoming request, used to feed the MCP
 * transport's handleRequest(). Mirrors the readBody in server.ts but is
 * duplicated here to keep mcp.ts self-contained.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
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

/**
 * Wires an MCP transport into the existing node:http server. Caller passes
 * the path-stripped URL and the transport delegates from there.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
): Promise<void> {
  // Do NOT pre-drain the request body. The SDK wrapper uses
  // @hono/node-server to translate the Node request into a Web-standard
  // Request, which reads the body itself. Pre-reading and passing as
  // parsedBody also works, but causes "500 with empty body" failures
  // in some SDK + Node combinations because the converted body is no
  // longer streamable.
  logger.info({ method: req.method }, "MCP request");
  try {
    await transport.handleRequest(req, res);
  } catch (err) {
    logger.error({ err }, "MCP transport.handleRequest threw");
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "mcp transport error", detail: (err as Error).message }));
    } else {
      res.end();
    }
  }
}

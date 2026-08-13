import { describe, expect, it } from "vitest";
import { providerSchema } from "../../src/lib/config.js";
import openapi from "../../src/api/openapi.json" with { type: "json" };

/**
 * The zod schema in config.ts is the single source of truth for what a
 * provider may contain. The OpenAPI document and the MCP tool schema are
 * hand-maintained copies of it — and drifted apart unnoticed: both listed
 * only 4 of 8 adapters and were missing five fields, so the API rejected
 * configurations the poller accepts.
 *
 * These tests fail the moment a new adapter or field lands without the
 * copies being updated.
 */
type ProviderShape = { _def: { shape: Record<string, { options?: string[] }> } };

function shapeOf(): Record<string, { options?: string[] }> {
  return (providerSchema as unknown as ProviderShape)._def.shape;
}

function zodAdapters(): string[] {
  return [...(shapeOf().adapter.options ?? [])].sort();
}

function zodFields(): string[] {
  return Object.keys(shapeOf()).sort();
}

describe("OpenAPI mirrors the provider schema", () => {
  const provider = openapi.components.schemas.Provider;

  it("lists every adapter the poller accepts", () => {
    expect([...provider.properties.adapter.enum].sort()).toEqual(zodAdapters());
  });

  it("documents every configurable field", () => {
    expect(Object.keys(provider.properties).sort()).toEqual(zodFields());
  });

  it("marks exactly the fields the schema requires", () => {
    expect([...provider.required].sort()).toEqual(["adapter", "displayName", "key"]);
  });
});

/**
 * `RunSummary` is served verbatim by `GET /api/last-run`, so the OpenAPI
 * copy drifts the moment a counter is added. `incidentsClosedStale` landed
 * without it and the documented response was silently incomplete.
 *
 * Read from the emitted log/response shape rather than the TS type, which
 * does not survive compilation: main.ts builds the object literal once, so
 * its keys are the contract.
 */
describe("OpenAPI mirrors RunSummary", () => {
  it("documents every counter the poller emits", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/lib/types.ts", import.meta.url), "utf8"),
    );
    const block = source.slice(source.indexOf("export type RunSummary = {"));
    const fields = [...block.slice(0, block.indexOf("};")).matchAll(/^\s{2}(\w+):/gm)].map(
      (m) => m[1],
    );

    const documented = Object.keys(openapi.components.schemas.RunSummary.properties);
    // `completedAt` is added by the API layer, not by the poll loop.
    expect(fields.sort()).toEqual(documented.filter((f) => f !== "completedAt").sort());
  });
});

describe("MCP tool schema mirrors the provider schema", () => {
  it("lists every adapter in the add_provider tool", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/api/mcp.ts", import.meta.url), "utf8"),
    );
    // The enum sits inside the inputSchema literal; pull it out textually
    // rather than booting an MCP server just to read a schema.
    const block = source.slice(source.indexOf("adapter: z.enum(["));
    const listed = [...block.slice(0, block.indexOf("])")).matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(listed.sort()).toEqual(zodAdapters());
  });
});

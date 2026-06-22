import { describe, it, expect, vi, beforeEach } from "vitest";
import * as AC from "adaptivecards";
import { TeamsNotifier } from "../../src/notifiers/teams.js";
import { NoopTranslator } from "../../src/lib/translator.js";
import type { AdapterHealthAlert, NormalizedIncident } from "../../src/lib/types.js";

vi.mock("../../src/lib/httpClient.js", () => ({ httpPost: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { httpPost } from "../../src/lib/httpClient.js";
const mockedHttpPost = vi.mocked(httpPost);

const incident: NormalizedIncident = {
  externalId: "inc-001",
  providerKey: "webflow",
  displayName: "Webflow",
  title: "CDN Degradation",
  description: "Visueller Website-Baukasten.",
  status: "open",
  url: "https://stspg.io/test001",
  startedAt: "2026-04-15T10:00:00Z",
  updatedAt: "2026-04-15T10:30:00Z",
};

function notifier(): TeamsNotifier {
  return new TeamsNotifier("https://teams.webhook.office.com/test", new NoopTranslator(), "de");
}

/** The Adaptive Card from the captured webhook payload (posted bare). */
function cardContent(): Record<string, unknown> {
  const [, payload] = mockedHttpPost.mock.calls[0];
  return payload as Record<string, unknown>;
}

/**
 * Walks a parsed card with the official object model and collects every
 * reachable TextBlock text. Duck-typed (getItemCount / getColumnCount) so
 * it traverses Container, Column, ColumnSet and AdaptiveCard uniformly.
 * If the renderer had dropped an element, its text would be missing here.
 */
function collectText(el: unknown): string[] {
  const out: string[] = [];
  const node = el as {
    text?: string;
    getItemCount?: () => number;
    getItemAt?: (i: number) => unknown;
    getColumnCount?: () => number;
    getColumnAt?: (i: number) => unknown;
  };
  if (typeof node.text === "string") out.push(node.text);
  if (typeof node.getItemCount === "function" && typeof node.getItemAt === "function") {
    for (let i = 0; i < node.getItemCount(); i++) out.push(...collectText(node.getItemAt(i)));
  }
  if (typeof node.getColumnCount === "function" && typeof node.getColumnAt === "function") {
    for (let i = 0; i < node.getColumnCount(); i++) out.push(...collectText(node.getColumnAt(i)));
  }
  return out;
}

function parse(content: Record<string, unknown>): AC.AdaptiveCard {
  const card = new AC.AdaptiveCard();
  card.parse(content as object);
  return card;
}

/** Recursively checks a plain object tree for a `bleed` property. */
function usesBleed(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesBleed);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("bleed" in obj) return true;
    return Object.values(obj).some(usesBleed);
  }
  return false;
}

describe("Teams Adaptive Card — official object-model parse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });
  });

  it("opened card parses into a non-empty tree with all expected text", async () => {
    await notifier().notifyOpened(incident);
    const card = parse(cardContent());

    expect(card.getItemCount()).toBeGreaterThan(0);
    const text = collectText(card).join(" | ");
    expect(text).toContain("Webflow");
    expect(text).toContain("Störung gemeldet");
    expect(text).toContain("CDN Degradation");
    expect(text).toContain("Visueller Website-Baukasten.");
  });

  it("resolved card parses into a non-empty tree with the resolved badge", async () => {
    await notifier().notifyResolved({ ...incident, status: "resolved" });
    const card = parse(cardContent());

    expect(card.getItemCount()).toBeGreaterThan(0);
    expect(collectText(card).join(" | ")).toContain("Behoben");
  });

  it("adapter-health card parses into a non-empty tree", async () => {
    const alert: AdapterHealthAlert = {
      kind: "down",
      providerKey: "bitwarden",
      providerName: "Bitwarden",
      errorCategory: "HTTP 404",
      durationLabel: "2h",
    };
    await notifier().notifyAdapterHealth(alert);
    const card = parse(cardContent());

    expect(card.getItemCount()).toBeGreaterThan(0);
    const text = collectText(card).join(" | ");
    expect(text).toContain("status-page-to-chat");
    expect(text).toContain("Bitwarden");
  });

  // Regression guard: `bleed: true` on a root Container makes Teams Workflows
  // render the card as an empty box (content clipped). Banning it across all
  // card types keeps that failure from coming back unnoticed.
  it("uses no `bleed` property in any card (blanks Teams Workflows)", async () => {
    await notifier().notifyOpened(incident);
    expect(usesBleed(cardContent())).toBe(false);
    vi.clearAllMocks();
    mockedHttpPost.mockResolvedValue({ status: 200, contentType: "", body: "" });

    await notifier().notifyAdapterHealth({
      kind: "recovered",
      providerKey: "bitwarden",
      providerName: "Bitwarden",
      durationLabel: "2h",
    });
    expect(usesBleed(cardContent())).toBe(false);
  });
});

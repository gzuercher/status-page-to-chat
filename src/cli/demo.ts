import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { closeStore, createStore } from "../state/store.js";
import { createNotifier } from "../notifiers/index.js";
import { faviconUrlForHost } from "../lib/logo.js";
import type { AdapterHealthAlert, NormalizedIncident, Notifier } from "../lib/types.js";

/** Derived, not hardcoded, so demo cards exercise the real logo source. */
const DEMO_LOGO_URL = faviconUrlForHost("example.com");

/** The card variants a `demo` run can emit. */
export type DemoType = "opened" | "resolved" | "down" | "recovered" | "halfdead";

const ALL_TYPES: DemoType[] = ["opened", "resolved", "down", "recovered", "halfdead"];

const ALIASES: Record<string, DemoType> = {
  opened: "opened",
  open: "opened",
  resolved: "resolved",
  resolve: "resolved",
  down: "down",
  recovered: "recovered",
  recover: "recovered",
  halfdead: "halfdead",
  "half-dead": "halfdead",
};

/**
 * Resolves the optional CLI argument into the list of card types to send.
 * No argument → all five. Throws on an unknown type so the caller can show
 * usage instead of silently sending nothing.
 */
export function demoTypes(arg?: string): DemoType[] {
  if (!arg) return [...ALL_TYPES];
  const resolved = ALIASES[arg.toLowerCase()];
  if (!resolved) {
    throw new Error(
      `Unknown demo type "${arg}". Valid: ${ALL_TYPES.join(", ")} (or omit for all).`,
    );
  }
  return [resolved];
}

/** A clearly-labelled sample incident — never mistaken for a real outage. */
export function sampleIncident(status: "open" | "resolved"): NormalizedIncident {
  // Fixed timestamps keep the card deterministic; the title is English on
  // purpose so the German machine-translation is visible in the demo.
  return {
    externalId: "demo-0001",
    providerKey: "demo",
    displayName: "Demo Service",
    title: "Increased API error rates in the EU region",
    description: "Beispielkarte – manuell ausgelöst, kein echter Vorfall.",
    status,
    url: "https://status.example.com/incidents/demo-0001",
    startedAt: "2026-06-22T10:00:00Z",
    updatedAt: "2026-06-22T10:30:00Z",
    logoUrl: DEMO_LOGO_URL,
  };
}

/** A sample adapter-health alert for the given kind. */
export function sampleAlert(kind: AdapterHealthAlert["kind"]): AdapterHealthAlert {
  const base = {
    providerKey: "demo",
    providerName: "Demo Service",
    logoUrl: DEMO_LOGO_URL,
  };
  switch (kind) {
    case "down":
      return { ...base, kind: "down", errorCategory: "HTTP 503", durationLabel: "2h" };
    case "recovered":
      return { ...base, kind: "recovered", durationLabel: "2h 15min" };
    case "halfDead":
      return { ...base, kind: "halfDead", durationLabel: "7d" };
  }
}

/**
 * Sends one demo card per requested type through the given notifier.
 * Pure orchestration — the notifier is injected so this is testable
 * without config, store or network.
 */
export async function sendDemo(notifier: Notifier, types: DemoType[]): Promise<void> {
  for (const type of types) {
    switch (type) {
      case "opened":
        await notifier.notifyOpened(sampleIncident("open"));
        break;
      case "resolved":
        await notifier.notifyResolved(sampleIncident("resolved"));
        break;
      case "down":
        await notifier.notifyAdapterHealth(sampleAlert("down"));
        break;
      case "recovered":
        await notifier.notifyAdapterHealth(sampleAlert("recovered"));
        break;
      case "halfdead":
        await notifier.notifyAdapterHealth(sampleAlert("halfDead"));
        break;
    }
    logger.info({ type }, "Demo card sent");
  }
}

/**
 * Subcommand: send example cards to the configured chat target.
 *
 * Usage: `node dist/src/main.js demo [opened|resolved|down|recovered|halfdead]`
 * With no argument it sends all five. Uses the real notifier (and the real
 * translator, so incident titles come through machine-translated), making
 * it the canonical way to eyeball the card design against a live channel.
 */
export async function runDemo(arg?: string): Promise<void> {
  const types = demoTypes(arg);
  const config = loadConfig();
  const store = createStore();
  const notifier = createNotifier(config, store);
  try {
    await sendDemo(notifier, types);
    logger.info({ count: types.length, types }, "Demo run complete");
  } finally {
    closeStore(store);
  }
}

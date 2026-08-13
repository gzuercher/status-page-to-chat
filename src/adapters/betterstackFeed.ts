import { XMLParser } from "fast-xml-parser";
import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { resolveProviderLogoUrl } from "../lib/logo.js";
import type { FetchContext, NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Adapter for status pages hosted on BetterStack.
 *
 * BetterStack does not expose a public JSON API but ships an RSS 2.0 feed
 * at `/feed.atom` (despite the name, the payload is RSS, not Atom). Each
 * `<item>` represents one *update*; updates belonging to the same incident
 * share an id, which we use as the stable externalId and to deduplicate.
 *
 * That id has moved between feed generations, so we accept both shapes:
 *
 *   - `<link>https://…/incident/12345</link>`     (older pages)
 *   - `<guid>https://…/#<sha256></guid>`          (current pages)
 *
 * Older code read the id only from `<link>`. When BetterStack switched to
 * a bare `<link>` plus a hash `<guid>`, every item lost its id and the
 * adapter silently reported zero incidents forever.
 *
 * An incident is treated as resolved once any of its updates contains
 * "resolved" or "fixed" in title/description, otherwise open. Since the
 * feed does not carry an explicit state field, this is the most reliable
 * heuristic across the BetterStack pages we have observed.
 *
 * Incidents older than MAX_INCIDENT_AGE_DAYS are dropped. The feed only
 * keeps recent updates, so an old long-resolved incident whose resolution
 * post has scrolled out looks "open" forever — without an age cap the
 * first poll would flood the channel.
 */

const FEED_PATH = "/feed.atom";
const MAX_INCIDENT_AGE_DAYS = 7;

/**
 * Words in title or description that mark an incident as resolved.
 *
 * "recovered" is what BetterStack's own monitor-driven updates say
 * ("Workflows Runtime recovered" closing "Workflows Runtime went down").
 * Leaving it out marks every such incident permanently open.
 */
const RESOLVED_KEYWORDS = [
  "resolved",
  "recovered",
  "fixed",
  "restored",
  "behoben",
  "gelöst",
  "wiederhergestellt",
  // Prose all-clears. Operators frequently close an incident without ever
  // using the word "resolved": measured against the live Langdock feed,
  // 6 of 11 incidents ended on wording like "The platform is available
  // again" and stayed open in our state forever.
  "available again",
  "back to normal",
  "wieder verfügbar",
  "wieder erreichbar",
];

/**
 * Words that withdraw an all-clear appearing in the same update.
 *
 * Partial recoveries read almost exactly like full ones — "All Claude models
 * except Fable 5 are available again. We're still working on Fable 5" — and
 * matching the all-clear alone would post a resolution card while the
 * incident is demonstrably ongoing. A false all-clear is worse than a late
 * one: it actively tells people a broken service works.
 *
 * Only consulted when a resolution keyword already matched, so ordinary
 * incident prose is unaffected.
 */
const QUALIFIER_KEYWORDS = [
  "still working",
  "still investigating",
  "except",
  "partially",
  "continue to",
  "weiterhin",
  "teilweise",
];

type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  guid?: string | { "#text": string };
  description?: string;
};

type RssFeed = {
  rss?: {
    channel?: {
      item?: RssItem | RssItem[];
    };
  };
};

/** Reads the `#text` payload out of a possibly-wrapped RSS scalar. */
function textOf(value: string | { "#text": string } | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : String(value["#text"] ?? "");
}

/**
 * Derives a stable per-incident id from an item's `<link>` and `<guid>`.
 * Tries the `/incident/<id>` path first, then the `#<hash>` fragment, then
 * the whole guid — returns null only when the item carries neither.
 */
function extractIncidentId(link: string, guid: string): string | null {
  const path = link.match(/\/incident\/([^/?#]+)/) ?? guid.match(/\/incident\/([^/?#]+)/);
  if (path) return path[1];

  const fragment = guid.match(/#(.+)$/);
  if (fragment) return fragment[1];

  return guid.trim() || null;
}

function isResolved(title: string, description: string): boolean {
  const haystack = `${title} ${description}`.toLowerCase();
  if (!RESOLVED_KEYWORDS.some((kw) => haystack.includes(kw))) return false;
  // An all-clear that carves out an exception is not an all-clear.
  return !QUALIFIER_KEYWORDS.some((kw) => haystack.includes(kw));
}

export class BetterStackFeedAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  /** Distinct incidents seen in the feed on the last fetch, before the age cap. */
  lastUpstreamCount = 0;
  private readonly baseUrl: string;
  private readonly userAgent?: string;
  private readonly logoUrl?: string;
  private readonly parser: XMLParser;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    if (!config.baseUrl) throw new Error(`baseUrl missing for ${config.key}`);
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.userAgent = config.userAgent;
    this.logoUrl = resolveProviderLogoUrl({
      explicitLogoUrl: config.logoUrl,
      baseUrl: this.baseUrl,
    });
    this.parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
  }

  async fetchIncidents(context?: FetchContext): Promise<NormalizedIncident[]> {
    const url = `${this.baseUrl}${FEED_PATH}`;
    const response = await httpGet(url, {
      accept: "application/atom+xml, application/rss+xml, application/xml",
      userAgent: this.userAgent,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    let parsed: RssFeed;
    try {
      parsed = this.parser.parse(response.body) as RssFeed;
    } catch (err) {
      throw new Error(`XML parsing failed: ${String(err)}`);
    }

    const rawItems = parsed.rss?.channel?.item;
    if (!rawItems) {
      logger.info({ provider: this.key, incidentCount: 0 }, "BetterStack feed empty");
      return [];
    }
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    // Group updates by incident id (multiple <item>s per incident).
    type Aggregated = {
      title: string;
      url: string;
      startedAt: string;
      updatedAt: string;
      resolved: boolean;
    };
    const byIncident = new Map<string, Aggregated>();

    let skippedWithoutId = 0;

    for (const item of items) {
      const link = textOf(item.link);
      const id = extractIncidentId(link, textOf(item.guid));
      if (!id) {
        skippedWithoutId++;
        continue;
      }

      const title = String(item.title ?? "Unknown incident");
      const description = String(item.description ?? "");
      const pubDate = item.pubDate
        ? new Date(item.pubDate).toISOString()
        : new Date().toISOString();
      const updateResolves = isResolved(title, description);

      const existing = byIncident.get(id);
      if (!existing) {
        byIncident.set(id, {
          title,
          url: link,
          startedAt: pubDate,
          updatedAt: pubDate,
          resolved: updateResolves,
        });
      } else {
        // Feed is reverse-chronological: oldest update wins for startedAt,
        // newest for updatedAt. Any update with resolved keyword wins.
        if (pubDate < existing.startedAt) existing.startedAt = pubDate;
        if (pubDate > existing.updatedAt) {
          existing.updatedAt = pubDate;
          // Prefer the most recent update's title as it usually carries the
          // current state (e.g. "[Resolved] X" overwriting "Investigating X").
          existing.title = title;
        }
        if (updateResolves) existing.resolved = true;
      }
    }

    const cutoff = Date.now() - MAX_INCIDENT_AGE_DAYS * 24 * 60 * 60 * 1000;
    const normalized: NormalizedIncident[] = [];
    for (const [externalId, agg] of byIncident) {
      // The age cap keeps the feed's back catalogue out, but it must not
      // strand an incident we already reported: this feed carries no
      // "unresolved" endpoint, so an incident that stays open past the
      // cutoff would drop out and its resolution never arrive.
      if (new Date(agg.updatedAt).getTime() < cutoff && !context?.trackedOpenIds.has(externalId)) {
        continue;
      }
      normalized.push({
        externalId,
        providerKey: this.key,
        displayName: this.displayName,
        title: agg.title,
        status: agg.resolved ? "resolved" : "open",
        url: agg.url,
        startedAt: agg.startedAt,
        updatedAt: agg.updatedAt,
        logoUrl: this.logoUrl,
      });
    }

    this.lastUpstreamCount = byIncident.size;

    if (skippedWithoutId > 0) {
      logger.warn(
        { provider: this.key, skippedWithoutId, itemCount: items.length },
        "BetterStack feed items without a derivable incident id were skipped",
      );
    }

    logger.info(
      {
        provider: this.key,
        incidentCount: normalized.length,
        upstreamCount: this.lastUpstreamCount,
      },
      "BetterStack feed incidents fetched",
    );

    return normalized;
  }
}

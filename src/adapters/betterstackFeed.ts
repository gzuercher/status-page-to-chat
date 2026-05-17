import { XMLParser } from "fast-xml-parser";
import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { resolveProviderLogoUrl } from "../lib/logo.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Adapter for status pages hosted on BetterStack.
 *
 * BetterStack does not expose a public JSON API but ships an RSS 2.0 feed
 * at `/feed.atom` (despite the name, the payload is RSS, not Atom). Each
 * `<item>` represents one *update* — multiple updates for the same incident
 * share a `<link>` of the form `…/incident/<id>`, which we use as the
 * stable externalId and to deduplicate.
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

/** Words in title or description that mark an incident as resolved. */
const RESOLVED_KEYWORDS = ["resolved", "fixed", "restored", "behoben", "gelöst"];

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

function extractIncidentId(link: string): string | null {
  // Match …/incident/<id> — id may be numeric or hash-like.
  const m = link.match(/\/incident\/([^/?#]+)/);
  return m ? m[1] : null;
}

function isResolved(title: string, description: string): boolean {
  const haystack = `${title} ${description}`.toLowerCase();
  return RESOLVED_KEYWORDS.some((kw) => haystack.includes(kw));
}

export class BetterStackFeedAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
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

  async fetchIncidents(): Promise<NormalizedIncident[]> {
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

    for (const item of items) {
      const link = item.link ?? "";
      const id = extractIncidentId(link);
      if (!id) continue;

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
      if (new Date(agg.updatedAt).getTime() < cutoff) continue;
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

    logger.info(
      { provider: this.key, incidentCount: normalized.length },
      "BetterStack feed incidents fetched",
    );

    return normalized;
  }
}

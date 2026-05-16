import { XMLParser } from "fast-xml-parser";
import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { resolveProviderLogoUrl } from "../lib/logo.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Adapter for status pages hosted on Hund.io.
 *
 * Hund's public JSON API (`/api/v1/*`) requires an API key, but each page
 * also ships a public Atom feed at `/state_feed/feed`. Schema:
 *
 *   <entry>
 *     <id>tag:host,2005:State::FeedNotifier::Entry/&lt;id&gt;</id>
 *     <link href="https://host/issues/&lt;id&gt;"/>
 *     <title>[Ended] Maintenance Window: …</title>   ← bracket prefix = state
 *     <published>2026-…</published>
 *     <updated>2026-…</updated>
 *     <content type="html">…</content>
 *   </entry>
 *
 * State is derived from the bracket prefix of the title. We treat
 * "Ended", "Resolved", "Fixed" and the German equivalent "Gelöst" as
 * resolved. Anything else (no prefix or other prefixes like "Investigating",
 * "Identified", "Monitoring") is open.
 */

const FEED_PATH = "/state_feed/feed";

const RESOLVED_PREFIXES = [
  "ended",
  "resolved",
  "fixed",
  "completed",
  "gelöst",
  "geloest",
  "beendet",
  "behoben",
];

type AtomLink = string | { "@_href"?: string };

type AtomEntry = {
  id?: string;
  title?: string;
  published?: string;
  updated?: string;
  link?: AtomLink | AtomLink[];
};

type AtomFeed = {
  feed?: {
    entry?: AtomEntry | AtomEntry[];
  };
};

function extractEntryId(rawId: string): string | null {
  // tag:host,2005:State::FeedNotifier::Entry/<id> → take the trailing segment.
  const m = rawId.match(/\/([^/]+)$/);
  return m ? m[1] : null;
}

function extractLinkHref(link: AtomLink | AtomLink[] | undefined): string | null {
  if (!link) return null;
  const first = Array.isArray(link) ? link[0] : link;
  if (!first) return null;
  if (typeof first === "string") return first;
  return first["@_href"] ?? null;
}

function isResolved(title: string): boolean {
  // Hund titles start with "[State] …" e.g. "[Ended] Maintenance Window".
  const m = title.match(/^\s*\[([^\]]+)\]/);
  if (!m) return false;
  const prefix = m[1].trim().toLowerCase();
  return RESOLVED_PREFIXES.some((kw) => prefix === kw);
}

export class HundAtomAdapter implements StatusProvider {
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
    // Keep attributes so we can read <link href="…"/>.
    this.parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    const url = `${this.baseUrl}${FEED_PATH}`;
    const response = await httpGet(url, {
      accept: "application/atom+xml, application/xml",
      userAgent: this.userAgent,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    let parsed: AtomFeed;
    try {
      parsed = this.parser.parse(response.body) as AtomFeed;
    } catch (err) {
      throw new Error(`XML parsing failed: ${String(err)}`);
    }

    const rawEntries = parsed.feed?.entry;
    if (!rawEntries) {
      logger.info({ provider: this.key, incidentCount: 0 }, "Hund feed empty");
      return [];
    }
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];

    const normalized: NormalizedIncident[] = [];

    for (const entry of entries) {
      const externalId = entry.id ? extractEntryId(entry.id) : null;
      if (!externalId) continue;

      const title = String(entry.title ?? "Unknown incident").trim();
      const href = extractLinkHref(entry.link) ?? this.baseUrl;
      const published = entry.published
        ? new Date(entry.published).toISOString()
        : new Date().toISOString();
      const updated = entry.updated ? new Date(entry.updated).toISOString() : published;

      normalized.push({
        externalId,
        providerKey: this.key,
        displayName: this.displayName,
        title,
        status: isResolved(title) ? "resolved" : "open",
        url: href,
        startedAt: published,
        updatedAt: updated,
        logoUrl: this.logoUrl,
      });
    }

    logger.info(
      { provider: this.key, incidentCount: normalized.length },
      "Hund feed incidents fetched",
    );

    return normalized;
  }
}

import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

const RSS_URL = "https://support.metanet.ch/xml/statusmeldungen.xml";

/** Keywords indicating a resolved incident. */
const RESOLVED_KEYWORDS = ["behoben", "gelöst", "ended", "resolved", "abgeschlossen"];

/** Keywords for maintenance work (skipped). */
const MAINTENANCE_KEYWORDS = ["wartungsarbeiten", "maintenance", "geplante wartung"];

/**
 * Simple XML tag extractor (no full parser needed for RSS).
 */
function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`,
  );
  const match = xml.match(regex);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/**
 * Extracts all <item> blocks from the RSS feed.
 */
function extractItems(rssBody: string): string[] {
  const items: string[] = [];
  const regex = /<item>([\s\S]*?)<\/item>/g;
  let match = regex.exec(rssBody);
  while (match) {
    items.push(match[1]);
    match = regex.exec(rssBody);
  }
  return items;
}

/**
 * Checks whether a text contains any of the given keywords (case-insensitive).
 */
function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Adapter for Metanet Switzerland status announcements (RSS).
 */
export class MetanetRssAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  private readonly userAgent?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    this.userAgent = config.userAgent;
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    const response = await httpGet(RSS_URL, {
      accept: "application/rss+xml",
      userAgent: this.userAgent,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from Metanet RSS`);
    }

    const items = extractItems(response.body);
    const normalized: NormalizedIncident[] = [];

    for (const item of items) {
      const title = extractTag(item, "title");
      const link = extractTag(item, "link");
      const guid = extractTag(item, "guid") || link;
      const pubDate = extractTag(item, "pubDate");
      const description = extractTag(item, "description");

      const fullText = `${title} ${description}`;

      // Skip maintenance work
      if (containsKeyword(fullText, MAINTENANCE_KEYWORDS)) {
        continue;
      }

      const status = containsKeyword(fullText, RESOLVED_KEYWORDS) ? "resolved" : "open";

      normalized.push({
        externalId: guid,
        providerKey: this.key,
        displayName: this.displayName,
        title,
        status,
        url: link || "https://support.metanet.ch/",
        startedAt: pubDate || new Date().toISOString(),
        updatedAt: pubDate || new Date().toISOString(),
      });
    }

    logger.info(
      { provider: this.key, incidentCount: normalized.length },
      "Metanet RSS incidents fetched",
    );

    return normalized;
  }
}

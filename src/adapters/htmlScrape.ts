import { createHash } from "node:crypto";
import { load as loadHtml } from "cheerio";
import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { resolveProviderLogoUrl } from "../lib/logo.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Generic HTML-scraping adapter for status pages that expose neither a
 * JSON API nor an RSS/Atom feed.
 *
 * The operator supplies a CSS `selector` pointing at an element whose
 * text content (or a relevant attribute, captured via `class` or text)
 * reflects the overall status, plus a `healthyMatch` (string or regex
 * source) that, when matching, means "no incident". Anything else is
 * surfaced as a single synthetic open incident.
 *
 * Limitations:
 *   - One overall incident per provider; no per-component decomposition.
 *   - No timestamps from the HTML; `startedAt`/`updatedAt` are "now".
 *   - `externalId` is `sha256(matchedText).slice(0, 16)` so the state
 *     store does not re-fire the same incident every poll cycle as
 *     long as the page text is stable.
 *
 * The selector matches against either the element's text content or, if
 * the text is empty, the element's `class` attribute (covers cases like
 * CheckCentral where status is encoded purely as a CSS class on an
 * otherwise empty `<div>`).
 */

const DEFAULT_TITLE_TEMPLATE = "Status page reports: {matchedText}";

/**
 * Resolves a `healthyMatch` config value to a predicate. A string starting
 * and ending with `/` (optionally `/i`) is treated as a regex source;
 * everything else is a case-insensitive substring match.
 */
function buildHealthyPredicate(healthyMatch: string): (matched: string) => boolean {
  const regexShape = /^\/(.+)\/([gimsuy]*)$/;
  const m = healthyMatch.match(regexShape);
  if (m) {
    const re = new RegExp(m[1], m[2]);
    return (matched) => re.test(matched);
  }
  const needle = healthyMatch.toLowerCase();
  return (matched) => matched.toLowerCase().includes(needle);
}

export class HtmlScrapeAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly selector: string;
  private readonly healthyPredicate: (matched: string) => boolean;
  private readonly titleTemplate: string;
  private readonly userAgent?: string;
  private readonly logoUrl?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    if (!config.baseUrl) throw new Error(`baseUrl missing for ${config.key}`);
    if (!config.selector) throw new Error(`selector missing for ${config.key}`);
    if (!config.healthyMatch) throw new Error(`healthyMatch missing for ${config.key}`);
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.selector = config.selector;
    this.healthyPredicate = buildHealthyPredicate(config.healthyMatch);
    this.titleTemplate = config.titleTemplate ?? DEFAULT_TITLE_TEMPLATE;
    this.userAgent = config.userAgent;
    this.logoUrl = resolveProviderLogoUrl({
      explicitLogoUrl: config.logoUrl,
      baseUrl: this.baseUrl,
    });
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    const response = await httpGet(this.baseUrl, {
      accept: "text/html",
      userAgent: this.userAgent,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from ${this.baseUrl}`);
    }

    if (!response.contentType.includes("text/html")) {
      throw new Error(
        `Unexpected Content-Type "${response.contentType}" from ${this.baseUrl} — expected text/html`,
      );
    }

    const $ = loadHtml(response.body);
    const element = $(this.selector).first();

    if (element.length === 0) {
      throw new Error(`Selector "${this.selector}" did not match any element on ${this.baseUrl}`);
    }

    // Prefer text content; fall back to the class attribute for empty
    // marker elements (e.g. CheckCentral's <div class="success"></div>).
    const text = element.text().trim();
    const matchedText = text.length > 0 ? text : (element.attr("class") ?? "").trim();

    if (matchedText.length === 0) {
      throw new Error(
        `Selector "${this.selector}" matched an element with no text and no class on ${this.baseUrl}`,
      );
    }

    if (this.healthyPredicate(matchedText)) {
      logger.info({ provider: this.key, matchedText, incidentCount: 0 }, "HTML scrape: healthy");
      return [];
    }

    const externalId = createHash("sha256").update(matchedText).digest("hex").slice(0, 16);
    const title = this.titleTemplate.replace("{matchedText}", matchedText);
    const now = new Date().toISOString();

    logger.info(
      { provider: this.key, matchedText, incidentCount: 1 },
      "HTML scrape: open incident detected",
    );

    return [
      {
        externalId,
        providerKey: this.key,
        displayName: this.displayName,
        title,
        status: "open",
        url: this.baseUrl,
        startedAt: now,
        updatedAt: now,
        logoUrl: this.logoUrl,
      },
    ];
  }
}

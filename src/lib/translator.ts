import { createHash } from "node:crypto";
import { httpPost } from "./httpClient.js";
import { logger } from "./logger.js";
import { localeToLanguageName, type Locale } from "./i18n.js";
import { getCachedTranslation, setCachedTranslation, type Store } from "../state/store.js";

/**
 * Translates a short, provider-supplied status message into the target
 * language. Implementations MUST be resilient: on any failure they return
 * the original text so a translation problem never blocks a notification.
 */
export interface Translator {
  /** Returns `text` translated into the configured target language, or `text` unchanged on failure. */
  translate(text: string): Promise<string>;
}

/** Identity translator — used when no API key is configured. */
export class NoopTranslator implements Translator {
  async translate(text: string): Promise<string> {
    return text;
  }
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
};

/**
 * Machine translation via the Claude Messages API (Haiku by default).
 *
 * Results are cached in SQLite keyed by a hash of the source text plus the
 * target language. Incident titles repeat (the "opened" and "resolved"
 * notifications reuse the same title), so in steady state almost every
 * call is a cache hit and the API is barely touched.
 *
 * Failure handling is deliberately silent-at-the-card-level: any network,
 * auth or parsing error is logged and the ORIGINAL text is returned, so a
 * translation outage degrades to untranslated titles rather than missed
 * notifications.
 */
export class ClaudeTranslator implements Translator {
  private readonly apiKey: string;
  private readonly targetLocale: Locale;
  private readonly store: Store;
  private readonly model: string;
  private readonly systemPrompt: string;

  constructor(apiKey: string, targetLocale: Locale, store: Store, model = DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.targetLocale = targetLocale;
    this.store = store;
    this.model = model;
    const language = localeToLanguageName(targetLocale);
    this.systemPrompt =
      `You are a translation engine for short service-status messages. ` +
      `Translate the user's message into ${language}. ` +
      `Keep product names, brand names, component names and technical identifiers ` +
      `(version numbers, error codes, URLs) unchanged. Preserve meaning and tone. ` +
      `Respond with ONLY the translated text — no quotes, no preamble, no explanation. ` +
      `If the text is already in ${language}, return it unchanged.`;
  }

  async translate(text: string): Promise<string> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return text;

    const hash = createHash("sha256").update(trimmed).digest("hex");
    const cached = getCachedTranslation(this.store, hash, this.targetLocale);
    if (cached !== undefined) return cached;

    try {
      const response = await httpPost(
        ANTHROPIC_URL,
        {
          model: this.model,
          max_tokens: 512,
          system: this.systemPrompt,
          messages: [{ role: "user", content: trimmed }],
        },
        {
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
        },
      );

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.body}`);
      }

      const parsed = JSON.parse(response.body) as AnthropicResponse;
      const translated = parsed.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();

      if (!translated) {
        throw new Error("Empty translation response");
      }

      setCachedTranslation(this.store, hash, this.targetLocale, translated);
      logger.debug({ targetLocale: this.targetLocale }, "Title translated");
      return translated;
    } catch (err) {
      logger.warn(
        { err, targetLocale: this.targetLocale },
        "Translation failed, using original text",
      );
      return text;
    }
  }
}

/**
 * Builds the translator matching the runtime configuration.
 *
 * Returns a {@link ClaudeTranslator} when `ANTHROPIC_API_KEY` is set,
 * otherwise a {@link NoopTranslator}. The model can be overridden with
 * `TRANSLATE_MODEL`.
 */
export function createTranslator(targetLocale: Locale, store: Store): Translator {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.info("ANTHROPIC_API_KEY not set — incident titles will not be translated");
    return new NoopTranslator();
  }
  const model = process.env.TRANSLATE_MODEL ?? DEFAULT_MODEL;
  logger.info({ targetLocale, model }, "Claude translator enabled");
  return new ClaudeTranslator(apiKey, targetLocale, store, model);
}

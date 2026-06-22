import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logger } from "./logger.js";

/**
 * Caps YAML anchor expansion to prevent a "YAML bomb" mounted file from
 * exhausting memory. 100 is well above any realistic legitimate use.
 */
const YAML_PARSE_OPTIONS = { maxAliasCount: 100 } as const;

/**
 * zod schema for a single provider entry in providers.yaml.
 * Exported so the API server can validate incoming PUT payloads against
 * the same rules the poller enforces.
 */
export const providerSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/, "key may only contain a-z, 0-9 and -"),
    displayName: z.string().min(1),
    /**
     * Optional one-line service description rendered as a subtle line on the
     * chat card (e.g. "Sichere Übertragung von Einmal-Geheimnissen."). Author
     * it in the deployment's language — it is shown verbatim, not translated.
     */
    description: z.string().min(1).max(280).optional(),
    adapter: z.enum([
      "atlassian-statuspage",
      "google-workspace",
      "wedos-status-online",
      "github-issues",
      "betterstack-feed",
      "hund-atom",
      "zendesk-ssp",
      "html-scrape",
    ]),
    baseUrl: z.string().url().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    componentFilter: z.union([z.string(), z.array(z.string())]).optional(),
    userAgent: z.string().optional(),
    /**
     * CSS selector for the html-scrape adapter. Points at the element
     * whose text (or `class` attribute, if the text is empty) reflects
     * the overall status.
     */
    selector: z.string().min(1).optional(),
    /**
     * Pattern that means "healthy / no incident" for the html-scrape
     * adapter. A string in `/pattern/flags` form is treated as a regex;
     * everything else is a case-insensitive substring match against the
     * matched element's text or class attribute.
     */
    healthyMatch: z.string().min(1).optional(),
    /**
     * Optional title override for the html-scrape adapter. `{matchedText}`
     * is replaced with the scraped status text. Defaults to
     * `"Status page reports: {matchedText}"`.
     */
    titleTemplate: z.string().min(1).optional(),
    /**
     * Optional explicit brand logo URL for the chat card. When unset, the
     * adapter derives a favicon from the provider's host. Set this for
     * providers whose status page host has no favicon registered (e.g.
     * status.zendesk.com → set zendesk.com) or providers without a baseUrl
     * (github-issues).
     */
    logoUrl: z.string().url().optional(),
  })
  .refine(
    (p) => {
      const requiresBaseUrl = [
        "atlassian-statuspage",
        "wedos-status-online",
        "betterstack-feed",
        "hund-atom",
        "zendesk-ssp",
        "html-scrape",
      ];
      if (requiresBaseUrl.includes(p.adapter)) {
        return !!p.baseUrl;
      }
      return true;
    },
    {
      message:
        "baseUrl is required for atlassian-statuspage, wedos-status-online, betterstack-feed, hund-atom, zendesk-ssp and html-scrape",
    },
  )
  .refine(
    (p) => {
      if (p.adapter === "github-issues") {
        return !!p.owner && !!p.repo;
      }
      return true;
    },
    { message: "owner and repo are required for github-issues" },
  )
  .refine(
    (p) => {
      if (p.adapter === "html-scrape") {
        return !!p.selector && !!p.healthyMatch;
      }
      return true;
    },
    { message: "selector and healthyMatch are required for html-scrape" },
  );

/**
 * zod schema for the entire providers.yaml.
 */
export const configSchema = z
  .object({
    chatTarget: z.enum(["googleChat", "teams"]),
    /**
     * UI language for the chat cards (static labels, badges, health texts)
     * and the target language for machine-translated incident titles.
     * Defaults to German. Override per deployment with the `LANGUAGE` env var.
     */
    language: z.enum(["de", "en"]).default("de"),
    // Empty list is valid — the service starts in "no providers configured"
    // state and the operator adds entries via the REST API or by editing the
    // mounted providers.yaml. Poll cycles log a zero-count run_summary.
    providers: z.array(providerSchema),
  })
  .refine(
    (c) => {
      const keys = c.providers.map((p) => p.key);
      return new Set(keys).size === keys.length;
    },
    { message: "Provider keys must be unique" },
  );

export type ProviderConfig = z.infer<typeof providerSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export type ConfigErrorKind = "read" | "parse" | "validate";

export type ConfigError = {
  kind: ConfigErrorKind;
  filePath: string;
  message: string;
  /** zod field-level errors when kind === "validate". */
  fieldErrors?: Record<string, string[]>;
  /** Underlying error for read/parse failures. */
  cause?: unknown;
};

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; error: ConfigError };

function resolveConfigPath(configPath?: string): string {
  return (
    configPath ?? process.env.CONFIG_PATH ?? resolve(process.cwd(), "config", "providers.yaml")
  );
}

/**
 * Validates a YAML string in-memory and returns a Result. Used by the
 * API server's configWriter to validate proposed edits before writing
 * them to disk, without the temp-file dance.
 */
export function parseConfigFromString(raw: string, filePath = "<in-memory>"): ConfigResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, YAML_PARSE_OPTIONS);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "parse",
        filePath,
        message: `YAML could not be parsed: ${(err as Error).message}`,
        cause: err,
      },
    };
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const flat = result.error.flatten();
    return {
      ok: false,
      error: {
        kind: "validate",
        filePath,
        message: "Configuration is invalid",
        fieldErrors: { _root: flat.formErrors, ...flat.fieldErrors },
      },
    };
  }

  // Optional env-level override of chatTarget. Lets the seed-from-template
  // mechanism ship a generic default (googleChat) while a deployment can
  // pin a different target via env without rewriting the YAML.
  const override = process.env.CHAT_TARGET;
  if (override) {
    if (override !== "googleChat" && override !== "teams") {
      return {
        ok: false,
        error: {
          kind: "validate",
          filePath,
          message: `CHAT_TARGET env override is invalid: "${override}" (must be googleChat or teams)`,
        },
      };
    }
    result.data.chatTarget = override;
  }

  // Optional env-level override of the UI/translation language, mirroring
  // the CHAT_TARGET mechanism above.
  const langOverride = process.env.LANGUAGE;
  if (langOverride) {
    if (langOverride !== "de" && langOverride !== "en") {
      return {
        ok: false,
        error: {
          kind: "validate",
          filePath,
          message: `LANGUAGE env override is invalid: "${langOverride}" (must be de or en)`,
        },
      };
    }
    result.data.language = langOverride;
  }

  return { ok: true, config: result.data };
}

/**
 * Parses and validates the configuration without side effects.
 * Returns a Result. Use this from CLI subcommands and the API server,
 * where exit-on-error is wrong.
 */
export function parseConfig(configPath?: string): ConfigResult {
  const filePath = resolveConfigPath(configPath);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "read",
        filePath,
        message: `Configuration file could not be loaded: ${(err as Error).message}`,
        cause: err,
      },
    };
  }

  return parseConfigFromString(raw, filePath);
}

/**
 * Loads and validates the configuration. On error, logs and exits.
 * Thin wrapper around parseConfig() for the long-running poller entrypoint.
 */
export function loadConfig(configPath?: string): AppConfig {
  const result = parseConfig(configPath);
  if (!result.ok) {
    logger.fatal(
      {
        err: result.error.cause,
        filePath: result.error.filePath,
        errors: result.error.fieldErrors,
      },
      result.error.message,
    );
    process.exit(1);
  }

  logger.info(
    { providerCount: result.config.providers.length, chatTarget: result.config.chatTarget },
    "Configuration loaded",
  );

  return result.config;
}

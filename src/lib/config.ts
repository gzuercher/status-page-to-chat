import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logger } from "./logger.js";

/**
 * zod schema for a single provider entry in providers.yaml.
 */
const providerSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/, "key may only contain a-z, 0-9 and -"),
    displayName: z.string().min(1),
    adapter: z.enum([
      "atlassian-statuspage",
      "google-workspace",
      "metanet-rss",
      "wedos-status-online",
      "github-issues",
    ]),
    baseUrl: z.string().url().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    componentFilter: z.union([z.string(), z.array(z.string())]).optional(),
    userAgent: z.string().optional(),
  })
  .refine(
    (p) => {
      if (p.adapter === "atlassian-statuspage" || p.adapter === "wedos-status-online") {
        return !!p.baseUrl;
      }
      return true;
    },
    { message: "baseUrl is required for atlassian-statuspage and wedos-status-online" },
  )
  .refine(
    (p) => {
      if (p.adapter === "github-issues") {
        return !!p.owner && !!p.repo;
      }
      return true;
    },
    { message: "owner and repo are required for github-issues" },
  );

/**
 * zod schema for the entire providers.yaml.
 */
const configSchema = z
  .object({
    chatTarget: z.enum(["googleChat", "teams"]),
    providers: z.array(providerSchema).min(1, "At least one provider must be configured"),
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

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
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

  return { ok: true, config: result.data };
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

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

/**
 * Loads and validates the configuration from config/providers.yaml.
 * On validation error, logs and exits the process.
 */
export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? resolve(process.cwd(), "config", "providers.yaml");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.fatal({ err, filePath }, "Configuration file could not be loaded");
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    logger.fatal({ err, filePath }, "YAML could not be parsed");
    process.exit(1);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    logger.fatal({ errors: result.error.flatten(), filePath }, "Configuration is invalid");
    process.exit(1);
  }

  logger.info(
    { providerCount: result.data.providers.length, chatTarget: result.data.chatTarget },
    "Configuration loaded",
  );

  return result.data;
}

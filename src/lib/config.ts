import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logger } from "./logger.js";

/**
 * zod-Schema fuer einen einzelnen Provider-Eintrag in providers.yaml.
 */
const providerSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/, "key darf nur a-z, 0-9 und - enthalten"),
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
    { message: "baseUrl ist Pflicht fuer atlassian-statuspage und wedos-status-online" },
  )
  .refine(
    (p) => {
      if (p.adapter === "github-issues") {
        return !!p.owner && !!p.repo;
      }
      return true;
    },
    { message: "owner und repo sind Pflicht fuer github-issues" },
  );

/**
 * zod-Schema fuer die gesamte providers.yaml.
 */
const configSchema = z
  .object({
    chatTarget: z.enum(["googleChat", "teams"]),
    providers: z.array(providerSchema).min(1, "Mindestens ein Provider muss konfiguriert sein"),
  })
  .refine(
    (c) => {
      const keys = c.providers.map((p) => p.key);
      return new Set(keys).size === keys.length;
    },
    { message: "Provider-Keys muessen eindeutig sein" },
  );

export type ProviderConfig = z.infer<typeof providerSchema>;
export type AppConfig = z.infer<typeof configSchema>;

/**
 * Laedt und validiert die Konfiguration aus config/providers.yaml.
 * Bei Validierungsfehler wird geloggt und der Prozess beendet.
 */
export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? resolve(process.cwd(), "config", "providers.yaml");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.fatal({ err, filePath }, "Konfigurationsdatei konnte nicht geladen werden");
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    logger.fatal({ err, filePath }, "YAML konnte nicht geparst werden");
    process.exit(1);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    logger.fatal({ errors: result.error.flatten(), filePath }, "Konfiguration ist ungueltig");
    process.exit(1);
  }

  logger.info(
    { providerCount: result.data.providers.length, chatTarget: result.data.chatTarget },
    "Konfiguration geladen",
  );

  return result.data;
}

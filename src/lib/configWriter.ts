import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as YAML from "yaml";
import { parseConfigFromString, type ProviderConfig } from "./config.js";

// maxAliasCount lives on ToJSOptions, not ParseOptions — anchor expansion
// happens during the toJS conversion (i.e. inside parseConfigFromString,
// which calls yaml.parse()). parseDocument keeps anchors as aliases in the
// document tree, so it does not need the limit here.

function resolveConfigPath(configPath?: string): string {
  return (
    configPath ?? process.env.CONFIG_PATH ?? resolve(process.cwd(), "config", "providers.yaml")
  );
}

/**
 * Loads the YAML document while preserving comments and formatting.
 * Throws on read or parse failure — callers in the API server wrap this
 * and return 4xx/5xx accordingly.
 */
function loadDocument(configPath: string): YAML.Document.Parsed {
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(
      `providers.yaml has YAML errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return doc;
}

/**
 * In-place write of the providers config. We deliberately do NOT use the
 * common "write-temp + rename" atomicity trick: in Docker single-file
 * bind-mount deployments rename(2) fails with EBUSY because Linux
 * refuses to overwrite a mount-point inode. Direct write works for both
 * named-volume and bind-mount setups.
 *
 * Crash-safety is provided by two layers above:
 *   1) validateOrThrow() refuses to call this with invalid content
 *   2) the poll loop's parseConfig() returns a Result; on any read/parse
 *      failure the runner keeps using the last good in-memory config
 *      instead of crashing.
 * The risk window between truncate and full write is microseconds.
 */
function safeWrite(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf-8");
}

/**
 * Inserts a new provider entry or updates an existing one in place.
 *
 * Identity is the `key` field (string). When the key already exists,
 * the existing YAML node is replaced — surrounding comments and the
 * position in the list stay where they were. When the key is new,
 * the entry is appended to the providers list.
 *
 * Re-validates the full document against the zod schema before writing.
 * Throws on validation failure so the caller can return a 400 without
 * having touched the file.
 */
export function upsertProviderInYaml(
  provider: ProviderConfig,
  configPath?: string,
): { created: boolean } {
  const filePath = resolveConfigPath(configPath);
  const doc = loadDocument(filePath);

  const providers = doc.get("providers");
  if (!YAML.isSeq(providers)) {
    throw new Error("providers.yaml does not contain a 'providers' sequence");
  }

  const newNode = doc.createNode(provider);
  if (YAML.isMap(newNode)) {
    // Force block style so the serialised YAML stays human-readable
    // even when inserted into a previously-empty `providers: []` list.
    newNode.flow = false;
  }
  let created = true;

  for (let i = 0; i < providers.items.length; i++) {
    const item = providers.items[i];
    if (YAML.isMap(item)) {
      const existingKey = item.get("key");
      if (existingKey === provider.key) {
        providers.items[i] = newNode;
        created = false;
        break;
      }
    }
  }

  if (created) {
    providers.add(newNode);
    // If the sequence was previously empty-flow (`providers: []`),
    // switch it to block style now that it has content.
    providers.flow = false;
  }

  validateOrThrow(doc, filePath);
  safeWrite(filePath, doc.toString());
  return { created };
}

/**
 * Removes a provider entry by key. Returns true when the entry existed
 * and was removed, false when no match was found (caller maps to 404).
 */
export function removeProviderFromYaml(key: string, configPath?: string): boolean {
  const filePath = resolveConfigPath(configPath);
  const doc = loadDocument(filePath);

  const providers = doc.get("providers");
  if (!YAML.isSeq(providers)) {
    throw new Error("providers.yaml does not contain a 'providers' sequence");
  }

  let removed = false;
  for (let i = 0; i < providers.items.length; i++) {
    const item = providers.items[i];
    if (YAML.isMap(item) && item.get("key") === key) {
      providers.items.splice(i, 1);
      removed = true;
      break;
    }
  }

  if (!removed) return false;

  validateOrThrow(doc, filePath);
  safeWrite(filePath, doc.toString());
  return true;
}

/**
 * Re-validates the serialised document in-memory through parseConfigFromString
 * so the same zod schema that the poller uses gates every write. Avoids the
 * temp-file dance — important when the YAML lives on a read-only mount
 * where only the target file is writable.
 */
function validateOrThrow(doc: YAML.Document.Parsed, filePath: string): void {
  const serialised = doc.toString();
  const result = parseConfigFromString(serialised, filePath);
  if (!result.ok) {
    const detail = result.error.fieldErrors
      ? JSON.stringify(result.error.fieldErrors)
      : result.error.message;
    throw new Error(`Resulting config is invalid: ${detail}`);
  }
}

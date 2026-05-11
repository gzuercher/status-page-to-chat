import { parseConfig } from "../lib/config.js";

/**
 * Subcommand: parse providers.yaml, print human-readable result, exit 0/1.
 *
 * Designed for operators who edited the mounted providers.yaml on the host
 * and want to verify the file before the next poll cycle picks it up.
 * Writes plain text to stdout/stderr — no pino, since this is a one-shot
 * operator-facing tool, not part of the long-running log stream.
 */
export function runValidate(): void {
  const result = parseConfig();

  if (result.ok) {
    const { providers, chatTarget } = result.config;
    process.stdout.write(
      `OK: configuration valid (${providers.length} provider(s), chatTarget=${chatTarget})\n`,
    );
    process.exit(0);
  }

  const { error } = result;
  process.stderr.write(`Configuration invalid (${error.kind}): ${error.filePath}\n`);
  process.stderr.write(`  ${error.message}\n`);

  if (error.fieldErrors) {
    for (const [field, messages] of Object.entries(error.fieldErrors)) {
      if (!messages || messages.length === 0) continue;
      for (const message of messages) {
        process.stderr.write(`  - ${field}: ${message}\n`);
      }
    }
  }
  process.exit(1);
}

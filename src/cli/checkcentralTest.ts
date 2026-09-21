import { logger } from "../lib/logger.js";
import { loadCheckCentralConfig, sendCheckin } from "../lib/checkcentralMailer.js";

/** Same subject the real poll cycle uses — see main.ts's maybeSendCheckCentralCheckin. */
const SUBJECT = "Status Page Poller — Health";

/**
 * Subcommand: `checkcentral-test`.
 *
 * Sends one real check-in email through the exact same code path the poll
 * loop uses, so the SMTP relay and the CheckCentral check's
 * matching/success conditions can be verified by hand before relying on
 * them. The body is marked as a manual test but still matches the
 * `success_conditions` the real check-in relies on (`STATUS: OK`), so it
 * genuinely exercises the same rule, not a lookalike.
 *
 * Exits 1 with a readable message if CheckCentral is not configured — see
 * checkcentralMailer.ts for exactly which env vars are required together.
 */
export async function runCheckCentralTest(): Promise<void> {
  const config = loadCheckCentralConfig();
  if (!config) {
    process.stderr.write(
      "CheckCentral is not configured — set SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, " +
        "CHECKCENTRAL_FROM_EMAIL and CHECKCENTRAL_TO_EMAIL (see docs/CONFIGURATION.md).\n",
    );
    process.exit(1);
    return;
  }

  const statusLine =
    "STATUS: OK\n\n" +
    "(Manual test via `node dist/src/main.js checkcentral-test` — not an automatic poll cycle.)";

  await sendCheckin(config, SUBJECT, statusLine);
  logger.info({ to: config.toEmail, subject: SUBJECT }, "CheckCentral test check-in sent");
  process.stdout.write(`Sent to ${config.toEmail} via ${config.smtpHost}:${config.smtpPort}.\n`);
}

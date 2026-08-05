import { loadConfig, withDefaults } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { closeStore, createStore } from "../state/store.js";
import { createNotifier } from "../notifiers/index.js";
import { buildReport, REPORT_PERIODS, renderReport, type ReportPeriod } from "../lib/report.js";
import { getMessages } from "../lib/i18n.js";

/**
 * `report [weekly|monthly|quarterly] [--dry-run]`
 *
 * Builds and sends a stability report on demand, for the period that most
 * recently ended. Two uses: verifying the card renders correctly without
 * waiting a week, and re-sending a report after a webhook outage.
 *
 * Unlike the scheduled path this does NOT touch the metadata bookkeeping,
 * so a manual run never suppresses (or triggers) the automatic one.
 */
export async function runReport(periodArg?: string, dryRun = false): Promise<void> {
  const period = resolvePeriod(periodArg);
  if (!period) {
    process.stderr.write(
      `Unknown report period: ${periodArg}\n` +
        `Usage: node dist/src/main.js report [${REPORT_PERIODS.join("|")}] [--dry-run]\n`,
    );
    process.exit(2);
    return;
  }

  const config = loadConfig();
  const providers = config.providers.map((p) => withDefaults(p, config));
  const store = createStore();

  try {
    const report = buildReport(store, providers, period, new Date());
    const rendered = renderReport(report, getMessages(config.language));

    // Always print the report, so a dry run is useful on its own and a
    // real send leaves a record in the container log.
    process.stdout.write(`\n${rendered.title}\n${rendered.summary}\n`);
    for (const row of rendered.rows) {
      process.stdout.write(`  ${row.displayName.padEnd(28)} ${row.line}\n`);
    }
    if (rendered.stillOpenNote) process.stdout.write(`  ${rendered.stillOpenNote}\n`);
    process.stdout.write(`  [${report.from} .. ${report.to})\n\n`);

    if (dryRun) {
      logger.info({ period, label: report.label }, "Dry run — no card sent");
      return;
    }

    const notifier = createNotifier(config, store);
    await notifier.notifyReport(report);
    logger.info(
      { period, label: report.label, incidents: report.totalIncidents },
      "Status report sent",
    );
  } finally {
    closeStore(store);
  }
}

function resolvePeriod(arg?: string): ReportPeriod | null {
  if (!arg) return "weekly";
  const normalized = arg.toLowerCase();
  return (REPORT_PERIODS as readonly string[]).includes(normalized)
    ? (normalized as ReportPeriod)
    : null;
}

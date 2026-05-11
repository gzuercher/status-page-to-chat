import { Cron } from "croner";
import { loadConfig, parseConfig, type AppConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import type { Notifier, RunSummary } from "./lib/types.js";
import { createAdapter } from "./adapters/index.js";
import { createNotifier } from "./notifiers/index.js";
import {
  closeStore,
  createStore,
  diffIncidents,
  getStoredIncidents,
  setMetadata,
  upsertIncident,
  type Store,
} from "./state/store.js";
import { runValidate } from "./cli/validate.js";
import { runHealthcheck } from "./cli/health.js";
import { startApiServer, type LastRunRef } from "./api/server.js";

export const LAST_RUN_METADATA_KEY = "last_run_at";

/**
 * Runs one full poll cycle:
 *   1. Poll all configured providers in parallel
 *   2. Diff against the stored state
 *   3. Send notifications for opened/resolved incidents
 *   4. Persist the new state
 *
 * Errors from individual providers or notifications are isolated — the
 * run never throws, it always produces a structured `run_summary` log
 * entry so the caller can observe the run outcome.
 */
async function runPoll(
  config: AppConfig,
  notifier: Notifier,
  store: Store,
  lastRun?: LastRunRef,
): Promise<void> {
  const startTime = Date.now();

  const summary: RunSummary = {
    providersTotal: config.providers.length,
    providersSucceeded: 0,
    providersFailed: 0,
    incidentsOpen: 0,
    incidentsResolved: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    durationMs: 0,
  };

  try {
    const adapterResults = await Promise.allSettled(
      config.providers.map(async (providerConfig) => {
        const adapter = createAdapter(providerConfig);
        const incidents = await adapter.fetchIncidents();
        return { providerKey: providerConfig.key, incidents };
      }),
    );

    for (const result of adapterResults) {
      if (result.status === "rejected") {
        summary.providersFailed++;
        logger.error({ err: result.reason }, "Adapter failed");
        continue;
      }

      summary.providersSucceeded++;
      const { providerKey, incidents } = result.value;

      const stored = await getStoredIncidents(store, providerKey);
      const diffs = diffIncidents(incidents, stored);

      for (const diff of diffs) {
        if (diff.incident.status === "open") summary.incidentsOpen++;
        if (diff.incident.status === "resolved") summary.incidentsResolved++;

        let notifiedOpened = stored.get(diff.incident.externalId)?.notifiedOpened ?? false;
        let notifiedResolved = stored.get(diff.incident.externalId)?.notifiedResolved ?? false;

        if (diff.action === "notify_opened") {
          try {
            await notifier.notifyOpened(diff.incident);
            notifiedOpened = true;
            summary.notificationsSent++;
          } catch (err) {
            summary.notificationsFailed++;
            logger.error(
              { provider: providerKey, incidentId: diff.incident.externalId, err },
              "Notification (opened) failed",
            );
          }
        }

        if (diff.action === "notify_resolved") {
          try {
            await notifier.notifyResolved(diff.incident);
            notifiedResolved = true;
            summary.notificationsSent++;
          } catch (err) {
            summary.notificationsFailed++;
            logger.error(
              { provider: providerKey, incidentId: diff.incident.externalId, err },
              "Notification (resolved) failed",
            );
          }
        }

        if (diff.action !== "none") {
          await upsertIncident(store, diff.incident, notifiedOpened, notifiedResolved);
        }
      }
    }
  } catch (err) {
    logger.fatal({ err }, "Critical error in poll run");
  } finally {
    summary.durationMs = Date.now() - startTime;
    const completedAt = new Date().toISOString();
    try {
      setMetadata(store, LAST_RUN_METADATA_KEY, completedAt);
    } catch (err) {
      logger.error({ err }, "Failed to persist last_run_at metadata");
    }
    if (lastRun) {
      lastRun.current = { ...summary, completedAt };
    }
    logger.info({ run_summary: summary }, "run_summary");
  }
}

const CRON_EXPRESSION = process.env.POLL_CRON ?? "*/5 * * * *";

/**
 * Container entrypoint: loads config, opens resources, runs one poll
 * immediately (so container logs show activity fast), then schedules
 * subsequent runs. Handles SIGTERM/SIGINT for clean shutdown on
 * container restart.
 */
async function main(): Promise<void> {
  let currentConfig = loadConfig();
  const notifier = createNotifier(currentConfig);
  const store = createStore();
  const lastRun: LastRunRef = { current: null };

  const apiPort = Number(process.env.API_PORT ?? 8080);
  const apiServer = startApiServer({ store, lastRun }, apiPort);

  let isRunning = false;
  let shuttingDown = false;

  const tick = async (): Promise<void> => {
    if (shuttingDown || isRunning) return;
    isRunning = true;
    try {
      // Reload config from disk before each cycle so on-host edits and
      // API-driven changes take effect without a restart. If the file is
      // currently broken, keep running on the last good config.
      const reloaded = parseConfig();
      if (reloaded.ok) {
        currentConfig = reloaded.config;
      } else {
        logger.warn(
          { reason: reloaded.error.message, filePath: reloaded.error.filePath },
          "Config reload failed, continuing with previous config",
        );
      }
      await runPoll(currentConfig, notifier, store, lastRun);
    } finally {
      isRunning = false;
    }
  };

  const job = new Cron(CRON_EXPRESSION, { protect: true }, tick);
  logger.info(
    { cron: CRON_EXPRESSION, nextRun: job.nextRun()?.toISOString() ?? null },
    "Poller scheduled",
  );

  // Kick off an immediate run so the first cycle does not have to wait.
  await tick();

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received, stopping scheduler");
    job.stop();
    apiServer.close();

    const waitForRun = (): void => {
      if (!isRunning) {
        closeStore(store);
        logger.info({}, "Shutdown complete");
        process.exit(0);
      } else {
        setTimeout(waitForRun, 200);
      }
    };
    waitForRun();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const subcommand = process.argv[2];

if (subcommand === "validate") {
  runValidate();
} else if (subcommand === "health") {
  runHealthcheck();
} else if (subcommand === undefined || subcommand === "poll") {
  main().catch((err: unknown) => {
    logger.fatal({ err }, "Poller failed to start");
    process.exit(1);
  });
} else {
  process.stderr.write(
    `Unknown subcommand: ${subcommand}\n` + `Usage: node dist/src/main.js [poll|validate|health]\n`,
  );
  process.exit(2);
}

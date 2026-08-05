import { existsSync, copyFileSync, statSync } from "node:fs";
import { Cron } from "croner";
import { loadConfig, parseConfig, type AppConfig, type ProviderConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import type { AdapterHealthAlert, Notifier, RunSummary } from "./lib/types.js";
import { createAdapter } from "./adapters/index.js";
import { createNotifier } from "./notifiers/index.js";
import { categorizeError } from "./lib/errorCategory.js";
import {
  formatDuration,
  HealthTracker,
  type HealthEvent,
  type PollResult as HealthPollResult,
} from "./lib/healthTracker.js";
import { resolveProviderLogoUrl } from "./lib/logo.js";
import {
  LAST_RUN_METADATA_KEY,
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
import { runDemo } from "./cli/demo.js";
import { startApiServer, type LastRunRef } from "./api/server.js";

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
  healthTracker: HealthTracker,
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

  // Collected for the health tracker after all providers have been
  // polled. One entry per configured provider, success or failure.
  const healthInput: HealthPollResult[] = [];

  try {
    const adapterResults = await Promise.allSettled(
      config.providers.map(async (providerConfig) => {
        const adapter = createAdapter(providerConfig);
        const incidents = await adapter.fetchIncidents();
        return {
          providerKey: providerConfig.key,
          incidents,
          configDrift: adapter.lastConfigDrift,
        };
      }),
    );

    for (let i = 0; i < adapterResults.length; i++) {
      const result = adapterResults[i];
      const providerConfig = config.providers[i];

      if (result.status === "rejected") {
        summary.providersFailed++;
        logger.error({ provider: providerConfig.key, err: result.reason }, "Adapter failed");
        healthInput.push(
          buildHealthInput(providerConfig, {
            kind: "failure",
            errorCategory: categorizeError(result.reason),
          }),
        );
        continue;
      }

      summary.providersSucceeded++;
      const { providerKey } = result.value;
      // Attach the operator-authored service description (config-level, same
      // for every incident of this provider) so the notifier can render it.
      const incidents = providerConfig.description
        ? result.value.incidents.map((inc) => ({
            ...inc,
            description: providerConfig.description,
          }))
        : result.value.incidents;
      healthInput.push(
        buildHealthInput(providerConfig, {
          kind: "success",
          hasIncidents: incidents.length > 0,
          configDrift: result.value.configDrift,
        }),
      );

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
  }

  // Health tracking runs *after* the per-provider loop so suppression
  // can take the full failure ratio into account. Notification errors
  // are isolated per event — a single bad webhook does not block the
  // rest, and never affects the run summary's incident counters.
  try {
    const events = healthTracker.ingest(healthInput);
    for (const event of events) {
      try {
        await notifier.notifyAdapterHealth(buildHealthAlert(event));
        summary.notificationsSent++;
        logger.info(
          { provider: event.providerKey, kind: event.kind },
          "Adapter-health notification sent",
        );
      } catch (err) {
        summary.notificationsFailed++;
        logger.error(
          { provider: event.providerKey, kind: event.kind, err },
          "Adapter-health notification failed",
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "Health tracker raised");
  }

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

function buildHealthInput(
  providerConfig: ProviderConfig,
  outcome: HealthPollResult["outcome"],
): HealthPollResult {
  return {
    providerKey: providerConfig.key,
    providerName: providerConfig.displayName,
    // componentFilter is part of the identity: editing a stale filter is
    // exactly the fix for a half-dead provider, and the counters must
    // restart so the old verdict does not linger.
    fingerprint: [
      providerConfig.adapter,
      providerConfig.baseUrl ?? "",
      `${providerConfig.owner ?? ""}/${providerConfig.repo ?? ""}`,
      (providerConfig.componentFilter ?? []).join("|"),
    ].join(":"),
    logoUrl: resolveProviderLogoUrl({
      explicitLogoUrl: providerConfig.logoUrl,
      baseUrl: providerConfig.baseUrl,
    }),
    outcome,
  };
}

function buildHealthAlert(event: HealthEvent): AdapterHealthAlert {
  switch (event.kind) {
    case "down":
      return {
        kind: "down",
        providerKey: event.providerKey,
        providerName: event.providerName,
        logoUrl: event.logoUrl,
        errorCategory: event.errorCategory,
        durationLabel: formatDuration(event.downForMs),
      };
    case "recovered":
      return {
        kind: "recovered",
        providerKey: event.providerKey,
        providerName: event.providerName,
        logoUrl: event.logoUrl,
        durationLabel: formatDuration(event.downForMs),
      };
    case "halfDead":
      return {
        kind: "halfDead",
        providerKey: event.providerKey,
        providerName: event.providerName,
        logoUrl: event.logoUrl,
        durationLabel: formatDuration(event.sinceMs),
      };
  }
}

const CRON_EXPRESSION = process.env.POLL_CRON ?? "*/5 * * * *";

/**
 * Seeds the providers.yaml at CONFIG_PATH from PROVIDERS_TEMPLATE_PATH
 * on first start. Enables "docker compose up -d with zero host files" —
 * the named state volume starts empty, the template gets copied in once.
 * Subsequent restarts find the file already there and skip.
 *
 * Both env vars are set by the Dockerfile in the container image.
 * Outside the container they are typically unset, and this function is
 * a no-op.
 */
function seedProvidersFileIfMissing(): void {
  const configPath = process.env.CONFIG_PATH;
  const templatePath = process.env.PROVIDERS_TEMPLATE_PATH;
  if (!configPath || !templatePath) return;
  // Treat zero-byte files as "missing" too — a stale empty file left
  // over from a previous deployment would otherwise block the seed and
  // crash the parser with "expected object, received null".
  if (existsSync(configPath)) {
    try {
      if (statSync(configPath).size > 0) return;
    } catch {
      return;
    }
  }
  if (!existsSync(templatePath)) {
    logger.warn(
      { configPath, templatePath },
      "Seed template not found, skipping providers.yaml bootstrap",
    );
    return;
  }
  try {
    copyFileSync(templatePath, configPath);
    logger.info({ from: templatePath, to: configPath }, "Seeded providers.yaml from template");
  } catch (err) {
    logger.error({ err, configPath, templatePath }, "Failed to seed providers.yaml");
  }
}

/**
 * Container entrypoint: loads config, opens resources, runs one poll
 * immediately (so container logs show activity fast), then schedules
 * subsequent runs. Handles SIGTERM/SIGINT for clean shutdown on
 * container restart.
 */
async function main(): Promise<void> {
  seedProvidersFileIfMissing();
  let currentConfig = loadConfig();
  const store = createStore();
  const notifier = createNotifier(currentConfig, store);
  const healthTracker = new HealthTracker();
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
      await runPoll(currentConfig, notifier, store, healthTracker, lastRun);
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
} else if (subcommand === "demo") {
  runDemo(process.argv[3]).catch((err: unknown) => {
    logger.fatal({ err }, "Demo run failed");
    process.exit(1);
  });
} else if (subcommand === undefined || subcommand === "poll") {
  main().catch((err: unknown) => {
    logger.fatal({ err }, "Poller failed to start");
    process.exit(1);
  });
} else {
  process.stderr.write(
    `Unknown subcommand: ${subcommand}\n` +
      `Usage: node dist/src/main.js [poll|validate|health|demo [type]]\n`,
  );
  process.exit(2);
}

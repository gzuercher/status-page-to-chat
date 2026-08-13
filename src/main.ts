import { existsSync, copyFileSync, statSync } from "node:fs";
import { Cron } from "croner";
import {
  loadConfig,
  parseConfig,
  withDefaults,
  type AppConfig,
  type ProviderConfig,
} from "./lib/config.js";
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
import { buildReport, dueReports } from "./lib/report.js";
import {
  LAST_RUN_METADATA_KEY,
  closeStore,
  createStore,
  closeStaleIncidents,
  diffIncidents,
  getOpenIncidentIds,
  getStoredIncidents,
  recordProviderPoll,
  setMetadata,
  upsertIncident,
  type Store,
} from "./state/store.js";
import { runValidate } from "./cli/validate.js";
import { runHealthcheck } from "./cli/health.js";
import { runDemo } from "./cli/demo.js";
import { runReport } from "./cli/report.js";
import { startApiServer, type LastRunRef } from "./api/server.js";

/**
 * After this many days without an upstream update, an incident that is
 * still `open` is closed silently.
 *
 * Not a guess about how long outages last, but about how long a *report*
 * about one stays useful. Two weeks of silence means either the provider
 * never closed it (maintenance banners are the common case) or we lost
 * sight of it; in both cases the row is stale bookkeeping, and an all-clear
 * that late reads as a fresh event rather than a correction.
 *
 * The trade-off is accepted knowingly: a genuine outage running past two
 * weeks without a single update would be retired early. No provider we
 * watch has ever behaved that way, and the alternative — leaving rows open
 * forever — has already produced cards claiming outages that ended in May.
 */
const STALE_INCIDENT_DAYS = 14;

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
    incidentsClosedStale: 0,
    durationMs: 0,
  };

  // Incidents whose last upstream update predates this are retired silently.
  // Computed once per run so every provider uses the same boundary.
  const staleCutoff = new Date(startTime - STALE_INCIDENT_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Collected for the health tracker after all providers have been
  // polled. One entry per configured provider, success or failure.
  const healthInput: HealthPollResult[] = [];

  // Resolve deployment-wide defaults once, so the adapters and the health
  // fingerprints both see the same effective configuration.
  const providers = config.providers.map((p) => withDefaults(p, config));

  try {
    const adapterResults = await Promise.allSettled(
      providers.map(async (providerConfig) => {
        const adapter = createAdapter(providerConfig);
        // Hand the adapter the incidents we already owe a resolution card
        // for, so no filter can drop one mid-flight. See FetchContext.
        const trackedOpenIds = await getOpenIncidentIds(store, providerConfig.key);
        const incidents = await adapter.fetchIncidents({ trackedOpenIds });
        return {
          providerKey: providerConfig.key,
          incidents,
          configDrift: adapter.lastConfigDrift,
          upstreamCount: adapter.lastUpstreamCount ?? null,
        };
      }),
    );

    for (let i = 0; i < adapterResults.length; i++) {
      const result = adapterResults[i];
      const providerConfig = providers[i];

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
      // Observation bookkeeping — the basis for "watched for 40 days,
      // never reported anything" in the periodic report.
      try {
        recordProviderPoll(
          store,
          providerKey,
          new Date().toISOString(),
          result.value.upstreamCount,
        );
      } catch (err) {
        logger.error({ provider: providerKey, err }, "Failed to record provider poll");
      }
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

      // Retire incidents the upstream stopped updating long ago. Safe to do
      // here because this branch only runs on a successful poll — a broken
      // adapter must not quietly close what it can no longer see.
      try {
        const stale = await closeStaleIncidents(store, providerKey, staleCutoff);
        for (const incident of stale) {
          logger.info(
            {
              provider: providerKey,
              incidentId: incident.externalId,
              lastUpdate: incident.updatedAt,
              title: incident.title,
            },
            "Closed stale incident without notifying",
          );
        }
        summary.incidentsClosedStale += stale.length;
      } catch (err) {
        logger.error({ provider: providerKey, err }, "Failed to close stale incidents");
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

  // Periodic reports run last: they read the state the cycle just wrote,
  // so a report covering a period that ended minutes ago includes
  // everything from this run. Isolated like health events — a failing
  // report must never affect incident notification.
  //
  // Set REPORTS_SCHEDULER=external when an outside scheduler (host cron)
  // triggers `main.js report` instead. Leaving both enabled would send
  // every report twice.
  try {
    if (process.env.REPORTS_SCHEDULER === "external") {
      throw new SkipReports();
    }
    for (const period of dueReports(store, new Date())) {
      try {
        const report = buildReport(store, providers, period, new Date());
        await notifier.notifyReport(report);
        summary.notificationsSent++;
        logger.info(
          { period, label: report.label, incidents: report.totalIncidents },
          "Status report sent",
        );
      } catch (err) {
        summary.notificationsFailed++;
        logger.error({ period, err }, "Status report failed");
      }
    }
  } catch (err) {
    if (!(err instanceof SkipReports)) logger.error({ err }, "Report scheduling raised");
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

/** Signals that report scheduling is delegated to an external scheduler. */
class SkipReports extends Error {}

function buildHealthInput(
  providerConfig: ProviderConfig,
  outcome: HealthPollResult["outcome"],
): HealthPollResult {
  return {
    providerKey: providerConfig.key,
    providerName: providerConfig.displayName,
    // componentFilter is part of the identity: editing a stale filter is
    // exactly the fix for a half-dead provider, and the counters must
    // restart so the old verdict does not linger. minImpact likewise
    // changes what "the provider reports nothing" means.
    fingerprint: [
      providerConfig.adapter,
      providerConfig.baseUrl ?? "",
      `${providerConfig.owner ?? ""}/${providerConfig.repo ?? ""}`,
      (providerConfig.componentFilter ?? []).join("|"),
      providerConfig.minImpact ?? "",
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
} else if (subcommand === "report") {
  runReport(
    process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined,
    process.argv.includes("--dry-run"),
  ).catch((err: unknown) => {
    logger.fatal({ err }, "Report run failed");
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
      `Usage: node dist/src/main.js [poll|validate|health|demo [type]|report [period] [--dry-run]]\n`,
  );
  process.exit(2);
}

import { app, type Timer } from "@azure/functions";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type { RunSummary } from "../lib/types.js";
import { createAdapter } from "../adapters/index.js";
import { createNotifier } from "../notifiers/index.js";
import {
  createTableClient,
  diffIncidents,
  getStoredIncidents,
  upsertIncident,
} from "../state/tableStore.js";

/**
 * Timer Trigger: runs every 5 minutes.
 * Orchestrates the entire poll run:
 * 1. Load configuration
 * 2. Poll providers in parallel
 * 3. Diff against stored state
 * 4. Send notifications
 * 5. Update state
 */
async function poll(_timer: Timer): Promise<void> {
  const startTime = Date.now();

  const summary: RunSummary = {
    providersTotal: 0,
    providersSucceeded: 0,
    providersFailed: 0,
    incidentsOpen: 0,
    incidentsResolved: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    durationMs: 0,
  };

  try {
    // 1. Load configuration
    const config = loadConfig();
    summary.providersTotal = config.providers.length;

    // 2. Initialise notifier and table client
    const notifier = createNotifier(config);
    const tableClient = await createTableClient();

    // 3. Poll providers in parallel (with error isolation)
    const adapterResults = await Promise.allSettled(
      config.providers.map(async (providerConfig) => {
        const adapter = createAdapter(providerConfig);
        const incidents = await adapter.fetchIncidents();
        return { providerKey: providerConfig.key, incidents };
      }),
    );

    // 4. Process results
    for (const result of adapterResults) {
      if (result.status === "rejected") {
        summary.providersFailed++;
        logger.error({ err: result.reason }, "Adapter failed");
        continue;
      }

      summary.providersSucceeded++;
      const { providerKey, incidents } = result.value;

      // Diff against stored state
      const stored = await getStoredIncidents(tableClient, providerKey);
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
            // Still write to state, but notifiedOpened remains false
            // → will be retried in the next run
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

        // Update state (also for "none" to refresh updatedAt)
        if (diff.action !== "none") {
          await upsertIncident(tableClient, diff.incident, notifiedOpened, notifiedResolved);
        }
      }
    }
  } catch (err) {
    logger.fatal({ err }, "Critical error in poll run");
  } finally {
    summary.durationMs = Date.now() - startTime;
    logger.info({ run_summary: summary }, "run_summary");
  }
}

app.timer("poll", {
  schedule: "0 */5 * * * *",
  handler: poll,
});

export { poll };

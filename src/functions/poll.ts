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
 * Timer Trigger: Laeuft alle 5 Minuten.
 * Orchestriert den gesamten Durchlauf:
 * 1. Konfiguration laden
 * 2. Provider parallel abfragen
 * 3. State abgleichen
 * 4. Benachrichtigungen senden
 * 5. State aktualisieren
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
    // 1. Konfiguration laden
    const config = loadConfig();
    summary.providersTotal = config.providers.length;

    // 2. Notifier und Table Client initialisieren
    const notifier = createNotifier(config);
    const tableClient = await createTableClient();

    // 3. Provider parallel abfragen (mit Fehlerisolation)
    const adapterResults = await Promise.allSettled(
      config.providers.map(async (providerConfig) => {
        const adapter = createAdapter(providerConfig);
        const incidents = await adapter.fetchIncidents();
        return { providerKey: providerConfig.key, incidents };
      }),
    );

    // 4. Ergebnisse verarbeiten
    for (const result of adapterResults) {
      if (result.status === "rejected") {
        summary.providersFailed++;
        logger.error({ err: result.reason }, "Adapter fehlgeschlagen");
        continue;
      }

      summary.providersSucceeded++;
      const { providerKey, incidents } = result.value;

      // State abgleichen
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
              "Benachrichtigung (opened) fehlgeschlagen",
            );
            // Incident trotzdem speichern, aber notifiedOpened bleibt false
            // → wird im naechsten Durchlauf erneut versucht
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
              "Benachrichtigung (resolved) fehlgeschlagen",
            );
          }
        }

        // State aktualisieren (auch bei "none", um updatedAt zu aktualisieren)
        if (diff.action !== "none") {
          await upsertIncident(tableClient, diff.incident, notifiedOpened, notifiedResolved);
        }
      }
    }
  } catch (err) {
    logger.fatal({ err }, "Kritischer Fehler im Poll-Durchlauf");
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

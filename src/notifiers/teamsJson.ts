import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { AdapterHealthAlert, Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Current version of the JSON envelope. Bump on breaking changes so the
 * downstream renderer (e.g. an Azure Logic App that builds the Adaptive
 * Card centrally) can branch on it.
 */
const SCHEMA_VERSION = 1;

/** Envelope for an incident state change. */
type IncidentEvent = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "status-page-to-chat";
  event: "incident.opened" | "incident.resolved";
  incident: NormalizedIncident;
};

/** Envelope for an adapter-health alert. */
type AdapterEvent = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "status-page-to-chat";
  event: `adapter.${AdapterHealthAlert["kind"]}`;
  alert: AdapterHealthAlert;
};

/**
 * Notifier that POSTs the raw, normalized event as JSON instead of a
 * finished chat card. Same transport as {@link TeamsNotifier} (a webhook
 * URL), but the payload is data, not presentation: the consumer — typically
 * an Azure Logic App — owns the layout and renders the Adaptive Card from a
 * central template.
 *
 * The incident `title` is emitted verbatim (the source language). Unlike
 * {@link TeamsNotifier}, this notifier does NOT machine-translate it — in
 * JSON mode presentation and any translation belong to the central renderer.
 */
export class TeamsJsonNotifier implements Notifier {
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async notifyOpened(incident: NormalizedIncident): Promise<void> {
    const payload: IncidentEvent = {
      schemaVersion: SCHEMA_VERSION,
      source: "status-page-to-chat",
      event: "incident.opened",
      incident,
    };
    await this.sendWithRetry(payload, {
      provider: incident.providerKey,
      type: "opened",
      incidentId: incident.externalId,
    });
  }

  async notifyResolved(incident: NormalizedIncident): Promise<void> {
    const payload: IncidentEvent = {
      schemaVersion: SCHEMA_VERSION,
      source: "status-page-to-chat",
      event: "incident.resolved",
      incident,
    };
    await this.sendWithRetry(payload, {
      provider: incident.providerKey,
      type: "resolved",
      incidentId: incident.externalId,
    });
  }

  async notifyAdapterHealth(alert: AdapterHealthAlert): Promise<void> {
    const payload: AdapterEvent = {
      schemaVersion: SCHEMA_VERSION,
      source: "status-page-to-chat",
      event: `adapter.${alert.kind}`,
      alert,
    };
    await this.sendWithRetry(payload, {
      provider: alert.providerKey,
      type: `adapter-${alert.kind}`,
    });
  }

  private async sendWithRetry(
    payload: IncidentEvent | AdapterEvent,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await httpPost(this.webhookUrl, payload);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.body}`);
      }

      logger.info(context, "Teams JSON payload sent");
    } catch (firstError) {
      logger.warn({ ...context, err: firstError }, "Teams JSON payload failed, retrying in 2s");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        const response = await httpPost(this.webhookUrl, payload);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Retry failed: HTTP ${response.status}: ${response.body}`);
        }
        logger.info(context, "Teams JSON payload sent (after retry)");
      } catch (retryError) {
        logger.error({ ...context, err: retryError }, "Teams JSON payload failed on retry");
        throw retryError;
      }
    }
  }
}

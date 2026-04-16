import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Microsoft Teams Adaptive Card Payload.
 */
function buildAdaptiveCard(
  incident: NormalizedIncident,
  type: "opened" | "resolved",
): Record<string, unknown> {
  const isOpened = type === "opened";
  const emoji = isOpened ? "\u26a0\ufe0f" : "\u2705";
  const actionText = isOpened
    ? `hat eine Stoerung zu "${incident.title}" gemeldet`
    : `hat die Behebung der Stoerung zu "${incident.title}" gemeldet`;

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: `${emoji} **${incident.displayName}**`,
              size: "Medium",
              weight: "Bolder",
            },
            {
              type: "TextBlock",
              text: actionText,
              wrap: true,
            },
          ],
          actions: [
            {
              type: "Action.OpenUrl",
              title: "Details anzeigen",
              url: incident.url,
            },
          ],
        },
      },
    ],
  };
}

/**
 * Notifier fuer Microsoft Teams Incoming Webhooks.
 */
export class TeamsNotifier implements Notifier {
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async notifyOpened(incident: NormalizedIncident): Promise<void> {
    await this.send(incident, "opened");
  }

  async notifyResolved(incident: NormalizedIncident): Promise<void> {
    await this.send(incident, "resolved");
  }

  private async send(incident: NormalizedIncident, type: "opened" | "resolved"): Promise<void> {
    const payload = buildAdaptiveCard(incident, type);

    try {
      const response = await httpPost(this.webhookUrl, payload);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.body}`);
      }

      logger.info(
        { provider: incident.providerKey, type, incidentId: incident.externalId },
        "Teams Nachricht gesendet",
      );
    } catch (firstError) {
      logger.warn(
        { provider: incident.providerKey, type, err: firstError },
        "Teams Nachricht fehlgeschlagen, Retry in 2s",
      );

      // Einmaliger Retry mit Backoff
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await httpPost(this.webhookUrl, payload);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Retry fehlgeschlagen: HTTP ${response.status}: ${response.body}`);
      }

      logger.info(
        { provider: incident.providerKey, type, incidentId: incident.externalId },
        "Teams Nachricht gesendet (nach Retry)",
      );
    }
  }
}

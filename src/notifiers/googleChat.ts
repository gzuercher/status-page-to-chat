import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Google Chat Card v2 Payload.
 */
function buildCard(
  incident: NormalizedIncident,
  type: "opened" | "resolved",
): Record<string, unknown> {
  const isOpened = type === "opened";
  const emoji = isOpened ? "\u26a0\ufe0f" : "\u2705";
  const actionText = isOpened
    ? `hat eine Stoerung zu "${incident.title}" gemeldet`
    : `hat die Behebung der Stoerung zu "${incident.title}" gemeldet`;

  return {
    cardsV2: [
      {
        cardId: `incident-${incident.externalId}`,
        card: {
          header: {
            title: `${emoji} ${incident.displayName}`,
            subtitle: actionText,
          },
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Details anzeigen",
                        onClick: {
                          openLink: { url: incident.url },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/**
 * Notifier fuer Google Chat Incoming Webhooks.
 */
export class GoogleChatNotifier implements Notifier {
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
    const payload = buildCard(incident, type);

    try {
      const response = await httpPost(this.webhookUrl, payload);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.body}`);
      }

      logger.info(
        { provider: incident.providerKey, type, incidentId: incident.externalId },
        "Google Chat Nachricht gesendet",
      );
    } catch (firstError) {
      logger.warn(
        { provider: incident.providerKey, type, err: firstError },
        "Google Chat Nachricht fehlgeschlagen, Retry in 2s",
      );

      // Einmaliger Retry mit Backoff
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await httpPost(this.webhookUrl, payload);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Retry fehlgeschlagen: HTTP ${response.status}: ${response.body}`);
      }

      logger.info(
        { provider: incident.providerKey, type, incidentId: incident.externalId },
        "Google Chat Nachricht gesendet (nach Retry)",
      );
    }
  }
}

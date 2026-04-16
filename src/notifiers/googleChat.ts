import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Builds a Google Chat Card v2 payload.
 */
function buildCard(
  incident: NormalizedIncident,
  type: "opened" | "resolved",
): Record<string, unknown> {
  const isOpened = type === "opened";
  const emoji = isOpened ? "\u26a0\ufe0f" : "\u2705";
  const actionText = isOpened
    ? `has reported an incident: "${incident.title}"`
    : `has resolved the incident: "${incident.title}"`;

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
                        text: "View details",
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
 * Notifier for Google Chat Incoming Webhooks.
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
        "Google Chat message sent",
      );
    } catch (firstError) {
      logger.warn(
        { provider: incident.providerKey, type, err: firstError },
        "Google Chat message failed, retrying in 2s",
      );

      // Single retry with backoff
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await httpPost(this.webhookUrl, payload);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Retry failed: HTTP ${response.status}: ${response.body}`);
      }

      logger.info(
        { provider: incident.providerKey, type, incidentId: incident.externalId },
        "Google Chat message sent (after retry)",
      );
    }
  }
}

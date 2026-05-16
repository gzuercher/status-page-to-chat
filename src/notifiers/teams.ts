import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Builds a Microsoft Teams Adaptive Card payload.
 */
function buildAdaptiveCard(
  incident: NormalizedIncident,
  type: "opened" | "resolved",
): Record<string, unknown> {
  const isOpened = type === "opened";
  const emoji = isOpened ? "\u26a0\ufe0f" : "\u2705";
  const actionText = isOpened
    ? `has reported an incident: "${incident.title}"`
    : `has resolved the incident: "${incident.title}"`;
  const logoUrl = incident.logoUrl;

  // Fixed pixel width keeps logos visually roughly equal across providers,
  // even when the underlying favicon dimensions differ.
  const titleBlock = {
    type: "TextBlock",
    text: `${emoji} **${incident.displayName}**`,
    size: "Medium",
    weight: "Bolder",
    wrap: true,
    verticalContentAlignment: "Center",
  };

  const header = logoUrl
    ? {
        type: "ColumnSet",
        columns: [
          {
            type: "Column",
            width: "auto",
            verticalContentAlignment: "Center",
            items: [
              {
                type: "Image",
                url: logoUrl,
                altText: `${incident.displayName} logo`,
                width: "24px",
                height: "24px",
              },
            ],
          },
          {
            type: "Column",
            width: "stretch",
            verticalContentAlignment: "Center",
            items: [titleBlock],
          },
        ],
      }
    : titleBlock;

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
            header,
            {
              type: "TextBlock",
              text: actionText,
              wrap: true,
            },
          ],
          actions: [
            {
              type: "Action.OpenUrl",
              title: "View details",
              url: incident.url,
            },
          ],
        },
      },
    ],
  };
}

/**
 * Notifier for Microsoft Teams Incoming Webhooks.
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
        "Teams message sent",
      );
    } catch (firstError) {
      logger.warn(
        { provider: incident.providerKey, type, err: firstError },
        "Teams message failed, retrying in 2s",
      );

      // Single retry with backoff
      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        const response = await httpPost(this.webhookUrl, payload);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Retry failed: HTTP ${response.status}: ${response.body}`);
        }
        logger.info(
          { provider: incident.providerKey, type, incidentId: incident.externalId },
          "Teams message sent (after retry)",
        );
      } catch (retryError) {
        logger.error(
          {
            provider: incident.providerKey,
            type,
            incidentId: incident.externalId,
            err: retryError,
          },
          "Teams message failed on retry",
        );
        throw retryError;
      }
    }
  }
}

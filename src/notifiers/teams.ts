import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { AdapterHealthAlert, Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Builds a Microsoft Teams Adaptive Card payload.
 */
function buildAdaptiveCard(
  incident: NormalizedIncident,
  type: "opened" | "resolved",
): Record<string, unknown> {
  const isOpened = type === "opened";
  const emoji = isOpened ? "⚠️" : "✅";
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
 * Builds a system-level "adapter health" card. Visually distinct from
 * incident cards: branded with status-page-to-chat (the watcher) in the
 * header, the affected provider relegated to the body. Uses the
 * wrench/tooling emoji to signal "tooling problem, not service outage".
 */
function buildAdapterHealthCard(alert: AdapterHealthAlert): Record<string, unknown> {
  const headerEmoji = alert.kind === "recovered" ? "\u{1f6e0}️✅" : "\u{1f6e0}️";

  const bodyText = renderAdapterHealthBody(alert);

  const providerLine = alert.logoUrl
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
                url: alert.logoUrl,
                altText: `${alert.providerName} logo`,
                width: "16px",
                height: "16px",
              },
            ],
          },
          {
            type: "Column",
            width: "stretch",
            verticalContentAlignment: "Center",
            items: [
              {
                type: "TextBlock",
                text: alert.providerName,
                wrap: true,
                weight: "Bolder",
                isSubtle: true,
              },
            ],
          },
        ],
      }
    : {
        type: "TextBlock",
        text: alert.providerName,
        wrap: true,
        weight: "Bolder",
        isSubtle: true,
      };

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
              text: `${headerEmoji} **status-page-to-chat**`,
              size: "Medium",
              weight: "Bolder",
              wrap: true,
            },
            providerLine,
            {
              type: "TextBlock",
              text: bodyText,
              wrap: true,
              isSubtle: true,
            },
          ],
        },
      },
    ],
  };
}

function renderAdapterHealthBody(alert: AdapterHealthAlert): string {
  switch (alert.kind) {
    case "down":
      return `Unable to poll for the last ${alert.durationLabel}. ${alert.errorCategory}.`;
    case "recovered":
      return `Polling resumed (was down for ${alert.durationLabel}).`;
    case "halfDead":
      return `Polled cleanly for ${alert.durationLabel} but never returned any incident — check the URL.`;
  }
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
    const payload = buildAdaptiveCard(incident, "opened");
    await this.sendWithRetry(payload, {
      provider: incident.providerKey,
      type: "opened",
      incidentId: incident.externalId,
    });
  }

  async notifyResolved(incident: NormalizedIncident): Promise<void> {
    const payload = buildAdaptiveCard(incident, "resolved");
    await this.sendWithRetry(payload, {
      provider: incident.providerKey,
      type: "resolved",
      incidentId: incident.externalId,
    });
  }

  async notifyAdapterHealth(alert: AdapterHealthAlert): Promise<void> {
    const payload = buildAdapterHealthCard(alert);
    await this.sendWithRetry(payload, {
      provider: alert.providerKey,
      type: `adapter-${alert.kind}`,
    });
  }

  private async sendWithRetry(
    payload: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await httpPost(this.webhookUrl, payload);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.body}`);
      }

      logger.info(context, "Teams message sent");
    } catch (firstError) {
      logger.warn({ ...context, err: firstError }, "Teams message failed, retrying in 2s");

      // Single retry with backoff
      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        const response = await httpPost(this.webhookUrl, payload);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Retry failed: HTTP ${response.status}: ${response.body}`);
        }
        logger.info(context, "Teams message sent (after retry)");
      } catch (retryError) {
        logger.error({ ...context, err: retryError }, "Teams message failed on retry");
        throw retryError;
      }
    }
  }
}

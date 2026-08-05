import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { AdapterHealthAlert, Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Builds a Google Chat Card v2 payload for an incident.
 */
function buildCard(
  incident: NormalizedIncident,
  type: "opened" | "resolved",
): Record<string, unknown> {
  const isOpened = type === "opened";
  const emoji = isOpened ? "⚠️" : "✅";
  const actionText = isOpened
    ? `has reported an incident: "${incident.title}"`
    : `has resolved the incident: "${incident.title}"`;

  const logoUrl = incident.logoUrl;

  return {
    cardsV2: [
      {
        cardId: `incident-${incident.externalId}`,
        card: {
          header: {
            title: `${emoji} ${incident.displayName}`,
            subtitle: actionText,
            ...(logoUrl ? { imageUrl: logoUrl, imageType: "SQUARE" } : {}),
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
 * Builds a Google Chat Card v2 payload for an adapter-health alert.
 * Visually distinct from incident cards: header carries the system name
 * ("status-page-to-chat") with the wrench emoji, the provider sits in
 * the body so it's clear who reported the problem.
 */
function buildAdapterHealthCard(alert: AdapterHealthAlert): Record<string, unknown> {
  const headerEmoji = alert.kind === "recovered" ? "\u{1f6e0}️✅" : "\u{1f6e0}️";
  const subtitle = renderAdapterHealthSubtitle(alert);

  return {
    cardsV2: [
      {
        cardId: `adapter-health-${alert.providerKey}-${alert.kind}`,
        card: {
          header: {
            title: `${headerEmoji} status-page-to-chat`,
            subtitle,
          },
          sections: [
            {
              widgets: [
                {
                  decoratedText: {
                    text: `<b>${alert.providerName}</b>`,
                    ...(alert.logoUrl
                      ? { startIcon: { iconUrl: alert.logoUrl, altText: alert.providerName } }
                      : {}),
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

function renderAdapterHealthSubtitle(alert: AdapterHealthAlert): string {
  switch (alert.kind) {
    case "down":
      return `Unable to poll for the last ${alert.durationLabel}. ${alert.errorCategory}.`;
    case "recovered":
      return `Polling resumed (was down for ${alert.durationLabel}).`;
    case "halfDead":
      return `Polled cleanly for ${alert.durationLabel}, but no reported incident matched the filter — check componentFilter and URL.`;
  }
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
    const payload = buildCard(incident, "opened");
    await this.send(payload, {
      provider: incident.providerKey,
      type: "opened",
      incidentId: incident.externalId,
    });
  }

  async notifyResolved(incident: NormalizedIncident): Promise<void> {
    const payload = buildCard(incident, "resolved");
    await this.send(payload, {
      provider: incident.providerKey,
      type: "resolved",
      incidentId: incident.externalId,
    });
  }

  async notifyAdapterHealth(alert: AdapterHealthAlert): Promise<void> {
    const payload = buildAdapterHealthCard(alert);
    await this.send(payload, {
      provider: alert.providerKey,
      type: `adapter-${alert.kind}`,
    });
  }

  /**
   * Posts the payload once. Retry/backoff (429/5xx/network) lives in the
   * shared httpClient; on a final non-2xx or network failure this throws, and
   * the poll loop leaves the incident un-notified so the next cycle retries.
   */
  private async send(
    payload: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    const response = await httpPost(this.webhookUrl, payload);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: ${response.body}`);
    }
    logger.info(context, "Google Chat message sent");
  }
}

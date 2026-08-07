import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { getMessages } from "../lib/i18n.js";
import { renderReport, type StatusReport } from "../lib/report.js";

/** Providers listed in a report ranking before truncation. */
const MAX_REPORT_ROWS = 10;
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
      return `Polled cleanly for ${alert.durationLabel}, but componentFilter no longer matches any component the provider publishes — check the names.`;
  }
}

/**
 * Builds the periodic stability report card.
 *
 * Google Chat is not localised (see the module header) — the English
 * message bundle is used deliberately, matching the incident cards.
 */
function buildReportCard(report: StatusReport): Record<string, unknown> {
  const rendered = renderReport(report, getMessages("en"));
  const shown = rendered.rows.slice(0, MAX_REPORT_ROWS);
  const hidden = rendered.rows.length - shown.length;

  const widgets: Record<string, unknown>[] = [
    { textParagraph: { text: rendered.summary } },
    ...shown.map((row) => ({
      decoratedText: { topLabel: row.displayName, text: row.line },
    })),
  ];
  if (hidden > 0) {
    widgets.push({ textParagraph: { text: `<i>and ${hidden} more services</i>` } });
  }
  if (rendered.silentRows.length > 0) {
    widgets.push({ textParagraph: { text: `<b>${rendered.silentHeading}</b>` } });
    for (const row of rendered.silentRows) {
      widgets.push({ decoratedText: { topLabel: row.displayName, text: row.line } });
    }
  }
  if (rendered.stillOpenNote) {
    widgets.push({ textParagraph: { text: `<i>${rendered.stillOpenNote}</i>` } });
  }

  return {
    cardsV2: [
      {
        cardId: `report-${report.period}-${report.label}`,
        card: {
          header: { title: `\u{1f4ca} ${rendered.title}`, subtitle: rendered.rankingHeading ?? "" },
          sections: [{ widgets }],
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

  async notifyReport(report: StatusReport): Promise<void> {
    const payload = buildReportCard(report);
    await this.send(payload, { type: `report-${report.period}`, label: report.label });
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

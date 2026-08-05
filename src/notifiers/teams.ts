import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { getMessages, type Locale, type Messages } from "../lib/i18n.js";
import type { Translator } from "../lib/translator.js";
import { renderReport, type StatusReport } from "../lib/report.js";
import type { AdapterHealthAlert, Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Providers listed in a report's ranking before it is truncated. Keeps a
 * quarterly card readable; the summary line still names the true totals.
 */
const MAX_REPORT_ROWS = 10;

/**
 * Formats an ISO-8601 timestamp as `DD.MM.YYYY HH:mm UTC`. Uses UTC
 * components so the output is deterministic regardless of the host
 * timezone. Falls back to the raw string if the input is unparseable.
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())} UTC`;
}

/**
 * Builds a Microsoft Teams Adaptive Card payload for an incident.
 *
 * The card uses the full message width (`msteams.width: "Full"`) and wraps
 * its content in a colour-styled Container — `attention` (red) for an open
 * incident, `good` (green) for a resolved one — so the open/resolved state
 * is unmistakable at a glance. The provider-supplied title is machine-
 * translated; all other text comes from the localised message bundle.
 */
async function buildAdaptiveCard(
  incident: NormalizedIncident,
  type: "opened" | "resolved",
  translator: Translator,
  messages: Messages,
): Promise<Record<string, unknown>> {
  const isOpened = type === "opened";
  const emoji = isOpened ? "⚠️" : "✅";
  const statusText = isOpened ? messages.statusOpened : messages.statusResolved;
  const accentColor = isOpened ? "attention" : "good";
  const containerStyle = isOpened ? "attention" : "good";

  const localizedTitle = await translator.translate(incident.title);
  const logoUrl = incident.logoUrl;

  // Header row: logo (optional) · provider name (stretch) · status badge.
  const headerColumns: Record<string, unknown>[] = [];
  if (logoUrl) {
    headerColumns.push({
      type: "Column",
      width: "auto",
      verticalContentAlignment: "Center",
      items: [
        {
          type: "Image",
          url: logoUrl,
          altText: `${incident.displayName} logo`,
          width: "28px",
          height: "28px",
        },
      ],
    });
  }
  headerColumns.push({
    type: "Column",
    width: "stretch",
    verticalContentAlignment: "Center",
    items: [
      {
        type: "TextBlock",
        text: `**${incident.displayName}**`,
        size: "Medium",
        weight: "Bolder",
        wrap: true,
      },
    ],
  });
  headerColumns.push({
    type: "Column",
    width: "auto",
    verticalContentAlignment: "Center",
    items: [
      {
        type: "TextBlock",
        text: `${emoji} ${statusText}`,
        weight: "Bolder",
        color: accentColor,
        wrap: true,
        horizontalAlignment: "Right",
      },
    ],
  });

  const containerItems: Record<string, unknown>[] = [{ type: "ColumnSet", columns: headerColumns }];

  if (incident.description) {
    containerItems.push({
      type: "TextBlock",
      text: incident.description,
      wrap: true,
      isSubtle: true,
      spacing: "Small",
    });
  }

  containerItems.push({
    type: "TextBlock",
    text: localizedTitle,
    wrap: true,
    weight: "Bolder",
    spacing: "Medium",
  });

  containerItems.push({
    type: "FactSet",
    spacing: "Small",
    facts: [{ title: messages.since, value: formatTimestamp(incident.startedAt) }],
  });

  // The Teams Workflows webhook ("Post card in a chat or channel") expects
  // the BARE Adaptive Card as the request body — NOT the legacy connector's
  // `{ type: "message", attachments: [{ content }] }` wrapper. Sending the
  // wrapper makes the flow post an empty card. See docs/CONFIGURATION.md.
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body: [
      {
        type: "Container",
        style: containerStyle,
        items: containerItems,
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: messages.viewDetails,
        url: incident.url,
      },
    ],
  };
}

/**
 * Builds a system-level "adapter health" card. Visually distinct from
 * incident cards: branded with status-page-to-chat (the watcher) in the
 * header, the affected provider relegated to the body. Uses the
 * wrench/tooling emoji to signal "tooling problem, not service outage",
 * plus a colour-styled Container (red while down, green on recovery).
 */
function buildAdapterHealthCard(
  alert: AdapterHealthAlert,
  messages: Messages,
): Record<string, unknown> {
  const recovered = alert.kind === "recovered";
  const headerEmoji = recovered ? "\u{1f6e0}️✅" : "\u{1f6e0}️";
  const containerStyle = recovered ? "good" : "attention";

  const bodyText = renderAdapterHealthBody(alert, messages);

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

  // Bare Adaptive Card — see the note in buildAdaptiveCard().
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body: [
      {
        type: "Container",
        style: containerStyle,
        items: [
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
            spacing: "Small",
          },
        ],
      },
    ],
  };
}

/**
 * Builds the periodic stability report card.
 *
 * Styled neutrally (`emphasis`, not `attention`/`good`): a report is
 * information, and colouring it red because it counts past outages would
 * make a routine summary look like an active incident.
 *
 * The ranking is capped — a quarter with two dozen affected providers
 * would otherwise produce a card nobody scrolls through. The summary line
 * always states the true totals, so the cap hides no information that
 * changes the conclusion.
 */
function buildReportCard(report: StatusReport, messages: Messages): Record<string, unknown> {
  const rendered = renderReport(report, messages);
  const shown = rendered.rows.slice(0, MAX_REPORT_ROWS);
  const hidden = rendered.rows.length - shown.length;

  const rankingItems =
    shown.length > 0
      ? [
          {
            type: "TextBlock",
            text: rendered.rankingHeading ?? "",
            weight: "Bolder",
            wrap: true,
            spacing: "Medium",
          },
          {
            type: "FactSet",
            facts: shown.map((row) => ({ title: row.displayName, value: row.line })),
          },
        ]
      : [];

  const silentItems =
    rendered.silentRows.length > 0
      ? [
          {
            type: "TextBlock",
            text: rendered.silentHeading ?? "",
            weight: "Bolder",
            wrap: true,
            spacing: "Medium",
          },
          {
            type: "FactSet",
            facts: rendered.silentRows.map((row) => ({
              title: row.displayName,
              value: row.line,
            })),
          },
        ]
      : [];

  const footnotes = [
    ...(hidden > 0
      ? [
          {
            type: "TextBlock",
            text: messages.reportMoreProviders(hidden),
            wrap: true,
            isSubtle: true,
            size: "Small",
          },
        ]
      : []),
    ...(rendered.stillOpenNote
      ? [
          {
            type: "TextBlock",
            text: rendered.stillOpenNote,
            wrap: true,
            isSubtle: true,
            size: "Small",
          },
        ]
      : []),
  ];

  // Bare Adaptive Card — see the note in buildAdaptiveCard().
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body: [
      {
        type: "Container",
        style: "emphasis",
        items: [
          {
            type: "TextBlock",
            text: `\u{1f4ca} **${rendered.title}**`,
            size: "Medium",
            weight: "Bolder",
            wrap: true,
          },
          {
            type: "TextBlock",
            text: rendered.summary,
            wrap: true,
            spacing: "Small",
          },
          ...rankingItems,
          ...silentItems,
          ...footnotes,
        ],
      },
    ],
  };
}

function renderAdapterHealthBody(alert: AdapterHealthAlert, messages: Messages): string {
  switch (alert.kind) {
    case "down":
      return messages.healthDown(alert.durationLabel, messages.errorCategory(alert.errorCategory));
    case "recovered":
      return messages.healthRecovered(alert.durationLabel);
    case "halfDead":
      return messages.healthHalfDead(alert.durationLabel);
  }
}

/**
 * Notifier for Microsoft Teams Incoming Webhooks.
 */
export class TeamsNotifier implements Notifier {
  private readonly webhookUrl: string;
  private readonly translator: Translator;
  private readonly messages: Messages;

  constructor(webhookUrl: string, translator: Translator, locale: Locale) {
    this.webhookUrl = webhookUrl;
    this.translator = translator;
    this.messages = getMessages(locale);
  }

  async notifyOpened(incident: NormalizedIncident): Promise<void> {
    const payload = await buildAdaptiveCard(incident, "opened", this.translator, this.messages);
    await this.send(payload, {
      provider: incident.providerKey,
      type: "opened",
      incidentId: incident.externalId,
    });
  }

  async notifyResolved(incident: NormalizedIncident): Promise<void> {
    const payload = await buildAdaptiveCard(incident, "resolved", this.translator, this.messages);
    await this.send(payload, {
      provider: incident.providerKey,
      type: "resolved",
      incidentId: incident.externalId,
    });
  }

  async notifyAdapterHealth(alert: AdapterHealthAlert): Promise<void> {
    const payload = buildAdapterHealthCard(alert, this.messages);
    await this.send(payload, {
      provider: alert.providerKey,
      type: `adapter-${alert.kind}`,
    });
  }

  async notifyReport(report: StatusReport): Promise<void> {
    const payload = buildReportCard(report, this.messages);
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
    logger.info(context, "Teams message sent");
  }
}

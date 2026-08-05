import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { getMessages, type Locale } from "../lib/i18n.js";
import { renderReport, type StatusReport } from "../lib/report.js";
import type { AdapterHealthAlert, Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Current version of the JSON envelope. Bump on breaking changes so the
 * downstream renderer (e.g. an Azure Logic App that builds the Adaptive
 * Card centrally) can branch on it.
 *
 * v2: stable schema — every optional field is ALWAYS present (`null` when
 *     unset) so the consumer sees the same keys across all variants; added
 *     `severity` and `language`.
 */
const SCHEMA_VERSION = 2;

/** Coarse severity so the renderer can pick colour/emoji without re-deriving from `event`. */
type Severity = "problem" | "ok";

/**
 * Incident as emitted on the wire. Mirrors {@link NormalizedIncident} but
 * pins every optional field to a concrete `null` when unset — a stable key
 * set matters for template engines (Logic Apps) that choke on missing keys.
 */
type JsonIncident = {
  externalId: string;
  providerKey: string;
  displayName: string;
  /** Provider-supplied title, verbatim (source language). Translation is the renderer's job. */
  title: string;
  /** One-line service description, or null when the provider has none configured. */
  description: string | null;
  status: "open" | "resolved";
  url: string;
  startedAt: string;
  updatedAt: string;
  /** Brand logo URL, or null when none could be resolved. */
  logoUrl: string | null;
};

/** Adapter-health alert on the wire, with a stable key set across all kinds. */
type JsonAlert = {
  kind: AdapterHealthAlert["kind"];
  providerKey: string;
  providerName: string;
  logoUrl: string | null;
  /** Short error category (e.g. "HTTP 503"); null for kinds other than "down". */
  errorCategory: string | null;
  /** Pre-formatted human duration (e.g. "2h", "3h 10min", "7d"). */
  durationLabel: string;
};

type IncidentEvent = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "status-page-to-chat";
  event: "incident.opened" | "incident.resolved";
  severity: Severity;
  /** Target UI language the operator configured, so the renderer can localise. */
  language: Locale;
  incident: JsonIncident;
};

type AdapterEvent = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "status-page-to-chat";
  event: `adapter.${AdapterHealthAlert["kind"]}`;
  severity: Severity;
  language: Locale;
  alert: JsonAlert;
};

/**
 * Periodic stability report on the wire.
 *
 * Unlike incidents, the display strings are pre-rendered here rather than
 * left to the renderer: the wording depends on the numbers (singular vs
 * plural, and the "nothing happened" case is a sentence, not an empty
 * list). The structured values are included alongside so a renderer can
 * lay them out differently — e.g. as a table — without re-deriving them.
 */
type JsonReport = {
  period: "weekly" | "monthly" | "quarterly";
  /** Period identifier, e.g. "2026-W31". */
  label: string;
  /** Window covered; `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  /** Pre-rendered headline, e.g. "Wochenbericht KW 31/2026". */
  title: string;
  /** Pre-rendered one-liner, e.g. "13 Ausfälle bei 6 von 24 Diensten." */
  summary: string;
  /** Heading above the ranking; null when there is nothing to rank. */
  rankingHeading: string | null;
  /** Note about unresolved outages; null when everything is closed. */
  stillOpenNote: string | null;
  totalIncidents: number;
  providersTotal: number;
  providersAffected: number;
  /** Worst first. Empty when the period had no incident at all. */
  providers: Array<{
    providerKey: string;
    displayName: string;
    incidentCount: number;
    openCount: number;
    /** Human duration, e.g. "3h 20min"; "-" when not measurable. */
    downtimeLabel: string;
    /** Ready-to-print detail line, e.g. "4 Ausfälle · 3h 20min". */
    line: string;
  }>;
};

type ReportEvent = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "status-page-to-chat";
  event: `report.${JsonReport["period"]}`;
  severity: Severity;
  language: Locale;
  report: JsonReport;
};

function toJsonIncident(incident: NormalizedIncident): JsonIncident {
  return {
    externalId: incident.externalId,
    providerKey: incident.providerKey,
    displayName: incident.displayName,
    title: incident.title,
    description: incident.description ?? null,
    status: incident.status,
    url: incident.url,
    startedAt: incident.startedAt,
    updatedAt: incident.updatedAt,
    logoUrl: incident.logoUrl ?? null,
  };
}

function toJsonAlert(alert: AdapterHealthAlert): JsonAlert {
  return {
    kind: alert.kind,
    providerKey: alert.providerKey,
    providerName: alert.providerName,
    logoUrl: alert.logoUrl ?? null,
    errorCategory: alert.kind === "down" ? alert.errorCategory : null,
    durationLabel: alert.durationLabel,
  };
}

/** Recovery is the only "all clear" state; everything else is an active problem. */
function alertSeverity(kind: AdapterHealthAlert["kind"]): Severity {
  return kind === "recovered" ? "ok" : "problem";
}

/**
 * Notifier that POSTs the raw, normalized event as JSON instead of a
 * finished chat card. Same transport as {@link TeamsNotifier} (a webhook
 * URL), but the payload is data, not presentation: the consumer — typically
 * an Azure Logic App — owns the layout and renders the Adaptive Card from a
 * central template.
 *
 * The envelope is deliberately COMPLETE and STABLE: every field a card can
 * show is present, optional fields are `null` (never omitted) so the key set
 * is identical across all variants, and `severity`/`language` are included so
 * the renderer needs no knowledge of our internal derivation rules. The
 * incident `title` is emitted verbatim (source language) — translation, like
 * all presentation, belongs to the central renderer.
 */
export class TeamsJsonNotifier implements Notifier {
  private readonly webhookUrl: string;
  private readonly language: Locale;

  constructor(webhookUrl: string, language: Locale) {
    this.webhookUrl = webhookUrl;
    this.language = language;
  }

  async notifyOpened(incident: NormalizedIncident): Promise<void> {
    const payload: IncidentEvent = {
      schemaVersion: SCHEMA_VERSION,
      source: "status-page-to-chat",
      event: "incident.opened",
      severity: "problem",
      language: this.language,
      incident: toJsonIncident(incident),
    };
    await this.send(payload, {
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
      severity: "ok",
      language: this.language,
      incident: toJsonIncident(incident),
    };
    await this.send(payload, {
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
      severity: alertSeverity(alert.kind),
      language: this.language,
      alert: toJsonAlert(alert),
    };
    await this.send(payload, {
      provider: alert.providerKey,
      type: `adapter-${alert.kind}`,
    });
  }

  async notifyReport(report: StatusReport): Promise<void> {
    const rendered = renderReport(report, getMessages(this.language));
    const payload: ReportEvent = {
      schemaVersion: SCHEMA_VERSION,
      source: "status-page-to-chat",
      event: `report.${report.period}`,
      // A report is a summary, never an active problem — even when it
      // counts outages, they are in the past.
      severity: "ok",
      language: this.language,
      report: {
        period: report.period,
        label: report.label,
        from: report.from,
        to: report.to,
        title: rendered.title,
        summary: rendered.summary,
        rankingHeading: rendered.rankingHeading,
        stillOpenNote: rendered.stillOpenNote,
        totalIncidents: report.totalIncidents,
        providersTotal: report.providersTotal,
        providersAffected: report.providersAffected,
        providers: rendered.rows,
      },
    };
    await this.send(payload, { type: `report-${report.period}`, label: report.label });
  }

  /**
   * Posts the payload once. Retry/backoff (429/5xx/network) lives in the
   * shared httpClient; on a final non-2xx or network failure this throws, and
   * the poll loop leaves the incident un-notified so the next cycle retries.
   */
  private async send(
    payload: IncidentEvent | AdapterEvent | ReportEvent,
    context: Record<string, unknown>,
  ): Promise<void> {
    const response = await httpPost(this.webhookUrl, payload);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: ${response.body}`);
    }
    logger.info(context, "Teams JSON payload sent");
  }
}

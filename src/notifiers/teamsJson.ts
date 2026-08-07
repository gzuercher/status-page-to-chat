import { httpPost } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { Locale } from "../lib/i18n.js";
import { formatDuration } from "../lib/healthTracker.js";
import type { StatusReport } from "../lib/report.js";
import type { Translator } from "../lib/translator.js";
import type { AdapterHealthAlert, Notifier, NormalizedIncident } from "../lib/types.js";

/**
 * Current version of the JSON envelope. Bump on breaking changes so the
 * downstream renderer (e.g. an Azure Logic App that builds the Adaptive
 * Card centrally) can branch on it.
 *
 * v2: stable schema — every optional field is ALWAYS present (`null` when
 *     unset) so the consumer sees the same keys across all variants; added
 *     `severity` and `language`.
 * v3: reports carry data only. The pre-rendered strings (`title`,
 *     `summary`, the headings, `line`, `facts`, `silentFacts`) are gone —
 *     the renderer builds its own wording from the numbers. `downtimeLabel`
 *     stays: WDL cannot turn milliseconds into "9h 50min".
 */
const SCHEMA_VERSION = 3;

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
  /**
   * Incident title, machine-translated into `language` (see translator.ts).
   * Falls back to the provider's wording whenever translation is
   * unavailable — no API key, an API failure, or a timeout — so a card is
   * never blocked by a translation problem.
   */
  title: string;
  /** The provider's own wording, always, for traceability against the source. */
  titleOriginal: string;
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
 * Periodic stability report on the wire — **data only**.
 *
 * Earlier versions shipped ready-made sentences alongside the numbers.
 * That made sense while the renderer was a thin template, but it split the
 * wording across two repositories: a plural rule lived here, the layout
 * there. The renderer now derives every string from these fields, so this
 * type carries facts and nothing else.
 *
 * The single exception is `downtimeLabel`. Formatting a duration is the one
 * transformation the Logic App's expression language genuinely cannot do.
 */
type JsonReport = {
  period: "weekly" | "monthly" | "quarterly";
  /** Period identifier, e.g. "2026-W31". */
  label: string;
  /** Window covered; `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  totalIncidents: number;
  providersTotal: number;
  /** Of `providersTotal`, how many had at least one incident. */
  providersAffected: number;
  /**
   * **Every** configured provider, worst first, quiet ones included with
   * `incidentCount: 0`. Naming the quiet ones is what turns the card from
   * a problem list into a reliability record.
   */
  providers: Array<{
    providerKey: string;
    displayName: string;
    incidentCount: number;
    openCount: number;
    /** Summed outage time of the resolved incidents, or null if none closed. */
    downtimeMs: number | null;
    /** Same value formatted, e.g. "3h 20min"; "-" when not measurable. */
    downtimeLabel: string;
  }>;
  /**
   * Sources that have never reported anything since we started watching.
   * `upstreamCount` is what separates real silence from a silent defect:
   * `0` = the page reports nothing either, `> 0` = nothing reaches us,
   * `null` = the adapter cannot tell. See lib/report.ts → SilentProvider.
   */
  silentProviders: Array<{
    providerKey: string;
    displayName: string;
    observedDays: number;
    upstreamCount: number | null;
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

async function toJsonIncident(
  incident: NormalizedIncident,
  translator: Translator,
): Promise<JsonIncident> {
  return {
    externalId: incident.externalId,
    providerKey: incident.providerKey,
    displayName: incident.displayName,
    title: await translator.translate(incident.title),
    titleOriginal: incident.title,
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
 * the renderer needs no knowledge of our internal derivation rules.
 *
 * Incident titles ARE translated here. Layout belongs to the renderer, but
 * translation needs an API key and a cache, and pushing that into every
 * consumer would mean each of them holding the key and paying for the same
 * lookups. `titleOriginal` travels alongside so the source wording stays
 * traceable.
 */
export class TeamsJsonNotifier implements Notifier {
  private readonly webhookUrl: string;
  private readonly language: Locale;
  private readonly translator: Translator;

  constructor(webhookUrl: string, language: Locale, translator: Translator) {
    this.webhookUrl = webhookUrl;
    this.language = language;
    this.translator = translator;
  }

  async notifyOpened(incident: NormalizedIncident): Promise<void> {
    const payload: IncidentEvent = {
      schemaVersion: SCHEMA_VERSION,
      source: "status-page-to-chat",
      event: "incident.opened",
      severity: "problem",
      language: this.language,
      incident: await toJsonIncident(incident, this.translator),
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
      incident: await toJsonIncident(incident, this.translator),
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
        totalIncidents: report.totalIncidents,
        providersTotal: report.providersTotal,
        providersAffected: report.providersAffected,
        providers: report.byProvider.map((p) => ({
          providerKey: p.providerKey,
          displayName: p.displayName,
          incidentCount: p.incidentCount,
          openCount: p.openCount,
          downtimeMs: p.downtimeMs,
          downtimeLabel: p.downtimeMs && p.downtimeMs > 0 ? formatDuration(p.downtimeMs) : "-",
        })),
        silentProviders: report.silent.map((p) => ({
          providerKey: p.providerKey,
          displayName: p.displayName,
          observedDays: p.observedDays,
          upstreamCount: p.upstreamCount,
        })),
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

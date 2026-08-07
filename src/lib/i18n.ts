/**
 * Localised wording for the periodic stability reports.
 *
 * This used to cover every string on a chat card — badges, buttons, field
 * labels, health sentences. Those all went with the card-rendering
 * notifiers: the Logic App builds its own wording from the raw event now.
 * What remains is the report, because its phrasing depends on the numbers
 * (singular vs plural, "nothing happened" as a sentence) and that belongs
 * with the calculation. It is rendered for the `report` CLI subcommand;
 * the chat card is assembled downstream from the same figures.
 *
 * Incident titles are not covered here — they are machine-translated
 * (see translator.ts).
 *
 * Adding a language: add a `Messages` object and register it in `MESSAGES`.
 * The config `language` enum (config.ts) and this map must stay in sync.
 */

import type { ReportPeriod } from "./report.js";

/** Supported UI languages. Keep in sync with the config `language` enum. */
export type Locale = "de" | "en";

export const DEFAULT_LOCALE: Locale = "de";

export interface Messages {
  /** Report card: headline naming the period, e.g. "Wochenbericht KW 31". */
  reportTitle: (period: ReportPeriod, label: string) => string;
  /** Report card: one-line summary of incident count and affected services. */
  reportSummary: (incidents: number, affected: number, total: number) => string;
  /** Report card: shown instead of a ranking when nothing happened at all. */
  reportNoIncidents: string;
  /** Report card: column heading above the per-provider ranking. */
  reportRankingHeading: string;
  /** Report card: one ranking row, e.g. "3 Ausfälle · 2h 15min". */
  reportProviderLine: (incidents: number, downtime: string) => string;
  /** Report card: note that some incidents are still open. */
  reportStillOpen: (count: number) => string;
  /** Report card: heading above the list of sources that never reported. */
  reportSilentHeading: string;
  /**
   * Report card: one silent-source line. `upstreamCount` is what the
   * provider's own page returned before our filters — null when unknown.
   */
  reportSilentLine: (observedDays: number, upstreamCount: number | null) => string;
}

const de: Messages = {
  reportTitle: (period, label) => {
    if (period === "weekly")
      return `Wochenbericht ${label.replace(/^(\d{4})-W(\d+)$/, "KW $2/$1")}`;
    if (period === "monthly") return `Monatsbericht ${label}`;
    return `Quartalsbericht ${label.replace("-", " ")}`;
  },
  reportSummary: (incidents, affected, total) =>
    incidents === 1
      ? `1 Ausfall bei 1 von ${total} Diensten.`
      : `${incidents} Ausfälle bei ${affected} von ${total} Diensten.`,
  reportNoIncidents: "Keine Ausfälle — alle überwachten Dienste liefen durchgehend.",
  reportRankingHeading: "Am häufigsten betroffen",
  reportProviderLine: (incidents, downtime) => {
    if (incidents === 0) return "ohne Ausfall";
    const count = incidents === 1 ? "1 Ausfall" : `${incidents} Ausfälle`;
    return downtime === "-" ? count : `${count} · ${downtime} gesamt`;
  },
  reportStillOpen: (count) =>
    count === 1 ? "1 Ausfall ist noch offen." : `${count} Ausfälle sind noch offen.`,
  reportSilentHeading: "Ohne jede Meldung",
  reportSilentLine: (observedDays, upstreamCount) => {
    const seit = `seit ${observedDays} Tagen überwacht, nie eine Meldung`;
    if (upstreamCount === null) return seit;
    return upstreamCount > 0
      ? `${seit} — Statusseite listet ${upstreamCount} Vorfälle: Filter oder Adapter prüfen`
      : `${seit} — Statusseite meldet ebenfalls nichts`;
  },
};

const en: Messages = {
  reportTitle: (period, label) => {
    if (period === "weekly")
      return `Weekly report ${label.replace(/^(\d{4})-W(\d+)$/, "week $2/$1")}`;
    if (period === "monthly") return `Monthly report ${label}`;
    return `Quarterly report ${label.replace("-", " ")}`;
  },
  reportSummary: (incidents, affected, total) =>
    incidents === 1
      ? `1 outage across 1 of ${total} services.`
      : `${incidents} outages across ${affected} of ${total} services.`,
  reportNoIncidents: "No outages — every monitored service stayed up.",
  reportRankingHeading: "Most affected",
  reportProviderLine: (incidents, downtime) => {
    if (incidents === 0) return "no outage";
    const count = incidents === 1 ? "1 outage" : `${incidents} outages`;
    return downtime === "-" ? count : `${count} · ${downtime} total`;
  },
  reportStillOpen: (count) =>
    count === 1 ? "1 outage is still open." : `${count} outages are still open.`,
  reportSilentHeading: "Never reported anything",
  reportSilentLine: (observedDays, upstreamCount) => {
    const seen = `watched for ${observedDays} days, never reported`;
    if (upstreamCount === null) return seen;
    return upstreamCount > 0
      ? `${seen} — its status page lists ${upstreamCount} incidents: check the filter or adapter`
      : `${seen} — its status page reports nothing either`;
  },
};

const MESSAGES: Record<Locale, Messages> = { de, en };

/** Returns the message bundle for a locale (defaults to {@link DEFAULT_LOCALE}). */
export function getMessages(locale: Locale = DEFAULT_LOCALE): Messages {
  return MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
}

/** Maps a UI locale to the natural-language name handed to the translator. */
export function localeToLanguageName(locale: Locale): string {
  return locale === "en" ? "English" : "German";
}

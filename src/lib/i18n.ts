/**
 * Static UI localisation for chat cards.
 *
 * This dictionary covers everything status-page-to-chat *authors itself*:
 * status badges, button labels, field labels, adapter-health sentences and
 * error categories. Provider-supplied incident titles are NOT covered here
 * — those are machine-translated at render time (see translator.ts).
 *
 * Adding a language: add a `Messages` object and register it in `MESSAGES`.
 * The config `language` enum (config.ts) and this map must stay in sync.
 */

import type { ReportPeriod } from "./report.js";

/** Supported UI languages. Keep in sync with the config `language` enum. */
export type Locale = "de" | "en";

export const DEFAULT_LOCALE: Locale = "de";

export interface Messages {
  /** Badge text for a freshly reported incident. */
  statusOpened: string;
  /** Badge text for a resolved incident. */
  statusResolved: string;
  /** Open-URL action label on incident cards. */
  viewDetails: string;
  /** Field label for the incident start timestamp. */
  since: string;
  /** Health card: provider could not be polled for `duration`; `error` is a (localised) category. */
  healthDown: (duration: string, error: string) => string;
  /** Health card: polling resumed after `duration` of downtime. */
  healthRecovered: (duration: string) => string;
  /**
   * Health card: polled cleanly for `duration`, the upstream page reported
   * incidents, but none of them survived our filter.
   */
  healthHalfDead: (duration: string) => string;
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
  /** Report card: note that the ranking was truncated. */
  reportMoreProviders: (count: number) => string;
  /** Report card: heading above the list of sources that never reported. */
  reportSilentHeading: string;
  /**
   * Report card: one silent-source line. `upstreamCount` is what the
   * provider's own page returned before our filters — null when unknown.
   */
  reportSilentLine: (observedDays: number, upstreamCount: number | null) => string;
  /**
   * Localises an error category string from errorCategory.ts. Pass-through
   * for anything not in the map (e.g. "HTTP 404", which is language-neutral).
   */
  errorCategory: (category: string) => string;
}

const ERROR_CATEGORIES_DE: Record<string, string> = {
  "Authentication failed": "Authentifizierung fehlgeschlagen",
  Timeout: "Zeitüberschreitung",
  "DNS lookup failed": "DNS-Auflösung fehlgeschlagen",
  "Connection refused": "Verbindung abgelehnt",
  "TLS certificate error": "TLS-Zertifikatsfehler",
  "Invalid response format": "Ungültiges Antwortformat",
  "Unknown error": "Unbekannter Fehler",
};

const de: Messages = {
  statusOpened: "Störung gemeldet",
  statusResolved: "Behoben",
  viewDetails: "Details ansehen",
  since: "Seit",
  healthDown: (duration, error) => `Polling seit ${duration} fehlgeschlagen. ${error}.`,
  healthRecovered: (duration) => `Polling wieder aktiv (war ${duration} ausgefallen).`,
  healthHalfDead: (duration) =>
    `Seit ${duration} sauber gepollt, aber kein gemeldeter Incident passte zum Filter — componentFilter und URL prüfen.`,
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
  reportProviderLine: (incidents, downtime) =>
    `${incidents === 1 ? "1 Ausfall" : `${incidents} Ausfälle`}${downtime === "-" ? "" : ` · ${downtime} gesamt`}`,
  reportStillOpen: (count) =>
    count === 1 ? "1 Ausfall ist noch offen." : `${count} Ausfälle sind noch offen.`,
  reportMoreProviders: (count) =>
    count === 1 ? "und 1 weiterer Dienst" : `und ${count} weitere Dienste`,
  reportSilentHeading: "Ohne jede Meldung",
  reportSilentLine: (observedDays, upstreamCount) => {
    const seit = `seit ${observedDays} Tagen überwacht, nie eine Meldung`;
    if (upstreamCount === null) return seit;
    return upstreamCount > 0
      ? `${seit} — Statusseite meldet aber ${upstreamCount} Vorfälle: Filter oder Adapter prüfen`
      : `${seit} — Statusseite meldet ebenfalls nichts`;
  },
  errorCategory: (category) => ERROR_CATEGORIES_DE[category] ?? category,
};

const en: Messages = {
  statusOpened: "Incident reported",
  statusResolved: "Resolved",
  viewDetails: "View details",
  since: "Since",
  healthDown: (duration, error) => `Unable to poll for the last ${duration}. ${error}.`,
  healthRecovered: (duration) => `Polling resumed (was down for ${duration}).`,
  healthHalfDead: (duration) =>
    `Polled cleanly for ${duration}, but no reported incident matched the filter — check componentFilter and URL.`,
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
  reportProviderLine: (incidents, downtime) =>
    `${incidents === 1 ? "1 outage" : `${incidents} outages`}${downtime === "-" ? "" : ` · ${downtime} total`}`,
  reportStillOpen: (count) =>
    count === 1 ? "1 outage is still open." : `${count} outages are still open.`,
  reportMoreProviders: (count) =>
    count === 1 ? "and 1 more service" : `and ${count} more services`,
  reportSilentHeading: "Never reported anything",
  reportSilentLine: (observedDays, upstreamCount) => {
    const seen = `watched for ${observedDays} days, never reported`;
    if (upstreamCount === null) return seen;
    return upstreamCount > 0
      ? `${seen} — but its status page lists ${upstreamCount} incidents: check the filter or adapter`
      : `${seen} — its status page reports nothing either`;
  },
  errorCategory: (category) => category,
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

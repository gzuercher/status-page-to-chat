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

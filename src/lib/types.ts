/**
 * Einheitliches Incident-Modell.
 * Alle Adapter mappen ihre Rohdaten in dieses Format.
 */
export type NormalizedIncident = {
  /** ID aus dem Quellsystem */
  externalId: string;
  /** Eindeutiger Schluessel des Providers (z.B. "bexio") */
  providerKey: string;
  /** Anzeigename des Providers (z.B. "Bexio") */
  displayName: string;
  /** Kurzbeschreibung der Stoerung */
  title: string;
  /** Vereinfachter Status: offen oder behoben */
  status: "open" | "resolved";
  /** Link zur Stoerung oder Status-Page */
  url: string;
  /** Beginn der Stoerung (ISO-8601) */
  startedAt: string;
  /** Letzte Aktualisierung (ISO-8601) */
  updatedAt: string;
};

/**
 * Interface fuer Status-Page-Adapter.
 * Jeder Adapter holt Incidents von einer bestimmten Plattform.
 */
export interface StatusProvider {
  readonly key: string;
  readonly displayName: string;
  fetchIncidents(): Promise<NormalizedIncident[]>;
}

/**
 * Interface fuer Chat-Notifier.
 * Sendet formatierte Nachrichten an einen Chat-Kanal.
 */
export interface Notifier {
  notifyOpened(incident: NormalizedIncident): Promise<void>;
  notifyResolved(incident: NormalizedIncident): Promise<void>;
}

/**
 * Gespeicherter Zustand eines Incidents in Table Storage.
 */
export type StoredIncident = {
  partitionKey: string;
  rowKey: string;
  title: string;
  status: "open" | "resolved";
  startedAt: string;
  updatedAt: string;
  url: string;
  notifiedOpened: boolean;
  notifiedResolved: boolean;
};

/**
 * Ergebnis des State-Abgleichs fuer einen einzelnen Incident.
 */
export type DiffResult = {
  incident: NormalizedIncident;
  action: "notify_opened" | "notify_resolved" | "none";
};

/**
 * Zusammenfassung eines Durchlaufs (fuer strukturiertes Logging).
 */
export type RunSummary = {
  providersTotal: number;
  providersSucceeded: number;
  providersFailed: number;
  incidentsOpen: number;
  incidentsResolved: number;
  notificationsSent: number;
  notificationsFailed: number;
  durationMs: number;
};

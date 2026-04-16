/**
 * Unified incident model.
 * All adapters map their raw data into this format.
 */
export type NormalizedIncident = {
  /** ID from the source system */
  externalId: string;
  /** Unique key of the provider (e.g. "bexio") */
  providerKey: string;
  /** Display name of the provider (e.g. "Bexio") */
  displayName: string;
  /** Short description of the incident */
  title: string;
  /** Simplified status: open or resolved */
  status: "open" | "resolved";
  /** Link to the incident or status page */
  url: string;
  /** Start of the incident (ISO-8601) */
  startedAt: string;
  /** Last update (ISO-8601) */
  updatedAt: string;
};

/**
 * Interface for status page adapters.
 * Each adapter fetches incidents from a specific platform.
 */
export interface StatusProvider {
  readonly key: string;
  readonly displayName: string;
  fetchIncidents(): Promise<NormalizedIncident[]>;
}

/**
 * Interface for chat notifiers.
 * Sends formatted messages to a chat channel.
 */
export interface Notifier {
  notifyOpened(incident: NormalizedIncident): Promise<void>;
  notifyResolved(incident: NormalizedIncident): Promise<void>;
}

/**
 * Stored state of an incident in Table Storage.
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
 * Result of the state diff for a single incident.
 */
export type DiffResult = {
  incident: NormalizedIncident;
  action: "notify_opened" | "notify_resolved" | "none";
};

/**
 * Summary of a single run (for structured logging).
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

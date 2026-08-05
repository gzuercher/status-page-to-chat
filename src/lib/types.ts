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
  /**
   * Optional one-line service description, copied verbatim from the
   * provider's `description` config field. Operator-authored (already in
   * the deployment's language), rendered as a subtle line on the card.
   * Notifiers must tolerate undefined.
   */
  description?: string;
  /** Simplified status: open or resolved */
  status: "open" | "resolved";
  /** Link to the incident or status page */
  url: string;
  /** Start of the incident (ISO-8601) */
  startedAt: string;
  /** Last update (ISO-8601) */
  updatedAt: string;
  /**
   * Optional brand logo URL the notifier renders next to the title.
   * Computed by the adapter from explicit `logoUrl` config or, as a default,
   * the favicon of the provider's `baseUrl` host. Notifiers must tolerate
   * undefined and render the card without a logo in that case.
   */
  logoUrl?: string;
};

/**
 * Interface for status page adapters.
 * Each adapter fetches incidents from a specific platform.
 */
export interface StatusProvider {
  readonly key: string;
  readonly displayName: string;
  fetchIncidents(): Promise<NormalizedIncident[]>;
  /**
   * How many incidents the upstream page returned during the most recent
   * `fetchIncidents()`, *before* componentFilter or age caps were applied.
   * Diagnostic only — surfaced in the poll log.
   */
  readonly lastUpstreamCount?: number;
  /**
   * Whether the adapter established, during the most recent fetch, that its
   * `componentFilter` no longer names anything the provider publishes.
   *
   * This is what makes a "silent provider" actionable. Three states:
   *
   *   - `true`  — the filter matches none of the provider's *current*
   *               component names. The config is stale (component renamed
   *               or removed) and the provider will never report again.
   *   - `false` — the filter is fine, or there is no filter. A provider
   *               with zero incidents is simply quiet, which is normal.
   *   - `undefined` — the adapter cannot tell. Treated like `false`, so an
   *               adapter that does not implement the check never triggers
   *               a false alarm.
   *
   * Only evaluated when filtering actually discarded everything, so the
   * extra request costs nothing in the healthy case.
   */
  readonly lastConfigDrift?: boolean;
}

/**
 * System-level alert about an adapter's own health, distinct from an
 * incident on the watched service. Surfaces in the same chat target but
 * is visually branded as coming from `status-page-to-chat` itself, not
 * from any provider.
 */
export type AdapterHealthAlert =
  | {
      kind: "down";
      providerKey: string;
      providerName: string;
      logoUrl?: string;
      errorCategory: string;
      durationLabel: string;
    }
  | {
      kind: "recovered";
      providerKey: string;
      providerName: string;
      logoUrl?: string;
      durationLabel: string;
    }
  | {
      kind: "halfDead";
      providerKey: string;
      providerName: string;
      logoUrl?: string;
      durationLabel: string;
    };

/**
 * Interface for chat notifiers.
 * Sends formatted messages to a chat channel.
 */
export interface Notifier {
  notifyOpened(incident: NormalizedIncident): Promise<void>;
  notifyResolved(incident: NormalizedIncident): Promise<void>;
  notifyAdapterHealth(alert: AdapterHealthAlert): Promise<void>;
}

/**
 * Stored state of an incident in the SQLite state store. Field names match
 * the NormalizedIncident shape; the two `notified*` flags track which
 * notifications we have already sent to the chat target so retries on
 * subsequent poll cycles don't double-fire.
 */
export type StoredIncident = {
  providerKey: string;
  externalId: string;
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

import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

const DASHBOARD_URL = "https://www.google.com/appsstatus/dashboard/incidents.json";

type GoogleIncident = {
  id: string;
  external_desc: string;
  begin: string;
  modified: string;
  end?: string;
  uri?: string;
  service_name?: string;
};

/**
 * Adapter fuer Google Workspace Status Dashboard.
 */
export class GoogleWorkspaceAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  private readonly userAgent?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    this.userAgent = config.userAgent;
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    const response = await httpGet(DASHBOARD_URL, {
      accept: "application/json",
      userAgent: this.userAgent,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} von Google Workspace Dashboard`);
    }

    let incidents: GoogleIncident[];
    try {
      incidents = JSON.parse(response.body) as GoogleIncident[];
    } catch (err) {
      throw new Error(`JSON-Parsing fehlgeschlagen: ${String(err)}`);
    }

    const normalized: NormalizedIncident[] = incidents.map((inc) => ({
      externalId: String(inc.id),
      providerKey: this.key,
      displayName: this.displayName,
      title: inc.external_desc,
      status: inc.end ? "resolved" : "open",
      url: inc.uri ?? "https://www.google.com/appsstatus/dashboard/",
      startedAt: inc.begin,
      updatedAt: inc.modified,
    }));

    logger.info(
      { provider: this.key, incidentCount: normalized.length },
      "Google Workspace Incidents abgefragt",
    );

    return normalized;
  }
}

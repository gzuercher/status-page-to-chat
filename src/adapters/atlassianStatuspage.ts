import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Response-Typen der Atlassian Statuspage API.
 */
type AtlassianIncidentComponent = {
  id: string;
  name: string;
};

type AtlassianIncident = {
  id: string;
  name: string;
  status: string;
  shortlink?: string;
  created_at: string;
  updated_at: string;
  components?: AtlassianIncidentComponent[];
};

type AtlassianIncidentsResponse = {
  incidents: AtlassianIncident[];
};

/** Status-Werte, die als "resolved" gelten. */
const RESOLVED_STATUSES = new Set(["resolved", "completed", "postmortem"]);

/**
 * Prueft ob ein Incident den Komponenten-Filter besteht.
 * Ohne Filter: alle Incidents werden uebernommen.
 * Mit Filter: mindestens eine Component muss einen der Filter-Substrings enthalten (case-insensitive, OR-Logik).
 */
function matchesComponentFilter(
  incident: AtlassianIncident,
  componentFilter?: string | string[],
): boolean {
  if (!componentFilter) return true;
  if (!incident.components || incident.components.length === 0) return false;

  const filters = Array.isArray(componentFilter) ? componentFilter : [componentFilter];

  return incident.components.some((comp) =>
    filters.some((filter) => comp.name.toLowerCase().includes(filter.toLowerCase())),
  );
}

/**
 * Mappt den Atlassian-Status auf das vereinfachte Modell.
 */
function mapStatus(atlassianStatus: string): "open" | "resolved" {
  return RESOLVED_STATUSES.has(atlassianStatus) ? "resolved" : "open";
}

/**
 * Adapter fuer Status-Pages, die auf Atlassian Statuspage laufen.
 * Deckt ca. 15 der konfigurierten Dienste ab.
 */
export class AtlassianStatuspageAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly componentFilter?: string | string[];
  private readonly userAgent?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    if (!config.baseUrl) throw new Error(`baseUrl fehlt fuer ${config.key}`);
    this.baseUrl = config.baseUrl;
    this.componentFilter = config.componentFilter;
    this.userAgent = config.userAgent;
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    // Offene Incidents holen
    const unresolvedUrl = `${this.baseUrl}/api/v2/incidents/unresolved.json`;
    const unresolvedResponse = await httpGet(unresolvedUrl, {
      accept: "application/json",
      userAgent: this.userAgent,
    });

    this.validateJsonResponse(unresolvedResponse, unresolvedUrl);

    // Letzte Incidents holen (enthaelt auch kuerzlich resolved)
    const recentUrl = `${this.baseUrl}/api/v2/incidents.json`;
    const recentResponse = await httpGet(recentUrl, {
      accept: "application/json",
      userAgent: this.userAgent,
    });

    this.validateJsonResponse(recentResponse, recentUrl);

    const unresolved = this.parseIncidents(unresolvedResponse.body);
    const recent = this.parseIncidents(recentResponse.body);

    // Zusammenfuehren: alle offenen + kuerzlich resolved (dedupliziert)
    const incidentMap = new Map<string, AtlassianIncident>();
    for (const inc of [...unresolved, ...recent]) {
      incidentMap.set(inc.id, inc);
    }

    const normalized: NormalizedIncident[] = [];

    for (const incident of incidentMap.values()) {
      if (!matchesComponentFilter(incident, this.componentFilter)) {
        continue;
      }

      normalized.push({
        externalId: incident.id,
        providerKey: this.key,
        displayName: this.displayName,
        title: incident.name,
        status: mapStatus(incident.status),
        url: incident.shortlink ?? `${this.baseUrl}/incidents/${incident.id}`,
        startedAt: incident.created_at,
        updatedAt: incident.updated_at,
      });
    }

    logger.info(
      { provider: this.key, incidentCount: normalized.length },
      "Atlassian Statuspage Incidents abgefragt",
    );

    return normalized;
  }

  /**
   * Validiert, dass die Response tatsaechlich JSON ist.
   * Atlassian-Pages koennen bei deaktivierter API eine 404-HTML-Seite
   * mit HTTP 200 zurueckliefern (siehe Sophos / lessons.md).
   */
  private validateJsonResponse(
    response: { status: number; contentType: string; body: string },
    url: string,
  ): void {
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} von ${url}`);
    }

    if (!response.contentType.includes("application/json")) {
      throw new Error(
        `Unerwarteter Content-Type "${response.contentType}" von ${url} — ` +
          "moeglicherweise ist die JSON-API deaktiviert",
      );
    }
  }

  private parseIncidents(body: string): AtlassianIncident[] {
    try {
      const data = JSON.parse(body) as AtlassianIncidentsResponse;
      return data.incidents ?? [];
    } catch (err) {
      throw new Error(`JSON-Parsing fehlgeschlagen: ${String(err)}`);
    }
  }
}

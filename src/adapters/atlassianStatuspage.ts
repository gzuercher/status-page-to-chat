import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Response types for the Atlassian Statuspage API.
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

/** Status values that count as "resolved". */
const RESOLVED_STATUSES = new Set(["resolved", "completed", "postmortem"]);

/**
 * Checks whether an incident passes the component filter.
 * Without filter: all incidents are included.
 * With filter: at least one component must contain one of the filter substrings
 * (case-insensitive, OR logic).
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
 * Maps the Atlassian status to the simplified model.
 */
function mapStatus(atlassianStatus: string): "open" | "resolved" {
  return RESOLVED_STATUSES.has(atlassianStatus) ? "resolved" : "open";
}

/**
 * Adapter for status pages running on Atlassian Statuspage.
 * Covers approximately 15 of the configured services.
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
    if (!config.baseUrl) throw new Error(`baseUrl missing for ${config.key}`);
    this.baseUrl = config.baseUrl;
    this.componentFilter = config.componentFilter;
    this.userAgent = config.userAgent;
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    // Fetch open incidents
    const unresolvedUrl = `${this.baseUrl}/api/v2/incidents/unresolved.json`;
    const unresolvedResponse = await httpGet(unresolvedUrl, {
      accept: "application/json",
      userAgent: this.userAgent,
    });

    this.validateJsonResponse(unresolvedResponse, unresolvedUrl);

    // Fetch recent incidents (includes recently resolved)
    const recentUrl = `${this.baseUrl}/api/v2/incidents.json`;
    const recentResponse = await httpGet(recentUrl, {
      accept: "application/json",
      userAgent: this.userAgent,
    });

    this.validateJsonResponse(recentResponse, recentUrl);

    const unresolved = this.parseIncidents(unresolvedResponse.body);
    const recent = this.parseIncidents(recentResponse.body);

    // Merge: all open + recently resolved (deduplicated)
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
      "Atlassian Statuspage incidents fetched",
    );

    return normalized;
  }

  /**
   * Validates that the response is actually JSON.
   * Atlassian pages can return a 404 HTML page with HTTP 200
   * when the API is disabled (see Sophos / lessons.md).
   */
  private validateJsonResponse(
    response: { status: number; contentType: string; body: string },
    url: string,
  ): void {
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    if (!response.contentType.includes("application/json")) {
      throw new Error(
        `Unexpected Content-Type "${response.contentType}" from ${url} — ` +
          "the JSON API may be disabled",
      );
    }
  }

  private parseIncidents(body: string): AtlassianIncident[] {
    try {
      const data = JSON.parse(body) as AtlassianIncidentsResponse;
      return data.incidents ?? [];
    } catch (err) {
      throw new Error(`JSON parsing failed: ${String(err)}`);
    }
  }
}

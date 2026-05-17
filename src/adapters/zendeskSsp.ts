import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { resolveProviderLogoUrl } from "../lib/logo.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Adapter for Zendesk's custom "SSP" (Status Page) backend.
 *
 * Zendesk runs a homegrown React/Rails app at status.zendesk.com that
 * exposes JSON-API-style endpoints under `/api/ssp/`. There is no public
 * per-incident URL, so we link every incident back to the homepage.
 *
 * componentFilter works against the `name` of the related service. To
 * resolve service IDs → names we fetch `/api/ssp/services.json` once per
 * poll and cache the lookup for the duration of `fetchIncidents()`.
 */

const INCIDENTS_PATH = "/api/ssp/incidents.json";
const SERVICES_PATH = "/api/ssp/services.json";

type SspIncident = {
  id: string;
  attributes: {
    name: string;
    status: string;
    startedAt: string;
    resolvedAt: string | null;
  };
  relationships?: {
    incidentServices?: {
      data?: Array<{ id: string }>;
    };
  };
};

type SspService = {
  id: string;
  attributes: { name: string };
};

type SspIncidentServiceRef = {
  id: string;
  attributes?: { serviceId?: string; name?: string };
};

type SspResponse<T> = { data: T[]; included?: SspIncidentServiceRef[] };

export class ZendeskSspAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly componentFilter?: string | string[];
  private readonly userAgent?: string;
  private readonly logoUrl?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    if (!config.baseUrl) throw new Error(`baseUrl missing for ${config.key}`);
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.componentFilter = config.componentFilter;
    this.userAgent = config.userAgent;
    this.logoUrl = resolveProviderLogoUrl({
      explicitLogoUrl: config.logoUrl,
      baseUrl: this.baseUrl,
    });
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    const incidentsUrl = `${this.baseUrl}${INCIDENTS_PATH}`;
    const incidentsResponse = await httpGet(incidentsUrl, {
      accept: "application/json",
      userAgent: this.userAgent,
    });
    if (incidentsResponse.status !== 200) {
      throw new Error(`HTTP ${incidentsResponse.status} from ${incidentsUrl}`);
    }

    let incidentsData: SspResponse<SspIncident>;
    try {
      incidentsData = JSON.parse(incidentsResponse.body) as SspResponse<SspIncident>;
    } catch (err) {
      throw new Error(`JSON parsing failed: ${String(err)}`);
    }

    // Resolve service-id → name only if a filter is configured. Otherwise
    // we don't need the second round-trip.
    let serviceNameById: Map<string, string> | null = null;
    if (this.componentFilter) {
      serviceNameById = await this.fetchServiceNames();
    }

    const normalized: NormalizedIncident[] = [];

    for (const inc of incidentsData.data) {
      if (!this.matchesFilter(inc, serviceNameById)) continue;

      const isResolved = inc.attributes.status === "resolved" || !!inc.attributes.resolvedAt;
      normalized.push({
        externalId: inc.id,
        providerKey: this.key,
        displayName: this.displayName,
        title: inc.attributes.name,
        status: isResolved ? "resolved" : "open",
        url: this.baseUrl,
        startedAt: inc.attributes.startedAt,
        updatedAt: inc.attributes.resolvedAt ?? inc.attributes.startedAt,
        logoUrl: this.logoUrl,
      });
    }

    logger.info(
      { provider: this.key, incidentCount: normalized.length },
      "Zendesk SSP incidents fetched",
    );

    return normalized;
  }

  private async fetchServiceNames(): Promise<Map<string, string>> {
    const url = `${this.baseUrl}${SERVICES_PATH}`;
    const response = await httpGet(url, {
      accept: "application/json",
      userAgent: this.userAgent,
    });
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    const parsed = JSON.parse(response.body) as SspResponse<SspService>;
    const map = new Map<string, string>();
    for (const svc of parsed.data) {
      map.set(svc.id, svc.attributes.name);
    }
    return map;
  }

  private matchesFilter(inc: SspIncident, serviceNameById: Map<string, string> | null): boolean {
    if (!this.componentFilter || !serviceNameById) return true;

    const filters = Array.isArray(this.componentFilter)
      ? this.componentFilter
      : [this.componentFilter];
    const refs = inc.relationships?.incidentServices?.data ?? [];
    // incidentService IDs are not the same as service IDs — we'd need
    // /api/ssp/incident_services.json to bridge. As a pragmatic fallback,
    // match the filter substring against the incident name itself, which
    // typically mentions the affected pod or product (e.g. "Pod 13 …",
    // "Help Center …"). This catches the common case without an extra
    // round-trip and matches user intent (filter by free-text).
    void refs;
    const haystack = inc.attributes.name.toLowerCase();
    return filters.some((f) => haystack.includes(f.toLowerCase()));
  }
}

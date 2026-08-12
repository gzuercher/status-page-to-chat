import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { resolveProviderLogoUrl } from "../lib/logo.js";
import type { FetchContext, NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Adapter for Zendesk's custom "SSP" (Status Page) backend.
 *
 * Zendesk runs a homegrown React/Rails app at status.zendesk.com that
 * exposes JSON-API-style endpoints under `/api/ssp/`. There is no public
 * per-incident URL, so we link every incident back to the homepage.
 *
 * componentFilter works against the name of the related service. The
 * incidents payload already carries those names: every incidentService in
 * the top-level `included[]` array has an `attributes.serviceName`. No
 * second round-trip is needed — see `matchesFilter()`.
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

/**
 * Entry of the top-level `included[]` array. Bridges an incidentService id
 * (referenced by the incident) to the human service name.
 */
type SspIncidentServiceRef = {
  id: string;
  type?: string;
  attributes?: { serviceName?: string };
};

type SspResponse<T> = { data: T[]; included?: SspIncidentServiceRef[] };

/** Entry of `/api/ssp/services.json` — the authoritative service catalogue. */
type SspService = {
  id: string;
  attributes: { name: string };
};

export class ZendeskSspAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  /** Upstream incident count of the last fetch, before componentFilter. */
  lastUpstreamCount = 0;
  /** Whether componentFilter matched no current service. See StatusProvider. */
  lastConfigDrift: boolean | undefined = false;
  private readonly baseUrl: string;
  private readonly componentFilter?: string[];
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

  async fetchIncidents(context?: FetchContext): Promise<NormalizedIncident[]> {
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

    // incidentService id → service name, straight out of `included[]`.
    const serviceNameByRefId = new Map<string, string>();
    for (const ref of incidentsData.included ?? []) {
      const name = ref.attributes?.serviceName;
      if (name) serviceNameByRefId.set(ref.id, name);
    }

    this.lastUpstreamCount = incidentsData.data.length;

    const normalized: NormalizedIncident[] = [];

    for (const inc of incidentsData.data) {
      // Already-reported incidents bypass the filter so their resolution
      // still reaches us after a filter edit. See FetchContext.
      if (!this.matchesFilter(inc, serviceNameByRefId) && !context?.trackedOpenIds.has(inc.id)) {
        continue;
      }

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
      {
        provider: this.key,
        incidentCount: normalized.length,
        upstreamCount: this.lastUpstreamCount,
      },
      "Zendesk SSP incidents fetched",
    );

    this.lastConfigDrift = await this.detectConfigDrift(normalized.length);

    return normalized;
  }

  /**
   * Decides whether the componentFilter has gone stale, by checking it
   * against the service catalogue. Only asks when filtering discarded
   * everything. Mirrors AtlassianStatuspageAdapter.detectConfigDrift().
   */
  private async detectConfigDrift(matchedCount: number): Promise<boolean | undefined> {
    if (!this.componentFilter || this.componentFilter.length === 0) return false;
    if (matchedCount > 0) return false;

    const url = `${this.baseUrl}${SERVICES_PATH}`;
    let names: string[];
    try {
      const response = await httpGet(url, {
        accept: "application/json",
        userAgent: this.userAgent,
      });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      const parsed = JSON.parse(response.body) as SspResponse<SspService>;
      names = parsed.data.map((svc) => svc.attributes.name);
    } catch (err) {
      logger.warn(
        { provider: this.key, url, err },
        "Could not fetch service catalogue to validate componentFilter",
      );
      return undefined;
    }

    const matchesSomething = this.componentFilter.some((filter) =>
      names.some((name) => name.toLowerCase().includes(filter.toLowerCase())),
    );

    if (!matchesSomething) {
      logger.warn(
        { provider: this.key, componentFilter: this.componentFilter, serviceCount: names.length },
        "componentFilter matches no service on the status page — the names have changed",
      );
      return true;
    }

    return false;
  }

  /**
   * Matches the filter against the names of the services an incident
   * affects, falling back to the incident title when the payload carries
   * no resolvable service reference.
   */
  private matchesFilter(inc: SspIncident, serviceNameByRefId: Map<string, string>): boolean {
    if (!this.componentFilter || this.componentFilter.length === 0) return true;

    const serviceNames = (inc.relationships?.incidentServices?.data ?? [])
      .map((ref) => serviceNameByRefId.get(ref.id))
      .filter((name): name is string => !!name);

    // Without any resolvable service the title is the only signal we have.
    const haystacks = serviceNames.length > 0 ? serviceNames : [inc.attributes.name];

    return haystacks.some((haystack) =>
      this.componentFilter?.some((f) => haystack.toLowerCase().includes(f.toLowerCase())),
    );
  }
}

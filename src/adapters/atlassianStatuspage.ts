import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import { resolveProviderLogoUrl } from "../lib/logo.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import { IMPACT_RANK, type Impact, type ProviderConfig } from "../lib/config.js";

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
  /** "none" | "minor" | "major" | "critical"; absent on very old incidents. */
  impact?: string;
  shortlink?: string;
  created_at: string;
  updated_at: string;
  components?: AtlassianIncidentComponent[];
};

type AtlassianIncidentsResponse = {
  incidents: AtlassianIncident[];
};

/**
 * Entry of `/api/v2/components.json`. Statuspage models component *groups*
 * as components with `group: true`; the members carry `group_id`. Incidents
 * only ever reference members, never the group itself.
 */
type AtlassianComponent = {
  id: string;
  name: string;
  group?: boolean;
  group_id?: string | null;
};

type AtlassianComponentsResponse = {
  components?: AtlassianComponent[];
};

/** Resolution of a componentFilter against the provider's live catalogue. */
type FilterTargets = {
  /** Ids of the components an incident must reference to pass the filter. */
  componentIds: Set<string>;
  /** Filter entries that matched neither a component nor a group name. */
  unmatched: string[];
};

/** Status values that count as "resolved". */
const RESOLVED_STATUSES = new Set(["resolved", "completed", "postmortem"]);

/**
 * Fallback filter used when the component catalogue is unreachable: match
 * the filter against the component names carried by the incident itself.
 *
 * Cannot resolve group names (an incident never names its group), so it is
 * strictly weaker than the catalogue-based path — but it keeps a provider
 * working through a transient failure of components.json.
 */
function matchesByName(incident: AtlassianIncident, componentFilter?: string[]): boolean {
  if (!componentFilter || componentFilter.length === 0) return true;
  if (!incident.components || incident.components.length === 0) return false;

  return incident.components.some((comp) =>
    componentFilter.some((filter) => comp.name.toLowerCase().includes(filter.toLowerCase())),
  );
}

/**
 * Maps the Atlassian status to the simplified model.
 */
function mapStatus(atlassianStatus: string): "open" | "resolved" {
  return RESOLVED_STATUSES.has(atlassianStatus) ? "resolved" : "open";
}

/**
 * Whether an incident is severe enough to report.
 *
 * An unknown or missing `impact` is treated as passing: suppressing an
 * incident we cannot classify would hide exactly the kind of surprise the
 * service exists to surface.
 */
function meetsMinImpact(incident: AtlassianIncident, minImpact?: Impact): boolean {
  if (!minImpact) return true;
  const rank = IMPACT_RANK[incident.impact as Impact];
  if (rank === undefined) return true;
  return rank >= IMPACT_RANK[minImpact];
}

/**
 * Adapter for status pages running on Atlassian Statuspage.
 * Covers approximately 15 of the configured services.
 */
export class AtlassianStatuspageAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  /** Upstream incident count of the last fetch, before componentFilter. */
  lastUpstreamCount = 0;
  /** Whether componentFilter matched no current component. See StatusProvider. */
  lastConfigDrift: boolean | undefined = false;
  private readonly baseUrl: string;
  private readonly componentFilter?: string[];
  private readonly minImpact?: Impact;
  private readonly userAgent?: string;
  private readonly logoUrl?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    if (!config.baseUrl) throw new Error(`baseUrl missing for ${config.key}`);
    this.baseUrl = config.baseUrl;
    this.componentFilter = config.componentFilter;
    this.minImpact = config.minImpact;
    this.userAgent = config.userAgent;
    this.logoUrl = resolveProviderLogoUrl({
      explicitLogoUrl: config.logoUrl,
      baseUrl: this.baseUrl,
    });
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

    this.lastUpstreamCount = incidentMap.size;

    // Resolve the filter against the live catalogue once per fetch. `null`
    // means the catalogue was unreachable — we then fall back to matching
    // the names the incidents carry themselves.
    const targets = this.componentFilter?.length ? await this.resolveFilterTargets() : undefined;

    const normalized: NormalizedIncident[] = [];
    let belowMinImpact = 0;

    for (const incident of incidentMap.values()) {
      if (!this.passesFilter(incident, targets)) {
        continue;
      }

      // Severity is checked after the component filter so the log counts
      // only incidents that were actually relevant to this provider.
      if (!meetsMinImpact(incident, this.minImpact)) {
        belowMinImpact++;
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
        logoUrl: this.logoUrl,
      });
    }

    logger.info(
      {
        provider: this.key,
        incidentCount: normalized.length,
        upstreamCount: this.lastUpstreamCount,
        filterTargets: targets?.componentIds.size,
        minImpact: this.minImpact,
        belowMinImpact,
      },
      "Atlassian Statuspage incidents fetched",
    );

    this.lastConfigDrift = this.verdictFrom(targets);

    return normalized;
  }

  /**
   * Whether an incident passes the component filter.
   *
   *   - `undefined` targets — no filter configured, everything passes.
   *   - `null` targets — catalogue unreachable, fall back to name matching.
   *   - otherwise — the incident must reference one of the resolved
   *     component ids. Matching by id rather than by name is what lets a
   *     filter name a *group*: incidents never mention their group, so a
   *     name-only comparison can never match one.
   */
  private passesFilter(
    incident: AtlassianIncident,
    targets: FilterTargets | null | undefined,
  ): boolean {
    if (targets === undefined) return true;
    if (targets === null) return matchesByName(incident, this.componentFilter);
    return (incident.components ?? []).some((comp) => targets.componentIds.has(comp.id));
  }

  /**
   * Turns the filter resolution into the drift verdict consumed by the
   * health tracker. See StatusProvider.lastConfigDrift for the tri-state.
   */
  private verdictFrom(targets: FilterTargets | null | undefined): boolean | undefined {
    if (targets === undefined) return false;
    // Catalogue unreachable — unknown, not broken. Never alarm on a
    // transient failure.
    if (targets === null) return undefined;
    return targets.componentIds.size === 0;
  }

  /**
   * Resolves the componentFilter against `/api/v2/components.json`.
   *
   * A filter entry matches a component either by its own name or by the
   * name of the group it belongs to. Group support matters in practice:
   * on multi-tenant pages the useful unit is the group — Kaseya publishes
   * an "IT Glue" group over 393 components, and Bitdefender models each
   * GravityZone cloud instance as a group whose members are all called
   * "Management Console", "Licensing" and so on. Filtering those by
   * component name alone is impossible.
   *
   * Returns null when the catalogue is unreachable.
   */
  private async resolveFilterTargets(): Promise<FilterTargets | null> {
    const filters = this.componentFilter ?? [];
    const url = `${this.baseUrl}/api/v2/components.json`;
    let components: AtlassianComponent[];
    try {
      const response = await httpGet(url, {
        accept: "application/json",
        userAgent: this.userAgent,
      });
      this.validateJsonResponse(response, url);
      const data = JSON.parse(response.body) as AtlassianComponentsResponse;
      components = data.components ?? [];
    } catch (err) {
      logger.warn(
        { provider: this.key, url, err },
        "Component catalogue unreachable, falling back to name matching",
      );
      return null;
    }

    const groupNameById = new Map<string, string>();
    for (const comp of components) {
      if (comp.group === true) groupNameById.set(comp.id, comp.name);
    }

    const componentIds = new Set<string>();
    const matched = new Set<string>();
    for (const comp of components) {
      // Groups themselves are never referenced by an incident — skip them
      // as targets, they only contribute their name to their members.
      if (comp.group === true) continue;
      const groupName = comp.group_id ? groupNameById.get(comp.group_id) : undefined;
      const haystacks = [comp.name, groupName].filter((n): n is string => !!n);
      for (const filter of filters) {
        if (haystacks.some((h) => h.toLowerCase().includes(filter.toLowerCase()))) {
          componentIds.add(comp.id);
          matched.add(filter);
        }
      }
    }

    const unmatched = filters.filter((f) => !matched.has(f));
    if (unmatched.length === filters.length) {
      logger.warn(
        { provider: this.key, componentFilter: filters, componentCount: components.length },
        "componentFilter matches no component or group on the status page — the names have changed",
      );
    } else if (unmatched.length > 0) {
      logger.warn(
        { provider: this.key, unmatchedFilters: unmatched },
        "Some componentFilter entries match no component or group on the status page",
      );
    }

    return { componentIds, unmatched };
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

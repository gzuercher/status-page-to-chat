import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

/**
 * Expected response structure from WEDOS status.online.
 * Note: no official schema available, determined empirically.
 */
type WedosIncident = {
  id: number | string;
  name?: string;
  title?: string;
  status?: string;
  resolved_at?: string | null;
  started_at?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
};

type WedosResponse = {
  incidents?: WedosIncident[];
  data?: WedosIncident[];
};

/**
 * Adapter for the WEDOS status.online platform.
 */
export class WedosStatusOnlineAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly userAgent?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    if (!config.baseUrl) throw new Error(`baseUrl missing for ${config.key}`);
    this.baseUrl = config.baseUrl;
    this.userAgent = config.userAgent;
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    const url = `${this.baseUrl}/en/json/incidents.json`;
    const response = await httpGet(url, {
      accept: "application/json",
      userAgent: this.userAgent,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from WEDOS`);
    }

    if (!response.contentType.includes("application/json")) {
      throw new Error(`Unexpected Content-Type "${response.contentType}" from ${url}`);
    }

    let data: WedosResponse;
    try {
      data = JSON.parse(response.body) as WedosResponse;
    } catch (err) {
      throw new Error(`JSON parsing failed: ${String(err)}`);
    }

    // WEDOS may use either "incidents" or "data" as the key
    const incidents = data.incidents ?? data.data ?? [];

    const normalized: NormalizedIncident[] = incidents.map((inc) => {
      const title = inc.name ?? inc.title ?? "Unknown incident";
      const isResolved = !!inc.resolved_at || inc.status === "resolved";

      return {
        externalId: String(inc.id),
        providerKey: this.key,
        displayName: this.displayName,
        title,
        status: isResolved ? "resolved" : "open",
        url: inc.url ?? `${this.baseUrl}/en/`,
        startedAt: inc.started_at ?? inc.created_at ?? new Date().toISOString(),
        updatedAt: inc.updated_at ?? new Date().toISOString(),
      };
    });

    logger.info(
      { provider: this.key, incidentCount: normalized.length },
      "WEDOS incidents fetched",
    );

    return normalized;
  }
}

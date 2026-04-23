import { httpGet } from "../lib/httpClient.js";
import { logger } from "../lib/logger.js";
import type { NormalizedIncident, StatusProvider } from "../lib/types.js";
import type { ProviderConfig } from "../lib/config.js";

type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
};

/**
 * Adapter for GitHub repositories that use issues as a status tracker.
 */
export class GithubIssuesAdapter implements StatusProvider {
  readonly key: string;
  readonly displayName: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly userAgent?: string;

  constructor(config: ProviderConfig) {
    this.key = config.key;
    this.displayName = config.displayName;
    if (!config.owner || !config.repo) throw new Error(`owner/repo missing for ${config.key}`);
    this.owner = config.owner;
    this.repo = config.repo;
    this.userAgent = config.userAgent;
  }

  async fetchIncidents(): Promise<NormalizedIncident[]> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues?state=all&per_page=30`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    // Optional token for higher rate limit
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await httpGet(url, {
      userAgent: this.userAgent,
      headers,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from GitHub API (${this.owner}/${this.repo})`);
    }

    let issues: GitHubIssue[];
    try {
      issues = JSON.parse(response.body) as GitHubIssue[];
    } catch (err) {
      throw new Error(`JSON parsing failed: ${String(err)}`);
    }

    // Filter out pull requests (GitHub API returns both issues and PRs)
    const normalized: NormalizedIncident[] = issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        externalId: String(issue.number),
        providerKey: this.key,
        displayName: this.displayName,
        title: issue.title,
        status: issue.state === "open" ? "open" : "resolved",
        url: issue.html_url,
        startedAt: issue.created_at,
        updatedAt: issue.updated_at,
      }));

    logger.info({ provider: this.key, incidentCount: normalized.length }, "GitHub issues fetched");

    return normalized;
  }
}

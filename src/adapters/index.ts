import type { ProviderConfig } from "../lib/config.js";
import type { StatusProvider } from "../lib/types.js";
import { AtlassianStatuspageAdapter } from "./atlassianStatuspage.js";
import { GoogleWorkspaceAdapter } from "./googleWorkspace.js";
import { MetanetRssAdapter } from "./metanetRss.js";
import { WedosStatusOnlineAdapter } from "./wedosStatusOnline.js";
import { GithubIssuesAdapter } from "./githubIssues.js";

/**
 * Erstellt den passenden Adapter anhand des adapter-Felds in der Konfiguration.
 */
export function createAdapter(config: ProviderConfig): StatusProvider {
  switch (config.adapter) {
    case "atlassian-statuspage":
      return new AtlassianStatuspageAdapter(config);
    case "google-workspace":
      return new GoogleWorkspaceAdapter(config);
    case "metanet-rss":
      return new MetanetRssAdapter(config);
    case "wedos-status-online":
      return new WedosStatusOnlineAdapter(config);
    case "github-issues":
      return new GithubIssuesAdapter(config);
  }
}

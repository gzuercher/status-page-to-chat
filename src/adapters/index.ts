import type { ProviderConfig } from "../lib/config.js";
import type { StatusProvider } from "../lib/types.js";
import { AtlassianStatuspageAdapter } from "./atlassianStatuspage.js";
import { GoogleWorkspaceAdapter } from "./googleWorkspace.js";
import { WedosStatusOnlineAdapter } from "./wedosStatusOnline.js";
import { GithubIssuesAdapter } from "./githubIssues.js";
import { BetterStackFeedAdapter } from "./betterstackFeed.js";
import { HundAtomAdapter } from "./hundAtom.js";
import { ZendeskSspAdapter } from "./zendeskSsp.js";

/**
 * Erstellt den passenden Adapter anhand des adapter-Felds in der Konfiguration.
 */
export function createAdapter(config: ProviderConfig): StatusProvider {
  switch (config.adapter) {
    case "atlassian-statuspage":
      return new AtlassianStatuspageAdapter(config);
    case "google-workspace":
      return new GoogleWorkspaceAdapter(config);
    case "wedos-status-online":
      return new WedosStatusOnlineAdapter(config);
    case "github-issues":
      return new GithubIssuesAdapter(config);
    case "betterstack-feed":
      return new BetterStackFeedAdapter(config);
    case "hund-atom":
      return new HundAtomAdapter(config);
    case "zendesk-ssp":
      return new ZendeskSspAdapter(config);
  }
}

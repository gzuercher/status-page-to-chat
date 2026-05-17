# Roadmap

The service is live on `teth.rserver.ch`, currently polling 24 providers
through 7 adapter implementations every 5 minutes. This file tracks ideas
that are deliberately not yet built — pick from the top when capacity
opens up.

## Candidate features

- **Adapter-health alerting in Teams** — when a configured status page
  stops returning usable data (consecutive poll failures), surface this
  *in the chat target itself*, not just in container logs. Must be very
  low volume to avoid alert fatigue: post once when an adapter crosses
  N consecutive failures (proposed: 6 = 30 min), once when it recovers,
  never repeat in between. Suppress when more than 50 % of adapters fail
  at once (likely a network or DNS problem on our side, not the
  providers). The state store needs a per-provider failure counter; the
  threshold check belongs in `runPoll` in `src/main.ts`, and the message
  reuses the existing `Notifier` interface.
- **Update messages between `open` and `resolved`** — pass through
  intermediate states ("monitoring", "identified") as a second message
  per incident.
- **Multiple chat targets in parallel** — fan out one incident to
  several webhooks (e.g. Teams + Slack).
- **Per-service routing** — route incidents to different chat rooms by
  provider (e.g. DevOps room vs. support room).
- **Scheduled maintenance as a separate message type** — distinguish
  planned maintenance from unexpected outages in the card layout.
- **Slack notifier** — symmetric to the existing Teams / Google Chat
  notifiers.
- **HTML-scraping adapter** — generic adapter implemented in PR #24;
  works for CheckCentral. Sophos blocked, see next bullet.
- **Sophos WAF workaround** — `status.sophos.com` sits behind a WAF
  that returns `HTTP 403 "Invalid request blocked (v1)"` for our
  standard User-Agent. Browser-UA impersonation is forbidden by our
  HTTP policy, so plain scraping cannot reach the page. Options to
  explore:
  - Ask Sophos to allowlist our UA (or a dedicated one) — cleanest,
    but slow and uncertain.
  - Run an upstream egress proxy with a residential-style header set
    that the operator owns and signs off on — moves the policy
    decision out of this codebase.
  - Use Sophos' partner/admin portal RSS if such a feed exists for
    authenticated partners (needs Raptus-specific credentials).
  The selector + `healthyMatch` config in `html-scrape` is already
  validated against an Atlassian-shape fixture, so the moment the WAF
  obstacle is lifted, the existing adapter works without code change.
- **Azure status adapter** (`azure-status`) — parse the official RSS
  feed at `https://azure.status.microsoft/en-us/status/feed/`
  (Microsoft eigenbau, first-party, `<category>` carries
  service+region). Microsoft 365 (`status.cloud.microsoft`) has **no
  anonymous feed** — the page is bearer-gated, and Microsoft Graph's
  `serviceAnnouncement/issues` requires a per-tenant token
  (`ServiceHealth.Read.All`), which is out of scope for a passive
  multi-tenant poller. Caveat: public Azure/M365 posts typically lag
  tenant-targeted notices by 15–45 min; an empty RSS channel does not
  guarantee "healthy".

## Known maintenance risks

- **GravityZone cloud instances**: the current filter substrings
  (`cloudgz.gravityzone.bitdefender.com`,
  `cloud.gravityzone.bitdefender.com`) reflect today's instance URLs.
  On Bitdefender rebranding or consolidation (e.g. migration to another
  region), the `componentFilter` in `providers.yaml` must be updated or
  notifications go silent.
- **Claude component names**: Anthropic occasionally renames products
  (the console is now officially "platform.claude.com (formerly
  console.anthropic.com)"). When in doubt, check the current component
  list at `https://status.claude.com/api/v2/components.json` and update
  the substrings in `componentFilter`.
- **GitHub rate limit**: without a token, 60 requests/h per client IP —
  sufficient for a single container polling every 5 min. Set
  `GITHUB_TOKEN` on the container to raise it to 5,000/h if more
  github-issues providers are added.

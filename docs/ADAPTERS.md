# Adapters

Each adapter implements the interface:

```ts
interface StatusProvider {
  readonly key: string;
  readonly displayName: string;
  fetchIncidents(): Promise<NormalizedIncident[]>;
}
```

The task of each adapter: fetch raw data, extract open + recently closed incidents, map to the [`NormalizedIncident` format](ARCHITECTURE.md#data-model).

## HTTP requests (applies to all adapters)

- **User-Agent**: All requests go through a central `httpClient` helper that sets the default User-Agent (see [CONFIGURATION.md](CONFIGURATION.md#http-user-agent)). Per provider it can be overridden via the optional `userAgent` field in `providers.yaml`.
- **Timeout**: 10 s per request; abort counts as an adapter error (isolated).
- **Retry**: No retry at adapter level — the next 5-minute cycle will pick it up.
- **Accept header**: Adapters set it specifically where needed (`application/json`, `application/rss+xml`).

---

## 1. `atlassian-statuspage`

**Covered services**: Bitbucket, Bexio, Webflow, DigiCert, NinjaOne, Sucuri, SmartRecruiters, Retool, Kaseya, Bitdefender GravityZone, Figma, Claude — everything running on Atlassian Statuspage with a **public JSON API**. Bitwarden, Zendesk and Langdock look like Atlassian pages but actually run on Hund.io, Zendesk's own SSP backend and BetterStack respectively — they need the `hund-atom`, `zendesk-ssp` and `betterstack-feed` adapters. Sophos runs technically on Atlassian Statuspage but has the JSON API disabled (see [ROADMAP.md](ROADMAP.md) → Later extensions).

### Endpoints

- Open incidents: `{baseUrl}/api/v2/incidents/unresolved.json`
- Recent incidents (incl. recently resolved): `{baseUrl}/api/v2/incidents.json`
- Summary (optional, for component lookup): `{baseUrl}/api/v2/summary.json`

### Mapping

| Statuspage field | Normalized field |
|---|---|
| `id` | `externalId` |
| `name` | `title` |
| `status` | `status` (mapping see below) |
| `shortlink` or `{baseUrl}/incidents/{id}` | `url` |
| `created_at` | `startedAt` |
| `updated_at` | `updatedAt` |

**Status mapping**:

- `resolved`, `completed`, `postmortem` → `resolved`
- everything else (`investigating`, `identified`, `monitoring`, …) → `open`

### Component filter

Optional (`componentFilter`): string **or** list of strings. An incident is included if at least one linked component (case-insensitive) contains one of the filter substrings. With a list, **OR logic** applies: one match is sufficient.

Examples:

- `componentFilter: "example-helpcenter"` — single substring
- `componentFilter: ["cloudgz.gravityzone", "cloud.gravityzone"]` — multiple substrings (e.g. multiple geographic instances of one provider)

### Configuration

```yaml
- key: bexio
  displayName: Bexio
  adapter: atlassian-statuspage
  baseUrl: https://www.bexio-status.com
```

---

## 2. `google-workspace`

**Service**: Google Workspace Status Dashboard.

### Endpoint

- `https://www.google.com/appsstatus/dashboard/incidents.json`

### Mapping

The JSON structure contains a list of active and historical incidents with:

| Google field | Normalized field |
|---|---|
| `id` | `externalId` |
| `external_desc` | `title` |
| `begin` | `startedAt` |
| `modified` | `updatedAt` |
| `end` (present?) | Determines `status`: present = `resolved`, otherwise `open` |
| `uri` (details) or dashboard URL | `url` |

### Configuration

```yaml
- key: google-workspace
  displayName: Google Workspace
  adapter: google-workspace
```

---

## 3. `wedos-status-online`

**Service**: WEDOS (wedos.status.online platform).

### Endpoint

- `https://wedos.status.online/en/json/incidents.json`

### Mapping

The JSON API returns incidents with its own schema (to be verified during implementation). Expected fields:

| WEDOS field | Normalized field |
|---|---|
| `id` | `externalId` |
| `name` / `title` | `title` |
| `status` / `resolved_at` | `status` |
| start/update timestamps | `startedAt` / `updatedAt` |
| Link to incident page | `url` |

### Configuration

```yaml
- key: wedos
  displayName: WEDOS
  adapter: wedos-status-online
  baseUrl: https://wedos.status.online
```

---

## 4. `github-issues`

**Service**: Projects that use GitHub Issues as a status tracker (e.g. Onetime Secret).

### Endpoint

- GitHub REST API: `GET https://api.github.com/repos/{owner}/{repo}/issues?state=all&per_page=30`

Tip: Authentication is optional (higher rate limit). If a token is set, it is provided via App Setting `GITHUB_TOKEN`.

The GitHub API requires a User-Agent — the default UA meets the requirement, no override needed.

### Mapping

| GitHub field | Normalized field |
|---|---|
| `id` or `number` | `externalId` |
| `title` | `title` |
| `state` (`open`/`closed`) | `status` (`open` → `open`, `closed` → `resolved`) |
| `created_at` | `startedAt` |
| `updated_at` | `updatedAt` |
| `html_url` | `url` |

Pull requests are filtered out (GitHub API returns both issues and PRs).

### Configuration

```yaml
- key: onetimesecret
  displayName: Onetime Secret
  adapter: github-issues
  owner: onetimesecret
  repo: status
```

---

## 5. `betterstack-feed`

**Service**: status pages hosted on BetterStack (e.g. Langdock).

BetterStack has no public JSON API. The RSS 2.0 feed at `/feed.atom` carries one `<item>` per incident *update*; multiple updates of the same incident share a `…/incident/<id>` link, which is used as `externalId` to deduplicate.

### Endpoint

- `{baseUrl}/feed.atom`

### Mapping

| Feed field | Normalized field |
|---|---|
| `<link>` trailing segment | `externalId` (deduplication key) |
| latest update's `<title>` | `title` |
| any update containing "resolved" / "fixed" / "restored" / "behoben" / "gelöst" → `resolved`, else `open` | `status` |
| oldest update's `<pubDate>` | `startedAt` |
| newest update's `<pubDate>` | `updatedAt` |
| `<link>` | `url` |

Incidents whose newest update is older than 7 days are dropped — the feed only keeps recent updates, so resolution posts of old incidents have rolled out and they'd otherwise appear permanently "open".

### Configuration

```yaml
- key: langdock
  displayName: Langdock
  adapter: betterstack-feed
  baseUrl: https://status.langdock.com
```

---

## 6. `hund-atom`

**Service**: status pages hosted on Hund.io (e.g. Bitwarden, Metanet).

Hund's REST API (`/api/v1/*`) requires an API key. The public Atom feed at `/state_feed/feed` works without auth.

### Endpoint

- `{baseUrl}/state_feed/feed`

### Mapping

| Atom field | Normalized field |
|---|---|
| `<id>` trailing segment (after the `Entry/` marker) | `externalId` |
| `<title>` | `title` |
| Title prefix in brackets — `[Ended]`, `[Resolved]`, `[Fixed]`, `[Gelöst]`, `[Beendet]`, `[Behoben]` → `resolved`; anything else (`[Investigating]`, `[Identified]`, `[Monitoring]`, no prefix) → `open` | `status` |
| `<published>` | `startedAt` |
| `<updated>` | `updatedAt` |
| `<link href="…">` | `url` |

### Configuration

```yaml
- key: bitwarden
  displayName: Bitwarden
  adapter: hund-atom
  baseUrl: https://status.bitwarden.com
```

---

## 7. `zendesk-ssp`

**Service**: status.zendesk.com (Zendesk's own React/Rails status backend, not Atlassian).

### Endpoints

- Incidents: `{baseUrl}/api/ssp/incidents.json`
- Services (only fetched if `componentFilter` is set): `{baseUrl}/api/ssp/services.json`

### Mapping

| SSP field | Normalized field |
|---|---|
| `data[].id` | `externalId` |
| `data[].attributes.name` | `title` |
| `data[].attributes.status` (`"resolved"` or `resolvedAt` set → `resolved`, else `open`) | `status` |
| `data[].attributes.startedAt` | `startedAt` |
| `data[].attributes.resolvedAt` ?? `startedAt` | `updatedAt` |
| `baseUrl` (no per-incident URL exists on the SSP frontend) | `url` |

### Component filter

The SSP API exposes incident-service refs that are an extra hop away from service names. The current implementation matches the filter substrings against the **incident title** (which usually mentions the affected pod or product, e.g. "Pod 13 …", "Help Center …"). Set `componentFilter: ["Help Center"]` to narrow.

### Configuration

```yaml
- key: zendesk-helpcenter
  displayName: Zendesk Help Center
  adapter: zendesk-ssp
  baseUrl: https://status.zendesk.com
  componentFilter: "Help Center"
```

---

## 8. `html-scrape`

**Use case**: status pages with no JSON API and no RSS/Atom feed, where the overall status is a single element in the rendered HTML. Two motivating cases:

- **CheckCentral** (`https://status.checkcentral.cc`): tiny Bootstrap page; status is encoded purely as a CSS class on an otherwise empty `<div>` inside `<div class="StatusDot">…</div>`.
- **Sophos** (`https://status.sophos.com`): runs technically on Atlassian Statuspage but the JSON API is disabled and the front door is protected by a WAF that returns HTTP 403 ("Invalid request blocked (v1)") to our default User-Agent. Since [CLAUDE.md](../CLAUDE.md) forbids browser-UA impersonation, this adapter is currently **not usable for Sophos in production**. The Sophos selector (`.page-status .status`) and healthyMatch (`All Systems Operational`) are validated against a saved Atlassian-shaped fixture; the moment Sophos lifts the WAF rule (or the operator obtains permission to identify the poller specifically), the same config works.

### Endpoint

- `{baseUrl}` — fetches the page itself, no special path.

### Mapping

| Source | Normalized field |
|---|---|
| `sha256(matchedText).slice(0, 16)` | `externalId` (stable across polls as long as the page text is stable) |
| `titleTemplate` with `{matchedText}` substituted (default `"Status page reports: {matchedText}"`) | `title` |
| `healthyMatch` against the element text — match = no incident, mismatch = single open incident | `status` |
| `baseUrl` | `url` |
| current time | `startedAt` / `updatedAt` (HTML has no timestamps) |

### Selector and healthyMatch

- `selector` (required): CSS selector pointing at the status element. The adapter reads the element's text content; if empty, it falls back to the `class` attribute (covers CheckCentral's empty marker `<div>`).
- `healthyMatch` (required): either a case-insensitive substring or, in `/pattern/flags` form, a regular expression. Matching means "healthy"; mismatching means "open incident".
- `titleTemplate` (optional): overrides the default title. `{matchedText}` is substituted with the scraped text/class.

### Limitations

- One overall incident per provider; no per-component decomposition.
- No timestamps from HTML.
- HTML structure changes silently break the adapter — review the page after upgrades or layout changes from upstream.
- Pages behind a WAF or anti-bot layer that block neutral User-Agents are not supported; we do not impersonate browsers.

### Configuration

```yaml
- key: checkcentral
  displayName: CheckCentral
  adapter: html-scrape
  baseUrl: https://status.checkcentral.cc
  selector: ".StatusDot > div"
  healthyMatch: success
```

---

## Adding a new adapter

1. Create a new file at `src/adapters/<name>.ts`. Implementation must satisfy `StatusProvider`.
2. Register in `src/adapters/index.ts`.
3. Add zod schema for adapter-specific config fields in `src/lib/config.ts`.
4. Unit test at `tests/adapters/<name>.test.ts` with at least one fixture (real saved response).
5. Add a documentation section in this file.

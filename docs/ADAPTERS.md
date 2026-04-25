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

**Covered services**: Bitbucket, Bitwarden, Bexio, Webflow, DigiCert, NinjaOne, Sucuri, SmartRecruiters, Retool, Zendesk, Langdock, Kaseya, Bitdefender GravityZone, Figma, Claude — everything running on Atlassian Statuspage with a **public JSON API**. Sophos runs technically on Atlassian Statuspage but has the JSON API disabled (see [ROADMAP.md](ROADMAP.md) → Later extensions).

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

## 3. `metanet-rss`

**Service**: Metanet Switzerland status announcements.

### Endpoint

- `https://support.metanet.ch/xml/statusmeldungen.xml` (RSS)

### Mapping

RSS items contain title, link, pubDate, description. Additional categorisation in the title/body ("Betriebsunterbruch", "Wartungsarbeiten", "Technische Infos").

| RSS field | Normalized field |
|---|---|
| `guid` or `link` | `externalId` |
| `title` | `title` |
| `pubDate` | `startedAt` / `updatedAt` |
| `link` | `url` |
| Category / body keywords | Determines `status` |

**Status heuristic**:

- Title/body contains keywords like "behoben", "gelöst", "ended" → `resolved`
- Type "Wartungsarbeiten" → skipped (no maintenance messages per spec)
- Otherwise → `open`

### Configuration

```yaml
- key: metanet
  displayName: Metanet
  adapter: metanet-rss
```

---

## 4. `wedos-status-online`

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

## 5. `github-issues`

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

## Adding a new adapter

1. Create a new file at `src/adapters/<name>.ts`. Implementation must satisfy `StatusProvider`.
2. Register in `src/adapters/index.ts`.
3. Add zod schema for adapter-specific config fields in `src/lib/config.ts`.
4. Unit test at `tests/adapters/<name>.test.ts` with at least one fixture (real saved response).
5. Add a documentation section in this file.

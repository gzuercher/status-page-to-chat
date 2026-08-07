# Architecture

## Overview

`status-page-to-chat` is a long-running Node.js process in a Docker container. An in-process
scheduler fires every 5 minutes, polls a list of external status pages, normalises the responses
into a unified incident model, compares them with the last known state in a local SQLite file, and
sends a message to a chat channel when something changed.

Two things run alongside that loop: a **management API** (REST + MCP) so the provider list can be
maintained from a chat assistant instead of a shell, and **self-monitoring** that reports when an
adapter itself breaks.

```
        ┌───────────────────────┐          ┌─────────────────────────┐
        │ croner (*/5 min)      │          │ HTTP :8080              │
        └──────────┬────────────┘          │  /api/…   REST          │
                   │                       │  /mcp     MCP tools     │
                   ▼                       └────────────┬────────────┘
        ┌───────────────────────┐                       │
        │  Config loader (zod)  │ ◄── /data/providers.yaml ◄─┘
        └──────────┬────────────┘        (reloaded every cycle)
                   │
     ┌─────────────┼──────────────┐
     ▼             ▼              ▼
 ┌────────┐   ┌────────┐    ┌────────┐
 │Adapter │   │Adapter │    │Adapter │      one per provider, in parallel
 └───┬────┘   └───┬────┘    └───┬────┘
     └────────────┼─────────────┘
                  ▼
     ┌────────────────────────┐
     │ componentFilter        │  narrow to relevant components/groups
     │ minImpact              │  drop low-severity noise
     └───────────┬────────────┘
                 ▼
     ┌────────────────────────┐      ┌──────────────────────────────┐
     │ State diff             │ ◄──► │ SQLite (Docker volume)       │
     └───────────┬────────────┘      │  incidents · provider_health │
                 │                   │  metadata  · translations    │
                 ▼                   └──────────────────────────────┘
     ┌────────────────────────┐
     │ Health tracker         │  down / recovered / half-dead
     └───────────┬────────────┘
                 ▼
     ┌────────────────────────┐
     │ Notifier               │ ──► webhook (renderer builds the card)
     └────────────────────────┘
```

## Modules

| Module | Path | Responsibility |
|---|---|---|
| Entry point | `src/main.ts` | Poll cycle, report scheduling, signal handling, subcommand dispatch |
| Config loader | `src/lib/config.ts` | Loads and validates `providers.yaml` (zod); `withDefaults` applies deployment-wide settings |
| Adapter registry | `src/adapters/index.ts` | Maps adapter key → implementation |
| Adapters | `src/adapters/*.ts` | One `StatusProvider` implementation per status-page type (8) |
| Notifier registry | `src/notifiers/index.ts` | Selects the notifier from `chatTarget` |
| Notifier | `src/notifiers/teamsJson.ts` | Emits the raw event as JSON; the renderer builds the card |
| State store | `src/state/store.ts` | SQLite persistence: incidents, observation bookkeeping, metadata, translation cache |
| Health tracker | `src/lib/healthTracker.ts` | Detects adapters that are down, recovered, or half-dead |
| Reports | `src/lib/report.ts` | Periodic stability reports and silent-source detection |
| Logos | `src/lib/logo.ts` | Resolves the brand icon shown on a card |
| Localisation | `src/lib/i18n.ts` | Wording of the periodic reports |
| Translator | `src/lib/translator.ts` | Machine-translates incident titles, cached in SQLite |
| HTTP client | `src/lib/httpClient.ts` | Shared client with User-Agent, timeout, retry and backoff |
| Error categories | `src/lib/errorCategory.ts` | Maps a thrown error onto a short, stable category |
| API server | `src/api/server.ts`, `configWriter.ts` | REST management API over the YAML file |
| MCP server | `src/api/mcp.ts` | The same operations as MCP tools, under `/mcp` |
| CLI | `src/cli/*.ts` | `validate`, `health`, `demo`, `report` |
| Types | `src/lib/types.ts` | `NormalizedIncident`, `StatusProvider`, `Notifier`, `AdapterHealthAlert` |

`healthTracker.ts`, `errorCategory.ts` and `httpClient.ts` are **mirrored modules** — the sister
project `social-to-chat` carries the same files and they are kept in sync by hand. They are marked
with a `GESPIEGELTES MODUL` header comment.

## Data model

```ts
type NormalizedIncident = {
  externalId: string;          // ID from the source system
  providerKey: string;         // e.g. "bexio"
  displayName: string;         // e.g. "Bexio"
  title: string;               // short description, in the source language
  description?: string;        // operator-authored one-liner about the service
  status: "open" | "resolved";
  url: string;
  startedAt: string;           // ISO-8601
  updatedAt: string;           // ISO-8601
  logoUrl?: string;            // brand icon for the card
};
```

### Status simplification

Status pages have many states (`investigating`, `identified`, `monitoring`, `resolved`,
`postmortem`, …). For the target audience this collapses to:

- **open** — currently impacted (everything except `resolved`/`completed`/`postmortem`)
- **resolved** — fixed

Severity is kept separately: Atlassian Statuspage publishes `none`/`minor`/`major`/`critical`, and
`minImpact` uses it to suppress noise. See [ADAPTERS.md](ADAPTERS.md#severity-filter-minimpact).

## Data flow per run

1. **Reload config** from disk, so edits and API writes take effect without a restart. A broken file
   leaves the previous config running.
2. **Poll** every provider in parallel, each with its own timeout and error isolation. A failing
   provider must not affect the others.
3. **Filter** — `componentFilter` narrows to relevant components (resolving group names against the
   provider's catalogue), `minImpact` drops low-severity incidents.
4. **Record the observation** in `provider_health`: first seen, last polled, and how many incidents
   the upstream page held before filtering.
5. **Diff** against SQLite:
   - unknown + `open` → notify opened
   - known as `open`, now `resolved` → notify resolved
   - otherwise → nothing
6. **Notify** and persist the row, marking what was actually sent.
7. **Health tracking** over the whole cycle, so global suppression can see the full failure ratio.
8. **Periodic reports**, if a reporting period ended — unless `REPORTS_SCHEDULER=external`, where
   host cron drives them instead.

## State schema (SQLite)

```sql
CREATE TABLE incidents (          -- one row per incident we notified about
  provider_key TEXT, external_id TEXT, title TEXT,
  status TEXT CHECK (status IN ('open','resolved')),
  started_at TEXT, updated_at TEXT, url TEXT,
  notified_opened INTEGER, notified_resolved INTEGER,
  PRIMARY KEY (provider_key, external_id)
);

CREATE TABLE provider_health (    -- observation bookkeeping, incident-independent
  provider_key TEXT PRIMARY KEY,
  first_seen_at TEXT,             -- written once; the baseline for "never reported"
  last_polled_at TEXT,
  last_upstream_count INTEGER     -- incidents on the provider's own page, before our filters
);

CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
                                  -- last_run_at, report_last_{weekly,monthly,quarterly}

CREATE TABLE translations (source_hash TEXT, target_lang TEXT, translated TEXT,
                           PRIMARY KEY (source_hash, target_lang));
```

WAL mode is enabled (`journal_mode = WAL`); the file is updated atomically on each upsert.

Note that `incidents` only ever holds what was **actually notified** — anything dropped by a filter,
or already resolved when first seen, never lands there. The periodic reports therefore measure
notification volume, not the state of the world.

## Error isolation

- Adapters run inside `Promise.allSettled`. Errors are logged, counted in `run_summary`, and fed to
  the health tracker, but never abort the run.
- Retry and exponential backoff for `429`/`5xx`/network errors live centrally in `httpClient.ts`
  (honouring `Retry-After`). Notifiers post once and throw on a non-2xx — the poll loop is the outer
  net: an un-notified incident stays marked as such and is retried next cycle.
- Health events and reports are isolated from incident notification; a failing report cannot swallow
  an outage card.
- The poll loop itself is wrapped in try/catch — an uncaught exception in one run never kills the
  container.

## Self-monitoring

Adapters fail quietly: a renamed component or a changed feed format produces zero incidents and no
error. Three signals cover that:

- **down** — N consecutive failures. Suppressed when more than half of all providers fail in the
  same cycle, since the cause is then almost certainly local.
- **recovered** — polling resumed.
- **half-dead** — the adapter polls cleanly but its `componentFilter` matches nothing the provider
  still publishes. Fires only on that verdict, never on mere silence: a quiet status page and a
  narrow-but-valid filter are both healthy.
- **silent sources** — listed once per reporting period, not alerted. See
  [CONFIGURATION.md](CONFIGURATION.md#sources-that-never-report-anything).

Every run emits a structured `run_summary` log line with counters for providers, incidents and
notifications.

## Security

- `WEBHOOK_URL`, `API_TOKEN` and `ANTHROPIC_API_KEY` are the only secrets. They live in the
  container environment — never in the repo, never in the image.
- The management API requires a bearer token; without `API_TOKEN` it refuses to start.
- No personal data in logs. The webhook URL is never logged: it can carry a SAS signature, and a
  throttled webhook is exactly the situation that writes a retry log line. Status-page URLs *are*
  logged — there they are the useful diagnostic.
- `baseUrl` is checked against private, loopback and link-local ranges. The management API exists to
  be driven by a chat assistant, so a URL someone types is a weaker trust boundary than a YAML file
  an operator edits; without the check the poller could be aimed at cloud metadata every 5 minutes.
- Responses are capped at 5 MB. Without a cap the far end decides how much memory we spend.
- Outbound calls go only to configured hosts.

## What is explicitly NOT built

- No own user authentication beyond the API bearer token (no UI, no accounts)
- No database server — SQLite on a Docker volume is sufficient
- No queue — each run is synchronous
- No card rendering in `teamsJson` mode: layout and wording belong to the downstream renderer

## References

- Configuration and envelope: [CONFIGURATION.md](CONFIGURATION.md)
- Adapter details: [ADAPTERS.md](ADAPTERS.md)
- Management API: [API.md](API.md) · [LLM-INTEGRATION.md](LLM-INTEGRATION.md)
- Deployment: [DEPLOYMENT.md](DEPLOYMENT.md)

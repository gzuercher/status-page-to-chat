# Architecture

## Overview

`status-page-to-chat` is a long-running Node.js process in a Docker container. An in-process scheduler fires every 5 minutes, polls a list of external status pages, normalises the responses into a unified incident model, compares with the last known state in a local SQLite file, and sends a message to a chat channel when changes are detected.

```
           ┌───────────────────────┐
           │ croner (*/5 min)      │
           └──────────┬────────────┘
                      │
                      ▼
           ┌───────────────────────┐
           │  Config Loader        │ ◄── config/providers.yaml
           └──────────┬────────────┘
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
  ┌─────────┐   ┌─────────┐    ┌──────────┐
  │ Adapter │   │ Adapter │    │ Adapter  │   (one per provider)
  └────┬────┘   └────┬────┘    └─────┬────┘
       │             │               │
       └─────────────┼───────────────┘
                     ▼
         ┌────────────────────────┐
         │ Normalized Incidents   │
         └───────────┬────────────┘
                     │
                     ▼
         ┌────────────────────────┐        ┌──────────────────────┐
         │ State-Diff             │ ◄────► │  SQLite (file on     │
         │                        │        │  Docker volume)      │
         └───────────┬────────────┘        └──────────────────────┘
                     │
                     ▼
         ┌────────────────────────┐
         │ Notifier               │ ──► Google Chat / Teams Webhook
         └────────────────────────┘
```

## Modules

| Module | Path | Responsibility |
|---|---|---|
| Entry point | `src/main.ts` | Schedules the poll cycle, handles SIGTERM/SIGINT for graceful shutdown |
| Config Loader | `src/lib/config.ts` | Loads and validates `config/providers.yaml` (zod) |
| Adapter Registry | `src/adapters/index.ts` | Maps adapter key → implementation |
| Adapter | `src/adapters/*.ts` | One implementation of the `StatusProvider` interface per status page type |
| Notifier Registry | `src/notifiers/index.ts` | Selects notifier based on `chatTarget` |
| Notifier | `src/notifiers/googleChat.ts`, `teams.ts` | Formats and POSTs the message |
| State Store | `src/state/store.ts` | SQLite-backed persistence of last known incidents |
| Logger | `src/lib/logger.ts` | pino logger, JSON to stdout |
| HTTP Client | `src/lib/httpClient.ts` | Central HTTP client with User-Agent and timeout |
| Types | `src/lib/types.ts` | `NormalizedIncident`, `StatusProvider`, `Notifier` |

## Data model

### `NormalizedIncident`

```ts
type NormalizedIncident = {
  externalId: string;          // ID from the source system
  providerKey: string;         // e.g. "bexio"
  displayName: string;         // e.g. "Bexio"
  title: string;               // Short description of the incident
  status: "open" | "resolved"; // simplified, see below
  url: string;                 // Link to the incident or status page
  startedAt: string;           // ISO-8601
  updatedAt: string;           // ISO-8601
};
```

### Status simplification

Status pages have many states (`investigating`, `identified`, `monitoring`, `resolved`, `postmortem`, …). For the target audience (end users) this is reduced to:

- **open** = currently impacted (everything except `resolved`/`completed`)
- **resolved** = fixed

## Data flow per run

1. **Load config**: read `config/providers.yaml`, validate with `zod`, `process.exit` with log on error.
2. **Poll**: For each provider in parallel (with timeout + individual error isolation) call `fetchIncidents()`. A failing provider must not affect others.
3. **Normalise**: Adapter already delivers `NormalizedIncident[]`.
4. **Diff** (per incident):
   - Not in SQLite + status `open` → new open incident
   - In SQLite with status `open` + now `resolved` → resolved
   - Otherwise: no message
5. **Notify**: For each state change call `notifyOpened` or `notifyResolved`.
6. **Write state**: Upsert the row in SQLite (composite primary key `provider_key` + `external_id`).

## State schema (SQLite)

```sql
CREATE TABLE incidents (
  provider_key       TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open','resolved')),
  started_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  url                TEXT NOT NULL,
  notified_opened    INTEGER NOT NULL DEFAULT 0,
  notified_resolved  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_key, external_id)
);
```

WAL mode is enabled (`journal_mode = WAL`) for crash safety; the DB file is atomically updated on each upsert.

## Error isolation

- Individual adapters run inside `Promise.allSettled`. Errors are logged and counted in the `run_summary`, but do not abort the overall run.
- Notifier calls retry once with a 2-second backoff. If the notifier still fails, the incident is marked as "not notified" in state so the next run retries.
- The poll loop itself is wrapped in a try/catch — an uncaught exception in a single run never kills the container.

## Self-monitoring

- Container runtime health: Synology Container Manager notifies when the container stops or enters a restart loop.
- Observability: every run emits a structured `run_summary` log entry (JSON) with counters for providers, incidents and notifications. Visible in `docker logs` and in Container Manager's log viewer.

## Security

- `WEBHOOK_URL` is the only secret. It lives only in the container environment — never in the repo, never in the image.
- No secret in the repo (see `.claude/rules/security.md`).
- No personal data in logs.
- Outbound calls go only to static, configured hosts.

## What is explicitly NOT built

- No own authentication (service is backend-only, no UI)
- No own management website (config is edited as YAML in the repo)
- No database server (SQLite on a Docker volume is sufficient)
- No own queue (synchronous per run)

## References

- Data format `providers.yaml`: [CONFIGURATION.md](CONFIGURATION.md)
- Adapter details: [ADAPTERS.md](ADAPTERS.md)
- Deployment: [DEPLOYMENT.md](DEPLOYMENT.md)

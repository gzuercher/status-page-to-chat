# Architecture

## Overview

`status-page-to-chat` is a **timer-driven serverless service**. Every 5 minutes it polls a list of external status pages, normalises the responses into a unified incident model, compares with the last known state, and sends a message to a chat channel when changes are detected.

```
           ┌────────────────────┐
           │ Timer Trigger (5m) │
           └──────────┬─────────┘
                      │
                      ▼
           ┌────────────────────┐
           │  Config Loader     │ ◄── config/providers.yaml
           └──────────┬─────────┘
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
         │ State-Diff (Table)     │ ◄────► │ Azure Table Storage  │
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
| Timer Entry | `src/functions/poll.ts` | Orchestrates the entire run |
| Config Loader | `src/lib/config.ts` | Loads and validates `config/providers.yaml` (zod) |
| Adapter Registry | `src/adapters/index.ts` | Maps adapter key → implementation |
| Adapter | `src/adapters/*.ts` | One implementation of the `StatusProvider` interface per status page type |
| Notifier Registry | `src/notifiers/index.ts` | Selects notifier based on `chatTarget` |
| Notifier | `src/notifiers/googleChat.ts`, `teams.ts` | Formats and POSTs the message |
| State Store | `src/state/tableStore.ts` | Persists last known incidents |
| Logger | `src/lib/logger.ts` | pino logger with App Insights sink |
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
   - Not in Table Storage + status `open` → new open incident
   - In Table Storage open + now `resolved` → resolved
   - Otherwise: carry over state, no message
5. **Notify**: For each state change call `notifyOpened` or `notifyResolved`.
6. **Write state**: Update row in Table Storage.

## Error isolation

- Individual adapters run in their own `try/catch`. Errors are logged and counted as a metric, but do not abort the overall run.
- Notifier calls are retried once with backoff on failure. If the notifier fails completely, the incident is marked as "not notified" in state so it will be retried in the next run.

## Self-monitoring

- **Azure Monitor Alert Rule** (defined in `infra/main.bicep`):
  - Rule: Function Execution Count < 1 in a 15-minute window
  - Action: email to configured address via Action Group
- Additionally: every run logs a structured `run_summary` message. Dashboards and queries in App Insights read this.

## Security

- Webhook URLs are **secrets** → stored exclusively in Function App Settings (encrypted).
- No secret in the repo (see `.claude/rules/security.md`).
- No personal data in logs.
- Outbound calls go only to static, configured hosts.

## What is explicitly NOT built

- No own authentication (service is backend-only, no UI)
- No own management website (config is done via YAML in the repo)
- No database server (Table Storage is sufficient)
- No own queue (synchronous per run)

## References

- Data format `providers.yaml`: [CONFIGURATION.md](CONFIGURATION.md)
- Adapter details: [ADAPTERS.md](ADAPTERS.md)
- Deployment: [DEPLOYMENT.md](DEPLOYMENT.md)

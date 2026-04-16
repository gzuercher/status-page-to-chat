# Plan: Status Page to Chat Notification Service

## Context

The Raptus team should be automatically notified when external services (Cloudflare, Bexio, Webflow, Bitwarden, Zendesk, and more) experience incidents or resolve them. Goals:

- Fewer internal questions ("Is it working for you?")
- Faster response to customer reports
- No missed incidents

The repo was initially empty (Raptus Playbook only). This plan describes the complete setup of a small, modular service that runs on Azure, polls status pages regularly, detects state changes, and posts formatted alerts to Google Chat or Microsoft Teams.

## Decisions (already discussed)

- **Configuration**: YAML file in the repo (`config/providers.yaml`) — versioned, PR-reviewable
- **Chat routing**: One global target to start (webhook URL in App Settings)
- **Self-monitoring**: Azure Monitor Alert → email on failure
- **Scheduled maintenance**: not reported (incidents only)

## Architecture

**Stack**: TypeScript + Node.js 20, Azure Functions (Consumption Plan, Timer Trigger every 5 min), Azure Table Storage for state, Bicep for IaC.

**Flow per run**:

1. Timer fires every 5 min
2. `config/providers.yaml` is loaded (bundled in deployment)
3. For each configured provider the appropriate adapter is instantiated and `fetchIncidents()` is called
4. Raw data is mapped to a unified `NormalizedIncident` model
5. Compared against last known state in Azure Table Storage
6. For new / newly resolved incidents: formatted message via Notifier (Google Chat or Teams webhook)
7. State updated in Table Storage

**Costs**: ~288 executions/day = ~8,700/month, well below the 1M free tier. Storage + App Insights a few cents. Expected: **< CHF 1/month**.

## Adapter modules (modular)

Unified interface `StatusProvider` with `fetchIncidents(): Promise<NormalizedIncident[]>`. Five adapters cover all listed status pages:

| Adapter | Type | Services from the list |
|---|---|---|
| `atlassian-statuspage` | JSON `/api/v2/incidents/unresolved.json` + `/incidents.json` | Bitbucket, Bitwarden, Bexio, Webflow, DigiCert, Kaseya (component filter "IT Glue"), NinjaOne, Sucuri, SmartRecruiters, Retool, Zendesk (component filter "raptus-helpcenter"), Langdock, Bitdefender GravityZone (component filter on used cloud instances), Figma, Claude (component filter on used products) |
| `google-workspace` | JSON `/appsstatus/dashboard/incidents.json` | Google Workspace |
| `metanet-rss` | RSS `/xml/statusmeldungen.xml` | Metanet |
| `wedos-status-online` | JSON `/json/incidents.json` | WEDOS |
| `github-issues` | GitHub REST `/repos/{owner}/{repo}/issues` | Onetime Secret |

Component filter (optional in config) allows filtering only relevant sub-areas on multi-tenant pages (Zendesk, Kaseya). The filter accepts both a single substring and a list of substrings (OR logic) — needed e.g. for GravityZone (multiple geographic cloud instances) and Claude (multiple products).

**Sophos** runs technically on Atlassian Statuspage but has the public JSON API disabled (all endpoints return a 404 HTML page with status 200). Integration is deliberately deferred — see ROADMAP and commented-out entry in `config/providers.yaml`.

## Notifier modules

Unified interface `Notifier` with `notifyOpened(incident)` and `notifyResolved(incident)`.

- `GoogleChatNotifier`: Incoming Webhook, Card v2 with title + link
- `TeamsNotifier`: Incoming Webhook, Adaptive Card

**Message format** (exactly as specified):

- **New**: `⚠️ <Provider> has reported an incident: "<Title>"` + link
- **Resolved**: `✅ <Provider> has resolved the incident: "<Title>"` + link

## Configuration format (`config/providers.yaml`)

```yaml
chatTarget: googleChat   # or "teams"

providers:
  - key: bexio
    displayName: Bexio
    adapter: atlassian-statuspage
    baseUrl: https://www.bexio-status.com
  - key: webflow
    displayName: Webflow
    adapter: atlassian-statuspage
    baseUrl: https://status.webflow.com
  - key: zendesk-helpcenter
    displayName: Zendesk Help Center
    adapter: atlassian-statuspage
    baseUrl: https://status.zendesk.com
    componentFilter: raptus-helpcenter
  - key: kaseya-itglue
    displayName: Kaseya IT Glue
    adapter: atlassian-statuspage
    baseUrl: https://status.kaseya.com
    componentFilter: IT Glue
  - key: google-workspace
    displayName: Google Workspace
    adapter: google-workspace
  - key: metanet
    displayName: Metanet
    adapter: metanet-rss
  - key: wedos
    displayName: WEDOS
    adapter: wedos-status-online
    baseUrl: https://wedos.status.online
  - key: onetimesecret
    displayName: Onetime Secret
    adapter: github-issues
    owner: onetimesecret
    repo: status
```

Validated with `zod` on load (required per Raptus rules).

## Project structure

```
status-page-to-chat/
├── config/
│   └── providers.yaml              # Configured status pages
├── infra/
│   └── main.bicep                  # Azure resources (Function App, Storage, App Insights, Alert)
├── src/
│   ├── functions/
│   │   └── poll.ts                 # Timer Trigger entry point
│   ├── adapters/
│   │   ├── index.ts                # Adapter registry
│   │   ├── atlassianStatuspage.ts
│   │   ├── googleWorkspace.ts
│   │   ├── metanetRss.ts
│   │   ├── wedosStatusOnline.ts
│   │   └── githubIssues.ts
│   ├── notifiers/
│   │   ├── index.ts
│   │   ├── googleChat.ts
│   │   └── teams.ts
│   ├── state/
│   │   └── tableStore.ts           # Azure Table Storage wrapper
│   ├── lib/
│   │   ├── config.ts               # YAML load + zod schema
│   │   ├── httpClient.ts           # Central HTTP client
│   │   ├── logger.ts               # pino logger
│   │   └── types.ts                # NormalizedIncident, provider interface
│   └── index.ts
├── tests/
│   └── adapters/                   # vitest per adapter with fixture responses
├── .env.example
├── host.json
├── local.settings.json.example
├── package.json
├── tsconfig.json
└── README.md
```

## Azure resources (Bicep)

- **Resource Group**: `rg-status-page-to-chat`
- **Storage Account** (Standard_LRS): for Function runtime + `incidents` table
- **Log Analytics Workspace**: prerequisite for workspace-based App Insights
- **Application Insights**: logs/metrics
- **Function App** (Linux, Consumption Plan, Node 20): hosts the Timer Trigger
- **Action Group**: email recipient for alert
- **Alert Rule**: "FunctionExecutionCount < 1 in 15 min" → Action Group

App Settings contain:
- `WEBHOOK_URL` (Google Chat or Teams, depending on `chatTarget`)
- `ALERT_EMAIL` (as parameter for Action Group)
- Secrets as Azure-encrypted App Settings, never in code (rule `security.md`)

## State model (Azure Table Storage)

Table `incidents`:
- `PartitionKey` = provider key (e.g. `bexio`)
- `RowKey` = external incident ID
- Fields: `title`, `status`, `startedAt`, `updatedAt`, `url`, `resolved` (bool), `notifiedOpened`, `notifiedResolved`

Diff logic:
- Incident not in table + is open → New → `notifyOpened` → write row, `notifiedOpened = true`
- Incident exists, was open, is now resolved → Resolved → `notifyResolved` → `notifiedResolved = true`
- Otherwise: do nothing

## Critical files

- `src/functions/poll.ts` — orchestration of the entire run
- `src/adapters/*.ts` — one adapter each, independently testable
- `src/state/tableStore.ts` — state persistence and diff logic (core correctness)
- `src/lib/config.ts` — YAML + zod schema for configuration
- `infra/main.bicep` — complete Azure infrastructure as code

## Verification

1. **Unit tests** (`pnpm test`): Each adapter with fixture responses (saved real statuspage responses) — correctly identifies open vs. closed incidents?
2. **Local run**: `func start` with `local.settings.json` (dummy webhook against `webhook.site`) — tests end-to-end without Azure.
3. **Webhook formats checked manually**: Simulate a test incident → message appears correctly formatted in Google Chat / Teams.
4. **State resilience**: Test with manual table manipulation: Does an already reported incident not get posted twice? Is the resolved signal correctly detected after Function restart?
5. **Azure deployment**: `az deployment group create` with `main.bicep` → verify Function run in Azure portal, manually trigger Alert Rule (stop Function).
6. **Build & Lint** (Raptus rule): `pnpm build && pnpm lint` must pass without errors.

## Implementation order

1. Foundation: `package.json`, `tsconfig.json`, `host.json`, project structure
2. `src/lib/types.ts` + `src/lib/config.ts` incl. zod schema
3. First adapter `atlassianStatuspage.ts` + tests (covers ~13 status pages)
4. `src/state/tableStore.ts`
5. `googleChat.ts` notifier + `teams.ts`
6. `src/functions/poll.ts` orchestration
7. Further adapters (`googleWorkspace`, `metanetRss`, `wedosStatusOnline`, `githubIssues`) + tests
8. `infra/main.bicep` + README with deployment guide
9. Alert Rule for self-monitoring
10. Deployment to Azure, end-to-end test

## Open items for later

- Language of titles: Titles are taken 1:1 from the status page (usually English). If a German translation is desired, that would be a later extension.
- Update messages between New and Resolved: currently hidden, can be activated per provider later.
- Multiple chat targets / per-service routing: deliberately omitted for now — architecture is prepared (Notifier interface).

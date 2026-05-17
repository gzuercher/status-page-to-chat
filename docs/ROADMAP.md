# Roadmap

The service is implemented in sequential stages. Each stage is scoped so that it is **individually reviewable and runnable**.

Legend: `[ ]` open · `[~]` in progress · `[x]` done

## Stage 1 — Foundation

- [x] `package.json` with dependencies: `better-sqlite3`, `croner`, `zod`, `yaml`, `pino`, `undici`
- [x] Dev deps: `typescript`, `vitest`, `eslint`, `prettier`, `@types/node`, `@types/better-sqlite3`
- [x] `tsconfig.json` (strict, target ES2022)
- [x] `eslint.config.mjs`, `.prettierrc`
- [x] Scripts: `build`, `test`, `lint`, `format`
- [x] `src/lib/types.ts` with `NormalizedIncident`, `StatusProvider`, `Notifier`
- [x] `src/lib/logger.ts` (pino)

**Done**: `pnpm install && pnpm build` passes.

## Stage 2 — Config & State

- [x] `src/lib/config.ts`: load YAML, zod schema, read environment variables
- [x] `config/providers.yaml` with starter entries (pulled forward; currently contains 19 providers including Atlassian, Google Workspace, WEDOS and GitHub Issues entries)
- [x] `src/state/store.ts`: CRUD on SQLite (via `better-sqlite3`), diff logic
- [x] `src/lib/httpClient.ts`: central HTTP client with User-Agent and timeout
- [x] Unit tests for state diff (10 tests)

**Done**: Tests green, state diff correctly identifies New/Resolved/Unchanged.

## Stage 3 — First Adapter (Atlassian)

- [x] `src/adapters/atlassianStatuspage.ts`
- [x] `tests/adapters/atlassianStatuspage.test.ts` with fixture for open + closed incidents
- [x] Component filter logic: supports both `string` and `string[]` (OR logic). Tests for both forms + for "no filter" case.
- [x] zod schema: `componentFilter: z.union([z.string(), z.array(z.string())]).optional()`
- [x] Status mapping test
- [x] Response validation: check Content-Type and parse JSON in try/catch (9 tests)

**Done**: Adapter returns correctly normalised incidents from fixture responses.

## Stage 4 — Notifier

- [x] `src/notifiers/googleChat.ts` (Card v2)
- [x] `src/notifiers/teams.ts` (Adaptive Card)
- [x] Shared interface in `src/notifiers/index.ts`
- [x] Tests with mock fetch, verify payload structure (7 tests)
- [x] Retry logic (1x backoff, 2s) with test

**Done**: Message format and retry logic verified by tests.

## Stage 5 — Orchestration

- [x] `src/main.ts` container entrypoint with `croner` schedule
- [x] Error isolation per provider (Promise.allSettled)
- [x] Structured `run_summary` log per run
- [x] State diff with notification tracking (notifiedOpened/notifiedResolved)

**Done**: Orchestration compiles, error isolation implemented.

## Stage 6 — Additional Adapters (parallelisable)

- [x] `googleWorkspace` + test (3 tests)
- [x] `wedosStatusOnline` + test incl. Content-Type check (3 tests)
- [x] `githubIssues` + test incl. PR filter (4 tests)

**Done**: All 5 adapters implemented and tested. 36 tests total, all green.

## Stage 7 — Containerisation

- [x] `src/main.ts` container entrypoint with in-process scheduler (`croner`) and SIGTERM/SIGINT graceful shutdown
- [x] `src/state/store.ts` SQLite state store (via `better-sqlite3`)
- [x] `CONFIG_PATH`, `STATE_DB_PATH`, `POLL_CRON`, `LOG_LEVEL` env vars
- [x] Multi-stage `Dockerfile` (`node:22-alpine`) with non-root user and `/data` volume
- [x] `docker-compose.yml` with named volume and log rotation

**Done**: `pnpm test` passes (40 tests at that point; 82 today after API tests and post-merge hardening); container definition ready to build.

## Stage 8 — CI/CD

- [x] GitHub Actions: Build, Test, Lint on every PR (`.github/workflows/ci.yml`)
- [x] GitHub Actions: Build and publish image to GHCR on push to `main` and on version tags (`.github/workflows/image.yml`)

## Stage 9 — First Deployment and Acceptance

- [ ] Create Portainer stack from `docker-compose.yml`, image pulled from GHCR
- [ ] Configure real webhook against a test chat room
- [ ] Wait and observe → first real incident triggered
- [ ] Manually stop container → restart policy kicks in, Portainer event visible
- [ ] Team acceptance

## Stage 10 — Self-Service Maintenance (V3)

- [x] Management REST API on port 8080, gated by bearer token
- [x] OpenAPI 3.1 spec exposed at `/api/openapi.json` for Langdock and similar LLM platforms
- [x] Document-preserving YAML writes (comments survive every edit)
- [x] Config reload before each poll cycle; broken file does not crash the poller
- [x] CLI `validate` and `health` subcommands for dry-runs and `HEALTHCHECK`
- [x] `docs/LLM-INTEGRATION.md` walking a non-technical maintainer through the assistant setup

**Done**: backoffice users can manage the watched providers in natural language via Langdock; the project itself stays dumb.

## Later extensions (deliberately not in V1)

- Update messages between `open` and `resolved` (e.g. "monitoring", "identified")
- Multiple chat targets in parallel (fan-out to multiple webhooks)
- Per-service routing (e.g. DevOps room vs. support room)
- Scheduled maintenance as a separate message type
- Admin UI for managing configuration
- Self-monitoring via a second "canary" container (beyond the built-in healthcheck)
- **Adapter-health alerting in Teams** — when a configured status page stops returning usable data (consecutive poll failures), surface this *in the chat target itself*, not just in container logs. Must be very low volume to avoid alert fatigue: post once when an adapter crosses N consecutive failures (e.g. 6 = 30 min), once when it recovers, never repeat in between. Suppress during global outages (don't fire when >50 % of adapters fail at once — likely a network or DNS problem on our side).
- Slack notifier
- German translation of titles (LLM call)
- Azure status adapter (`azure-status`) — parse the official RSS feed at `https://azure.status.microsoft/en-us/status/feed/` (Microsoft eigenbau, first-party, `<category>` carries service+region). Microsoft 365 (`status.cloud.microsoft`) has **no anonymous feed** — the page is bearer-gated, and Microsoft Graph's `serviceAnnouncement/issues` requires a per-tenant token (`ServiceHealth.Read.All`), which is out of scope for a passive multi-tenant poller. Caveat: public Azure/M365 posts typically lag tenant-targeted notices by 15–45 min; empty RSS channel does not guarantee "healthy".
- HTML scraping adapter for status pages without an API — **concrete case: Sophos** (`status.sophos.com`): runs on Atlassian Statuspage, but all JSON/RSS/Atom endpoints respond with HTTP 200 and return a 404 HTML page instead of real data. A realistic browser user-agent makes no difference. Enable only when Sophos opens the API or this adapter exists. Entry in `config/providers.yaml` is prepared and commented out.

## Known risks / open research items

- **WEDOS response format**: JSON structure must be empirically verified during implementation (no official schema found).
- **Kaseya component filter "IT Glue"**: Verify availability of component names in the Statuspage API.
- **GravityZone cloud instances**: The current filter substrings (`cloudgz.gravityzone.bitdefender.com`, `cloud.gravityzone.bitdefender.com`) reflect today's instance URLs. On Bitdefender rebranding or consolidation (e.g. migration to another region), the `componentFilter` in `config/providers.yaml` must be updated or notifications will go silent.
- **Claude component names**: Anthropic occasionally renames products (e.g. the console is now officially "platform.claude.com (formerly console.anthropic.com)"). Before go-live, check the current component list at `https://status.claude.com/api/v2/components.json` and update the substrings in `componentFilter` if needed.
- **GitHub rate limit**: Without a token, 60 requests/h per client IP — sufficient for a single container polling every 5 min. With a `GITHUB_TOKEN` set on the container, 5,000/h.

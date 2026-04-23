# Roadmap

The service is implemented in sequential stages. Each stage is scoped so that it is **individually reviewable and runnable**.

Legend: `[ ]` open · `[~]` in progress · `[x]` done

## Stage 1 — Foundation

- [x] `package.json` with dependencies: `@azure/functions`, `@azure/data-tables`, `zod`, `yaml`, `pino`, `undici`
- [x] Dev deps: `typescript`, `vitest`, `eslint`, `prettier`, `@types/node`
- [x] `tsconfig.json` (strict, target ES2022)
- [x] `host.json` (Functions v4)
- [x] `local.settings.json.example`
- [x] `eslint.config.mjs`, `.prettierrc`
- [x] Scripts: `build`, `test`, `lint`, `format`
- [x] `src/lib/types.ts` with `NormalizedIncident`, `StatusProvider`, `Notifier`
- [x] `src/lib/logger.ts` (pino)

**Done**: `pnpm install && pnpm build` passes.

## Stage 2 — Config & State

- [x] `src/lib/config.ts`: load YAML, zod schema, read environment variables
- [x] `config/providers.yaml` with starter entries (pulled forward; currently contains 19 providers including Atlassian, Google Workspace, Metanet, WEDOS and GitHub Issues entries)
- [x] `src/state/tableStore.ts`: CRUD on Azure Table Storage, diff logic
- [x] `src/lib/httpClient.ts`: central HTTP client with User-Agent and timeout
- [x] Unit tests for state diff (6 tests)

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

- [x] `src/functions/poll.ts` Timer Trigger
- [x] Error isolation per provider (Promise.allSettled)
- [x] Structured `run_summary` log per run
- [x] State diff with notification tracking (notifiedOpened/notifiedResolved)

**Done**: Orchestration compiles, error isolation implemented.

## Stage 6 — Additional Adapters (parallelisable)

- [x] `googleWorkspace` + test (3 tests)
- [x] `metanetRss` + test incl. maintenance filter (4 tests)
- [x] `wedosStatusOnline` + test incl. Content-Type check (3 tests)
- [x] `githubIssues` + test incl. PR filter (4 tests)

**Done**: All 5 adapters implemented and tested. 36 tests total, all green.

## Stage 7 — Containerisation

- [x] `src/main.ts` container entrypoint with in-process scheduler (`croner`) and SIGTERM/SIGINT graceful shutdown
- [x] `src/state/store.ts` SQLite state store (via `better-sqlite3`) replacing the earlier Table-Storage implementation
- [x] `CONFIG_PATH`, `STATE_DB_PATH`, `POLL_CRON`, `LOG_LEVEL` env vars
- [x] Multi-stage `Dockerfile` (`node:20-alpine`) with non-root user and `/data` volume
- [x] `docker-compose.yml` with named volume and log rotation

**Done**: `pnpm test` passes (40 tests); container definition ready to build.

## Stage 8 — CI/CD

- [x] GitHub Actions: Build, Test, Lint on every PR (`.github/workflows/ci.yml`)
- [x] GitHub Actions: Build and publish image to GHCR on push to `main` and on version tags (`.github/workflows/image.yml`)

## Stage 9 — First Deployment and Acceptance

- [ ] Pull image onto the Raptus Synology (Container Manager project)
- [ ] Configure real webhook against a test chat room
- [ ] Wait and observe → first real incident triggered
- [ ] Manually stop container → Synology notification received
- [ ] Team acceptance

## Later extensions (deliberately not in V1)

- Update messages between `open` and `resolved` (e.g. "monitoring", "identified")
- Multiple chat targets in parallel (fan-out to multiple webhooks)
- Per-service routing (e.g. DevOps room vs. support room)
- Scheduled maintenance as a separate message type
- Admin UI for managing configuration
- Self-monitoring via a second "canary" function (instead of Azure Monitor only)
- Slack notifier
- German translation of titles (LLM call)
- HTML scraping adapter for status pages without an API — **concrete case: Sophos** (`status.sophos.com`): runs on Atlassian Statuspage, but all JSON/RSS/Atom endpoints respond with HTTP 200 and return a 404 HTML page instead of real data. A realistic browser user-agent makes no difference. Enable only when Sophos opens the API or this adapter exists. Entry in `config/providers.yaml` is prepared and commented out.

## Known risks / open research items

- **WEDOS response format**: JSON structure must be empirically verified during implementation (no official schema found).
- **Metanet status semantics**: The "resolved" mapping must be determined via RSS heuristics; multiple RSS entries per incident may be needed.
- **Kaseya component filter "IT Glue"**: Verify availability of component names in the Statuspage API.
- **GravityZone cloud instances**: The current filter substrings (`cloudgz.gravityzone.bitdefender.com`, `cloud.gravityzone.bitdefender.com`) reflect today's instance URLs. On Bitdefender rebranding or consolidation (e.g. migration to another region), the `componentFilter` in `config/providers.yaml` must be updated or notifications will go silent.
- **Claude component names**: Anthropic occasionally renames products (e.g. the console is now officially "platform.claude.com (formerly console.anthropic.com)"). Before go-live, check the current component list at `https://status.claude.com/api/v2/components.json` and update the substrings in `componentFilter` if needed.
- **GitHub rate limit**: Without a token: 60 requests/h per client IP. Sufficient for Azure. With token: 5,000/h.

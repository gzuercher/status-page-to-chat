# Migration: Azure Functions → Docker container on Synology NAS

> ⚠️ **Review recommended** — this document describes a platform change, including infrastructure removal and secret handling. Read and confirm before execution.

## Why

The current Azure setup (Function App + Table Storage + Application Insights + Log Analytics Workspace + Action Group + Metric Alert + Bicep + OIDC federation) is disproportionate for the actual workload: a cron job that polls ~15 HTTP endpoints every 5 minutes and posts a webhook on state change. Raptus operates a Synology RS1619xs+ (Intel Xeon D-1527, x86_64, 32 GB RAM) with Container Manager already running similar small services. Hosting this service there removes one cloud dependency and collapses seven Azure resources into one container.

## Constraints and decisions

| Topic | Decision | Reason |
|---|---|---|
| Runtime | Docker container (`node:20-alpine`) on Synology Container Manager | Matches existing Raptus ops model |
| Architecture | `linux/amd64` only | RS1619xs+ is x86_64 — no multi-arch build needed |
| Scheduling | In-process (`croner`) every 5 min | No external cron; one artifact, one lifecycle |
| State | SQLite via `better-sqlite3`, file on Docker volume | Atomic writes, no network, native performance; schema maps cleanly from current table |
| Config file | Default `config/providers.yaml` baked into image; optional override via `CONFIG_PATH` env var pointing to a mounted file | Matches Option 3 from the design discussion: simple default, flexibility if ever needed |
| Secrets | `WEBHOOK_URL` as env var in Container Manager (or a `.env` file on the NAS not committed) | Unchanged from today |
| Logging | pino → stdout → Container Manager log viewer | No external log backend needed |
| Self-monitoring | Synology Container Manager native notification (container stopped/restart loop) | Replaces Azure Metric Alert. Does not catch "process running but frozen" — accepted for v1, see Open Points |
| Audit trail on config changes | Not required (explicitly dropped per team decision) | — |

## Scope

### Stays unchanged (~80 % of the code)

- `src/adapters/*` — all 5 adapters
- `src/notifiers/*` — Google Chat + Teams notifiers
- `src/lib/httpClient.ts`, `src/lib/logger.ts`, `src/lib/types.ts`
- `src/lib/config.ts` — small tweak only (see below)
- All existing tests for the above (31 of 36 tests untouched)

### Changes

1. **State store** — `src/state/tableStore.ts` → `src/state/store.ts`
   Replace Azure Table Storage backend with SQLite. Keep the public surface (`getStoredIncidents`, `upsertIncident`, a factory `createStore`) so that `diffIncidents` and call sites need minimal edits.
   SQLite schema:
   ```sql
   CREATE TABLE IF NOT EXISTS incidents (
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
   Tests for `diffIncidents` are pure and stay. Add a small integration test that uses an in-memory SQLite DB (`:memory:`) to exercise insert/update/read.

2. **Entry point** — `src/functions/poll.ts` → `src/main.ts`
   Drop the `@azure/functions` Timer binding. The body of `poll()` stays as-is. New wrapper:
   - `croner` schedules `poll` every 5 min (`*/5 * * * *`)
   - Runs one poll immediately on container start (so we see output fast)
   - SIGTERM/SIGINT handler: waits for in-flight poll to finish, closes SQLite, exits 0
   - Unhandled errors in a poll run are caught and logged (never crash the process) — matches the current behaviour (the try/catch in `poll.ts:37–118` already does this)

3. **Config loader** — `src/lib/config.ts`
   Add support for `process.env.CONFIG_PATH` to override the default location. One-line change in `loadConfig()`.

4. **package.json**
   - Remove: `@azure/data-tables`, `@azure/functions`
   - Add: `better-sqlite3`, `croner`
   - Add devDep: `@types/better-sqlite3`
   - Replace `"start": "func start"` with `"start": "node dist/src/main.js"`
   - Update `"main"` field to `dist/src/main.js`

### Additions

5. **`Dockerfile`** (multi-stage, amd64)
   - Stage 1 (`builder`): `node:20-alpine`, install build deps (`python3 make g++`) for `better-sqlite3`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm prune --prod`
   - Stage 2 (runtime): `node:20-alpine`, copy `dist/`, `node_modules/`, `package.json`, `config/`. Non-root user. `CMD ["node", "dist/src/main.js"]`
   - Expected image size: ~80 MB compressed

6. **`docker-compose.yml`** (for local dev and Synology)
   - Single service
   - Volume: `./data:/data` (holds `state.sqlite`)
   - Env: `WEBHOOK_URL` (from `.env`), `STATE_DB_PATH=/data/state.sqlite`, optional `CONFIG_PATH`
   - `restart: unless-stopped`
   - `logging` block with size/rotation limits so the NAS doesn't fill up

7. **`.github/workflows/image.yml`** (replaces `deploy.yml`)
   - Trigger: push to `main`, tags `v*`, manual dispatch
   - Build and push to `ghcr.io/raptus/status-page-to-chat:{sha, latest}`
   - Use GitHub OIDC for GHCR auth (no PAT secret needed)
   - Synology pulls the image manually (or via Container Manager auto-update if enabled)

### Removals

- `infra/main.bicep` and the `infra/` directory
- `.github/workflows/deploy.yml`
- `host.json`
- `.funcignore`
- `local.settings.json.example`
- `package.json` `"start": "func start"` is replaced (not removed)

### Documentation updates

- `docs/DEPLOYMENT.md` — rewrite from Azure steps to Synology Container Manager steps (image pull, volume, env vars, first-run check)
- `docs/ARCHITECTURE.md` — swap the "Azure Functions / Table Storage / App Insights" sections for "Docker container / SQLite / Container Manager logs"
- `docs/ROADMAP.md` — Stage 7 (Infrastructure) and Stage 8 (CI/CD) are superseded; add a short "V2: containerised on Synology" section with the new stages
- `docs/PLAN.md` — add a short note at the top that the hosting decision was revisited; link here
- `docs/CONFIGURATION.md` — mention the new `CONFIG_PATH` env var and the SQLite state file path
- `README.md` — quick-start now says `docker compose up`, not `func start`
- `lessons.md` — add the lesson that was learned (over-engineering avoidance)

## Execution order

Each step ends at a green state (build + tests + lint pass). This keeps the diff reviewable as separate commits.

1. **State store swap** — add SQLite, rename file, update call sites, adapt tests. Verify `pnpm test` passes.
2. **Entry point swap** — add `src/main.ts`, delete `src/functions/poll.ts`, update `package.json` scripts. Verify `pnpm build && node dist/src/main.js` runs locally (with a `.env` containing `WEBHOOK_URL=https://webhook.site/...` for a dry run).
3. **Dockerfile + compose** — build image locally, `docker compose up`, verify one full poll run and one SQLite write.
4. **CI workflow swap** — replace `deploy.yml` with `image.yml`. Verify green on a feature branch.
5. **Cleanup** — remove Azure files (`infra/`, `host.json`, `.funcignore`, `local.settings.json.example`) and update `package.json` deps.
6. **Documentation** — update the seven doc files listed above in one commit.
7. **Synology bring-up** (manual, operator-side) — create Container Manager project, set env vars, mount volume, pull image, start.

Steps 1–6 can all be PR'd at once or split; I'd lean split (one PR per step) for cleaner review. Step 7 is not code.

## Open points (not blockers for v1)

- **Frozen-process detection** — SIGTERM handling catches container stop/restart, but nothing catches "process up but poll loop hung". Mitigation: add a heartbeat file the poll loop touches, and a DSM Task Scheduler job that checks its mtime. Defer until we see it happen in practice.
- **Log rotation** — Docker `json-file` driver caps via the compose `logging` block. Adequate unless the poll logs grow surprisingly.
- **Backup of `state.sqlite`** — the file is small (few KB). Optional: include in the Synology's existing volume backup routine. Loss of state only means "some already-sent notifications might be sent again" — not a catastrophe.
- **GHCR visibility** — decide public vs. private image. Private is slightly more admin (PAT or deploy-key on the NAS); public is simpler but exposes the code paths via image layers. Recommendation: private.

## Effort estimate

- **Agent wall-clock (code, docker setup, CI)**: ~30–60 min, spread across check-in points with operator
- **Operator time**: ~1–2 h total — PR review, local end-to-end test, first Synology bring-up
- **Total calendar time**: a quiet half-day if we do it in one sitting

## Reversibility

Each commit is individually revertable. The Azure resources defined in `infra/main.bicep` were never deployed, so removal is a file-level operation with zero side effects on any live system. Current Azure-oriented CI (`deploy.yml`) is also never-fired-in-anger; removing it is safe.

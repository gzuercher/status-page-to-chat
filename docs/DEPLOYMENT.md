# Deployment

> ⚠️ **Review recommended** — this document describes infrastructure and secret handling. Confirm the values with a second person before first production start-up.

## Target state

A single Docker container, image pulled from GHCR. The container has two important runtime surfaces:

- **A poller** that fetches every 5 minutes and posts webhook messages on state change.
- **A management REST API on port 8080** for editing the watched providers without redeploying.

| Piece | Where | Purpose |
|---|---|---|
| Image | `ghcr.io/gzuercher/status-page-to-chat:latest` | Built on every push to `main`, public |
| Container | `status-page-to-chat` | Long-lived Node.js process |
| State | Named Docker volume `state` (compose-managed) | Holds `state.sqlite` |
| Config | `providers.yaml` on the host (mounted) | List of monitored status pages — editable live |
| `WEBHOOK_URL` | env var | Webhook of the renderer (Teams workflow or Azure Logic App) |
| `API_TOKEN` | env var | Bearer token guarding the management API |
| Logs | Docker `json-file` driver (5×10 MB rotation) | `docker compose logs -f` |
| Healthcheck | `node main.js health` (built into the image) | `docker inspect` shows `healthy` / `unhealthy` |

## Prerequisites

- A host that runs Docker (24+) with `docker compose`
- A webhook URL for the renderer (see CONFIGURATION.md for the Teams workflow setup)
- Outbound HTTPS access from the host to the status-page endpoints and your chat webhook

The image is public — no GHCR credentials needed.

## Three deployment paths

Pick the one that fits your environment:

1. **Plain Docker on a NAS or VM via SSH** — simplest, works on Synology DSM 7 (with Container Manager package installed), QNAP (with Container Station's docker CLI), Raspberry Pi, any Linux VM. No web UI required.
2. **Portainer stack** — convenient if you already run Portainer for other services.
3. **Bare `docker compose` on your laptop** — for kicking the tyres before committing to a host.

---

## Path 1 — Plain Docker via SSH (NAS or VM, no Portainer)

This is what most homelab setups end up doing. Five steps.

### 1. Prerequisites on the host

- **Synology DSM 7+:** install the **Container Manager** package from Package Center. It ships the `docker` and `docker compose` CLIs and a daemon listening on `/var/run/docker.sock`. SSH access must be enabled (Control Panel → Terminal & SNMP).
- **QNAP:** install **Container Station**, which provides the same.
- **Generic Linux VM:** `apt install docker.io docker-compose-plugin` (Debian/Ubuntu) or follow [docker.com](https://docs.docker.com/engine/install/).

Verify with:

```bash
ssh <user>@<nas-host>
docker --version          # 24.x or newer
docker compose version    # v2.x
```

### 2. Create a stack directory

```bash
ssh <user>@<nas-host>
mkdir -p /volume1/docker/status-page-to-chat   # adapt path to your NAS layout
cd /volume1/docker/status-page-to-chat
```

> On Synology, `/volume1/docker/<name>` is the convention used by Container Manager projects. On QNAP, `/share/Container/<name>`. On a generic VM, anywhere your user can write.

### 3. Drop two files

```bash
# The compose file
curl -O https://raw.githubusercontent.com/gzuercher/status-page-to-chat/main/docker-compose.yml

# Secrets
cat > .env <<EOF
WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/...
API_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

The container ships with an empty `providers.yaml` baked in; on first start it seeds that file into the data volume. No host-side provider file needed. The service starts in that "zero providers configured" state — no chat messages until you add entries via the API or via `docker compose cp`.

### 4. Start the container

```bash
docker compose up -d
docker compose logs -f
```

You should see, within ~30 seconds:

- `Configuration loaded` with the provider count
- `API server listening` on port 8080
- `Poller scheduled` with the next cron run
- A `run_summary` line per poll

Press `Ctrl-C` to detach from the log stream (the container keeps running).

### 5. Verify

```bash
# Health (no auth required)
curl http://127.0.0.1:8080/api/health

# Provider list (token required)
curl -H "Authorization: Bearer $(grep ^API_TOKEN .env | cut -d= -f2)" \
     http://127.0.0.1:8080/api/providers

# Docker-level health
docker inspect --format '{{.State.Health.Status}}' status-page-to-chat
# expected: healthy   (after the first poll completes; "starting" for the first ~30s)
```

If anything looks off, see the **Troubleshooting** section at the bottom of this file.

### Updating later

```bash
cd /volume1/docker/status-page-to-chat
docker compose pull
docker compose up -d
```

This pulls the new `:latest` image, recreates the container, and drops the old one. State and config files are unaffected because they live in the named volume and on the host.

To rollback: edit `docker-compose.yml` and pin a previous SHA tag (e.g. `ghcr.io/gzuercher/status-page-to-chat:sha-abc123`), then `docker compose up -d`.

### Auto-update (optional)

If you want unattended pulls of `:latest`, add Watchtower as a sidecar service in the same compose file:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 3600 status-page-to-chat
```

Watchtower polls hourly and replaces the container in place when a new image is available. Skip if you prefer to apply updates explicitly.

---

## Path 2 — Portainer stack

If you already use Portainer, this is a few clicks.

### 1. Create the stack

1. **Portainer → Stacks → Add stack**
2. Name: `status-page-to-chat`
3. **Build method:**
   - **Repository** (recommended): URL `https://github.com/gzuercher/status-page-to-chat`, reference `refs/heads/main`, compose file `docker-compose.yml`. Enable **automatic updates** if you want CI changes pulled.
   - **Web editor**: paste the contents of `docker-compose.yml` from the repo.
4. Under **Environment variables**, set:
   - `WEBHOOK_URL` — the real webhook URL
   - `API_TOKEN` — generate via `openssl rand -hex 32` somewhere safe
5. **Deploy the stack**.

### 2. Drop `providers.yaml` next to the compose file

The compose file mounts `./providers.yaml` from the stack's working directory. Portainer creates that directory under `/data/compose/<stack-id>` on the host. SSH (or use the File Station on your NAS) to put the file there:

```bash
ssh <user>@<host>
cd /data/compose/<stack-id>     # find the stack ID in Portainer's stack details
curl -o providers.yaml https://raw.githubusercontent.com/gzuercher/status-page-to-chat/main/providers.yaml.example
# edit as needed
```

Restart the stack after the file is in place: **Stacks → status-page-to-chat → Stop → Start**.

### 3. Verify

**Containers → status-page-to-chat → Logs** — same indicators as Path 1.

### Updating later

**Stacks → status-page-to-chat → Editor → Update the stack** with **Re-pull image** enabled. Or with **Stack auto-update** turned on, Portainer polls GHCR periodically.

---

## Path 3 — Local laptop run

```bash
git clone https://github.com/gzuercher/status-page-to-chat
cd status-page-to-chat
cp providers.yaml.example providers.yaml
echo "WEBHOOK_URL=https://webhook.site/<your-test-slot>" > .env
echo "API_TOKEN=local-dev-token" >> .env
docker compose up --build
```

`docker compose down -v` removes the SQLite state. Useful for testing fresh setups.

For Node-level development without Docker:

```bash
pnpm install
pnpm build
pnpm test
WEBHOOK_URL='https://webhook.site/<slot>' STATE_DB_PATH=./data/state.sqlite \
  CONFIG_PATH=./config/providers.yaml \
  pnpm start
```

Requires Node.js 22.19+ and pnpm (`corepack enable`).

---

## Secrets

Two values are sensitive:

- `WEBHOOK_URL` — anyone holding it can post to your chat room.
- `API_TOKEN` — anyone holding it can edit `providers.yaml` and read your incident state.

Both live as environment variables. Never commit them. `.env` is in `.gitignore`. Set the file mode to `600` on the host (`chmod 600 .env`).

**Rotation:**

1. Generate a new value (`openssl rand -hex 32` for the API token, regenerate the webhook in the chat channel).
2. Update `.env` on the host (or update the Portainer stack env vars).
3. `docker compose up -d` — Compose recreates the container with the new value.
4. Update your LLM platform or any other client to use the new token.

## Periodic reports via host cron

The weekly, monthly and quarterly stability reports can be triggered either by the container itself
or by the host. The Raptus deployment uses host cron, because the schedule is then visible and
editable next to the other jobs on the machine.

Set `REPORTS_SCHEDULER=external` in the compose environment to switch the built-in scheduler off,
then add three entries to the operator's crontab:

```cron
15 8 * * 1        docker exec raptus-status-notifs node dist/src/main.js report weekly    >>$HOME/scripts/logs/status-reports.log 2>&1 || tail -n 30 $HOME/scripts/logs/status-reports.log >&2
30 8 1 * *        docker exec raptus-status-notifs node dist/src/main.js report monthly   >>$HOME/scripts/logs/status-reports.log 2>&1 || tail -n 30 $HOME/scripts/logs/status-reports.log >&2
45 8 1 1,4,7,10 * docker exec raptus-status-notifs node dist/src/main.js report quarterly >>$HOME/scripts/logs/status-reports.log 2>&1 || tail -n 30 $HOME/scripts/logs/status-reports.log >&2
```

Staggered by 15 minutes so a 1 January falling on a Monday does not fire three cards at once. The
`|| tail` turns a failure into mail via the crontab's `MAILTO`.

**Never run both schedulers** — every report would be sent twice. The trade-off of the cron route:
cron has no memory, so a report missed while the host was down is missed for good rather than sent
late. Add `--dry-run` to print a report without sending it.

## Self-monitoring

- **Container restart policy**: `unless-stopped` — Docker restarts the container on crash.
- **Healthcheck**: built into the image, checking two independent things (see `src/cli/health.ts`):
  - **Poll path**: was any provider actually fetched successfully within `HEALTH_MAX_AGE_SECONDS` (default 900)?
  - **Delivery path**: did the last attempt to reach the webhook/Logic App succeed, within `DELIVERY_MAX_AGE_SECONDS` (default 7200)? A payload-free reachability probe (`CHECKCENTRAL_INTERVAL_MINUTES`, default 60) keeps this signal fresh even during a quiet stretch with no incidents to report — it POSTs an empty body to `WEBHOOK_URL` and treats *any* HTTP response (2xx or not) as "reachable", so it never depends on the Logic App understanding a particular payload shape. Only a network-level failure (timeout, DNS, connection refused — exactly what broke on 2026-09-20) counts as unreachable.

  These are deliberately not conflated. A poll loop that runs every cycle but fails every provider (a DNS/network outage) is a different failure from a dead webhook that never surfaces because nothing was due to send — each needs its own evidence, or one can silently mask the other. Visible in `docker inspect` and Portainer's container view; the stdout line names which check tripped.
- **Logs**: structured JSON to stdout, captured by the Docker `json-file` driver with 5×10 MB rotation. Forward to an external log collector if you want long-term retention.
- **API**: `GET /api/health` returns `{"status":"ok","lastRunAt":"..."}` — easy to scrape from an external uptime checker. Note this reflects "a cycle completed", the same coarse signal the Docker healthcheck used to rely on alone — it does not (yet) carry the poll/delivery split above.
- **CheckCentral (optional, external alerting)**: the Docker healthcheck above is only visible locally (`docker inspect`, Portainer) — nothing pages anyone. When `SMTP_HOST`/`SMTP_USERNAME`/`SMTP_PASSWORD`/`CHECKCENTRAL_FROM_EMAIL`/`CHECKCENTRAL_TO_EMAIL` are all set, the poller additionally sends **one** dead-man's-switch check-in email per cycle (CheckCentral is billed per check, so this deliberately uses only one, not two):
  - Not sent at all when polling failed this cycle — silence is the signal; CheckCentral's own overdue detection raises the alarm, exactly like a plain dead-man's-switch. This is the 2026-09-20 failure mode.
  - Sent with body `STATUS: OK` when polling succeeded and the last delivery attempt (real traffic or the reachability probe above) succeeded too.
  - Sent with body `STATUS: DELIVERY DOWN` when polling succeeded but the last delivery attempt did not — so the two failure modes still read differently in CheckCentral, without a second check.

  A watchdog must not depend on the channel it watches — that's why this goes out over SMTP, independent of the Teams webhook entirely. The email fires at most once every `CHECKCENTRAL_INTERVAL_MINUTES`, but a broken condition is re-checked every poll cycle so recovery is caught immediately, not delayed a full interval.

  **Setting up the check in CheckCentral** (mailbox-monitor style, matching the existing "Raptus Internal IT" group convention):
  1. Create one check in the same group/inbox that already receives other internal-IT check-ins (e.g. `raptus+internal-it@mycheckcentral.cc`), named e.g. "Status Poller — Health".
  2. `interval_value: 1`, `interval_type: "Hour"`, `overdue_minutes: 90` — matches `CHECKCENTRAL_INTERVAL_MINUTES` (default 60) with slack for one missed cycle before it's genuinely overdue. `default_status: "Failure"` so silence reads as failure, not "unknown".
  3. `matching_conditions` (required: All): Subject contains `Status Page Poller — Health`, From contains `hostmaster@raptus.com` (or whatever `CHECKCENTRAL_FROM_EMAIL` is set to).
  4. `success_conditions` (required: All): Body Text contains `STATUS: OK`.
  5. `warning_conditions` (required: All): Body Text contains `STATUS: DELIVERY DOWN`. This is what distinguishes "delivery is broken" from "everything is fine" without a second check; CheckCentral's own overdue/Failure state separately distinguishes "polling itself is broken" (see above — no email at all).
  6. Enable whichever notification channel/ticketing system should page on failure — this repo has no opinion on that part, it only controls whether the email itself gets sent.

  **Testing it by hand**, once both the `.env` values and the CheckCentral check above are in place:
  ```bash
  docker exec raptus-status-notifs node dist/src/main.js checkcentral-test
  ```
  Sends one real `STATUS: OK` email through the exact same code path the poll loop uses (marked in the body as a manual test), so you can confirm the SMTP relay and the CheckCentral matching/success conditions actually work before relying on them. Exits 1 with a clear message if CheckCentral is not configured. Run this from a shell that has the real secrets in its environment — this deliberately cannot be done by an AI assistant session, which must not read `.env` contents.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Container restarts in a loop | `WEBHOOK_URL` not set, or `providers.yaml` missing/invalid | `docker compose logs` shows the reason. Add the env var or run `docker compose run --rm status-poller node dist/src/main.js validate` to dry-run the YAML. |
| `docker inspect` shows `unhealthy: poll: ...` | No provider has been fetched successfully within `HEALTH_MAX_AGE_SECONDS` — usually a network issue or hung adapter | Check logs for adapter errors. Restart with `docker compose restart`. Adjust `HEALTH_MAX_AGE_SECONDS` if the network is genuinely slow. |
| `docker inspect` shows `unhealthy: delivery: ...` | The webhook/Logic App is unreachable, rejecting requests, or the URL/SAS signature is stale | Check logs for "Webhook reachability probe failed" and the underlying HTTP/network error. |
| CheckCentral shows the check as overdue (Failure) | Polling itself is broken — see the `unhealthy: poll: ...` row above | Same fix as that row. |
| CheckCentral shows the check in Warning | Delivery is broken — see the `unhealthy: delivery: ...` row above | Same fix as that row. |
| CheckCentral shows the check overdue but `docker inspect` is healthy | The SMTP relay itself is down, or `SMTP_HOST`/credentials are wrong | Check logs for "CheckCentral check-in failed", or run `node dist/src/main.js checkcentral-test` by hand. |
| API returns 401 with a valid token | `API_TOKEN` env var differs between container and caller | Compare `docker compose exec status-poller printenv API_TOKEN` to the value used by curl or your LLM platform. |
| API returns 401 with no token expected | You forgot to set `API_AUTH_DISABLED=true` and didn't set `API_TOKEN` | Either set a token (recommended) or explicitly opt out of auth. |
| Edits to `providers.yaml` don't take effect | The path mount in compose points elsewhere, or the file has YAML errors | `docker compose exec status-poller cat /data/providers.yaml` to see what the container sees. `docker compose run --rm status-poller node dist/src/main.js validate` to check the file. |
| GHCR pull fails with `unauthorized` | The image was set to private somehow | Confirm visibility on GitHub → repo → Packages. The published image should be public. |

A "frozen-but-running" process where the cron loop hung but the container stays up is detected the same way as before: `last_run_at` never advancing. What changed is that a poll loop which keeps *running* but stops *succeeding* — every provider failing every cycle — no longer reads as healthy just because a cycle technically completed; see `last_successful_poll_at` above.

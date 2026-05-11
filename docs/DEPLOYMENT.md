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
| `WEBHOOK_URL` | env var | Google Chat or Teams webhook URL |
| `API_TOKEN` | env var | Bearer token guarding the management API |
| Logs | Docker `json-file` driver (5×10 MB rotation) | `docker compose logs -f` |
| Healthcheck | `node main.js health` (built into the image) | `docker inspect` shows `healthy` / `unhealthy` |

## Prerequisites

- A host that runs Docker (24+) with `docker compose`
- A webhook URL for Google Chat **or** Microsoft Teams (see CONFIGURATION.md for the Teams workflow setup)
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

## Self-monitoring

- **Container restart policy**: `unless-stopped` — Docker restarts the container on crash.
- **Healthcheck**: built into the image. Queries the SQLite state for the most recent poll. Unhealthy if no poll has completed in `HEALTH_MAX_AGE_SECONDS` (default 900). Visible in `docker inspect` and Portainer's container view.
- **Logs**: structured JSON to stdout, captured by the Docker `json-file` driver with 5×10 MB rotation. Forward to an external log collector if you want long-term retention.
- **API**: `GET /api/health` returns `{"status":"ok","lastRunAt":"..."}` — easy to scrape from an external uptime checker.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Container restarts in a loop | `WEBHOOK_URL` not set, or `providers.yaml` missing/invalid | `docker compose logs` shows the reason. Add the env var or run `docker compose run --rm status-poller node dist/src/main.js validate` to dry-run the YAML. |
| `docker inspect` shows `unhealthy` | The poll loop hasn't completed in 15 min — usually a network issue or hung adapter | Check logs for adapter errors. Restart with `docker compose restart`. Adjust `HEALTH_MAX_AGE_SECONDS` if the network is genuinely slow. |
| API returns 401 with a valid token | `API_TOKEN` env var differs between container and caller | Compare `docker compose exec status-poller printenv API_TOKEN` to the value used by curl or your LLM platform. |
| API returns 401 with no token expected | You forgot to set `API_AUTH_DISABLED=true` and didn't set `API_TOKEN` | Either set a token (recommended) or explicitly opt out of auth. |
| Edits to `providers.yaml` don't take effect | The path mount in compose points elsewhere, or the file has YAML errors | `docker compose exec status-poller cat /data/providers.yaml` to see what the container sees. `docker compose run --rm status-poller node dist/src/main.js validate` to check the file. |
| GHCR pull fails with `unauthorized` | The image was set to private somehow | Confirm visibility on GitHub → repo → Packages. The published image should be public. |

A "frozen-but-running" process where the cron loop hung but the container stays up is detected by the healthcheck via `last_run_at` in the SQLite state — Docker reports the container as `unhealthy` and Portainer surfaces it.

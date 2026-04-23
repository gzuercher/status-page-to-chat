# Deployment

> ⚠️ **Review recommended** — this document describes infrastructure and secret handling. Confirm the values with a second person before first production start-up.

## Target state

A single Docker container running on the Raptus Synology NAS (RS1619xs+, Intel Xeon, x86_64). Image built via GitHub Actions and published to GitHub Container Registry (GHCR).

| Piece | Where | Purpose |
|---|---|---|
| Image | `ghcr.io/raptus/status-page-to-chat:latest` | Built on every push to `main` |
| Container | Synology Container Manager project `status-page-to-chat` | Runs the long-lived Node.js process |
| Volume | Named volume `status-page-to-chat_state` (or host path `/volume1/docker/status-page-to-chat/data`) | Holds `state.sqlite` |
| Env var `WEBHOOK_URL` | Container Manager environment settings | Google Chat or Teams webhook URL — the only secret |
| Logs | Docker `json-file` driver (5×10 MB rotation) | Visible in Container Manager UI |

Configuration (`config/providers.yaml`) is baked into the image. Changes flow via Git → CI rebuild → image pull. Override by mounting a file over `/app/config/providers.yaml` and setting `CONFIG_PATH` if ever needed.

## Prerequisites (operator)

- DSM admin access on the Raptus NAS with Container Manager installed
- GitHub account with access to the `raptus/status-page-to-chat` repository (to pull from GHCR)
- Webhook URL for Google Chat **or** Microsoft Teams (see [Teams setup](#teams-webhook-setup) below)

## First deployment

### 1. Wait for the image to build

After the first push to `main` that includes the Docker workflow, GitHub Actions publishes `ghcr.io/raptus/status-page-to-chat:latest`. Verify under **GitHub → Packages**.

### 2. Configure GHCR pull credentials on the NAS

Since the image is private, Container Manager needs credentials. In DSM:

1. **Package Center → Container Manager → Registry**
2. **Add → Custom registry**
   - Name: `GitHub`
   - Registry URL: `https://ghcr.io`
   - Username: a GitHub username with read access
   - Password: a Personal Access Token with `read:packages` scope
3. **Save** and set this registry as the active one.

### 3. Create the container project

1. **Container Manager → Project → Create**
2. Name: `status-page-to-chat`
3. Path: `/volume1/docker/status-page-to-chat` (create the folder beforehand under File Station)
4. Source: **Create docker-compose.yml** and paste:

```yaml
services:
  status-poller:
    image: ghcr.io/raptus/status-page-to-chat:latest
    container_name: status-page-to-chat
    restart: unless-stopped
    environment:
      WEBHOOK_URL: ${WEBHOOK_URL:?must be set}
    volumes:
      - state:/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

volumes:
  state:
```

5. On the next screen, set the **environment variable** `WEBHOOK_URL` to the actual webhook URL.
6. **Next → Done**. Container Manager pulls the image and starts the container.

### 4. Verify

In Container Manager → Container → `status-page-to-chat`:

- **Status** is `running`
- **Logs** show within 30 seconds a `Poller scheduled` line followed by a `run_summary` entry
- A real or manually triggered incident leads to a chat message on the next poll cycle

## Ongoing deployment (updates)

- **Code or provider changes** merged to `main` → GitHub Actions rebuilds and tags the image as `latest` and `<sha>`.
- On the NAS: **Container Manager → Project → status-page-to-chat → Actions → Rebuild** (pulls the new `latest` and restarts).
- Alternatively enable **Auto-update** for the project; DSM then polls GHCR periodically.

Container Manager keeps the old image as a rollback target until pruned.

## Secrets

Only `WEBHOOK_URL` is secret. It lives in the Container Manager project environment — never in the repo, never in the image.

Rotating the webhook:

1. Generate a new webhook in the target chat channel.
2. Container Manager → Project → status-page-to-chat → **Edit** → environment → update `WEBHOOK_URL` → Save → Rebuild.

## Rollback

- Rollback image: edit the compose file to pin a previous tag (`ghcr.io/raptus/status-page-to-chat:sha-<old>`) and rebuild.
- Rollback config: `git revert` the offending commit on `main`. CI rebuilds `latest`, NAS pulls the rollback.

## Teams webhook setup

See `docs/CONFIGURATION.md` for the step-by-step procedure to create a Teams webhook via the Workflows app.

## Running locally

```bash
pnpm install
pnpm build
pnpm test
```

For a full local run against a dummy target:

```bash
echo "WEBHOOK_URL=https://webhook.site/<your-test-slot>" > .env
docker compose up --build
```

The SQLite file ends up in the named volume; tear down with `docker compose down -v` to reset state.

## Self-monitoring

Synology Container Manager's built-in **Notifications** fire on:

- Container stops unexpectedly
- Container enters a restart loop

Configure under **DSM → Control Panel → Notification**. This covers the common failure modes. A frozen-but-running process (cron loop hung) is not detected by Container Manager alone — a heartbeat file plus a DSM Task Scheduler check can be added later if that failure mode ever materialises.

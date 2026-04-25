# Deployment

> ⚠️ **Review recommended** — this document describes infrastructure and secret handling. Confirm the values with a second person before first production start-up.

## Target state

A single Docker container, deployed and managed via **Portainer**. The Docker host is the Raptus Synology (RS1619xs+, Intel Xeon, x86_64), but the deployment process is host-agnostic — any Docker host with Portainer would work the same way. The image is built by GitHub Actions and published to GitHub Container Registry (GHCR).

| Piece | Where | Purpose |
|---|---|---|
| Image | `ghcr.io/raptus/status-page-to-chat:latest` | Built on every push to `main` |
| Container | Portainer stack `status-page-to-chat` | Runs the long-lived Node.js process |
| Volume | Named Docker volume `status-page-to-chat_state` (managed by the stack) | Holds `state.sqlite` |
| Env var `WEBHOOK_URL` | Portainer stack environment | Google Chat or Teams webhook URL — the only secret |
| Logs | Docker `json-file` driver (5×10 MB rotation) | Visible in the Portainer container log view |

Configuration (`config/providers.yaml`) is baked into the image. Changes flow via Git → CI rebuild → image pull. Override by mounting a host file over `/app/config/providers.yaml` and setting `CONFIG_PATH` if ever needed.

## Prerequisites (operator)

- Portainer admin access on the Docker host
- A GitHub Personal Access Token with `read:packages` scope, owned by an account that has access to the `raptus` org packages (for pulling the private GHCR image)
- A webhook URL for Google Chat **or** Microsoft Teams

## First deployment

### 1. Wait for the image to build

After the first push to `main` that contains the Docker workflow, GitHub Actions publishes `ghcr.io/raptus/status-page-to-chat:latest`. Verify on **GitHub → the repo → Packages**.

### 2. Register GHCR credentials in Portainer

Portainer needs to authenticate against GHCR to pull the private image.

1. **Portainer → Registries → Add registry**
2. Provider: **Custom registry**
3. Name: `GHCR`
4. URL: `https://ghcr.io`
5. **Authentication** on, username = the GitHub user, password = the PAT with `read:packages`
6. **Add registry**

Portainer now uses these credentials when pulling images whose hostname matches `ghcr.io`.

### 3. Create the stack

1. **Portainer → Stacks → Add stack**
2. Name: `status-page-to-chat`
3. **Build method**: choose one:
   - **Repository** (recommended): URL `https://github.com/raptus/status-page-to-chat`, reference `refs/heads/main`, compose file `docker-compose.yml`. Portainer pulls the compose file from Git and stays in sync if you enable **automatic updates**.
   - **Web editor**: paste the contents of `docker-compose.yml` from the repo.
4. Under **Environment variables**, set:
   - `WEBHOOK_URL` = the actual webhook URL
5. **Deploy the stack**.

Portainer pulls the image (using the GHCR credentials registered in step 2), creates the named volume `status-page-to-chat_state`, and starts the container.

### 4. Verify

In **Portainer → Containers → status-page-to-chat → Logs** you should see, within ~30 seconds:

- A `Configuration loaded` line with `providerCount: 19`
- A `Poller scheduled` line listing the next cron run
- One or more `incidents fetched` lines per provider
- A `run_summary` line with counters (`providersTotal`, `providersSucceeded`, …)

A real or manually injected incident triggers a chat message on the next poll cycle.

## Ongoing deployment (updates)

- **Code or provider changes** merged to `main` → GitHub Actions rebuilds and publishes the image as `latest` and `<sha>`.
- **Pulling the new image** in Portainer:
  - **Stacks → status-page-to-chat → Editor → Update the stack** (with **Re-pull image** enabled), or
  - With **Stack auto-update** turned on (Portainer Business or via the Edge agent), Portainer polls GHCR periodically and applies updates automatically.

The previous image stays cached on the host until pruned, providing a quick rollback target.

## Secrets

Only `WEBHOOK_URL` is secret. It lives in the Portainer stack environment — never in the repo, never in the image.

Rotating the webhook:

1. Generate a new webhook in the target chat channel.
2. Portainer → Stacks → status-page-to-chat → **Editor** → environment variables → update `WEBHOOK_URL` → **Update the stack**. Portainer recreates the container with the new value.

## Rollback

- Image rollback: edit the stack to pin a previous tag (e.g. `ghcr.io/raptus/status-page-to-chat:sha-<old>`), update the stack.
- Configuration rollback: `git revert` the offending commit on `main`. CI rebuilds `latest`; redeploy the stack to pull the rollback image.

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

The SQLite file lives in the named volume; `docker compose down -v` resets state.

## Self-monitoring

- **Container restart policy**: `unless-stopped` in the compose file — Docker restarts the container on crash.
- **Portainer events**: Portainer surfaces container state changes in its UI and can be wired up to webhook/email notifications under **Settings → Notifications** (Portainer Business) or via an external watcher (e.g. `containrrr/watchtower` or a small `docker events` script) on Community.
- **Run-level observability**: every poll cycle emits a structured `run_summary` JSON log line. Use `docker logs` or the Portainer log view to inspect, or forward to an external log collector if needed later.

A frozen-but-running process (cron loop hung) is not detected by container-state monitors. If that failure mode ever materialises, add a heartbeat file the poller touches each cycle plus a host-side check (cron or systemd timer) of its mtime — kept out of v1 deliberately.

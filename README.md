# status-page-to-chat

A small self-hosted service that monitors the status pages of external providers and posts new incidents and their resolutions to **Google Chat** or **Microsoft Teams**.

Designed to be cheap and forgettable: a single Docker container, SQLite for state, a webhook URL as the only secret. Five providers (Atlassian Statuspage, Google Workspace, Metanet RSS, WEDOS, GitHub Issues) cover dozens of services out of the box.

---

## Quick deploy (5 minutes)

You need a Docker host. Anywhere will do — a Synology with Portainer, a Raspberry Pi, a small VM, your laptop while you try it out.

1. **Get a webhook URL** for your chat target (Google Chat: channel `⋮` → Apps & integrations → Webhooks; Teams: channel `…` → Workflows → "Post to a channel when a webhook request is received"). Copy the URL.
2. **Pick the services you want to watch**. Either fork this repo and edit `config/providers.yaml`, or start with the default config (which monitors a fairly wide set of common SaaS products) and adapt later.
3. **Deploy**:

   ```bash
   mkdir status-page-to-chat && cd status-page-to-chat
   curl -O https://raw.githubusercontent.com/gzuercher/status-page-to-chat/main/docker-compose.yml
   echo "WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/..." > .env
   docker compose up -d
   ```

   Or in **Portainer → Stacks → Add stack → Web editor**, paste the contents of `docker-compose.yml`, set `WEBHOOK_URL` under **Environment variables**, deploy.
4. **Watch the logs**: `docker compose logs -f` — you should see `Configuration loaded`, `Poller scheduled`, and a `run_summary` line within ~30 seconds.
5. **Update later**: `docker compose pull && docker compose up -d` (or click "Update the stack" in Portainer with re-pull enabled).

That's it. No cloud account, no infrastructure setup.

## How it works

1. A long-running Node.js process polls every 5 minutes.
2. For each configured service, the status page is queried via the appropriate **adapter** (Atlassian Statuspage, Google Workspace, Metanet RSS, WEDOS, GitHub Issues).
3. New or newly resolved incidents are compared against the last known state (SQLite).
4. On state change, a formatted message is posted via webhook.

**Message format**:

- **New**: `⚠️ <Provider> has reported an incident: "<Title>"` + link to incident
- **Resolved**: `✅ <Provider> has resolved the incident: "<Title>"` + link

## Configuration

All runtime configuration lives in `config/providers.yaml` in the image. To customise:

- **Easiest**: fork the repo, edit `config/providers.yaml`, push — your fork's CI rebuilds the image and you point your stack at it.
- **No fork**: mount your own `providers.yaml` into the container and set `CONFIG_PATH=/config/providers.yaml`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Environment variables you can set:

| Variable | Default | Purpose |
|---|---|---|
| `WEBHOOK_URL` | required | Google Chat or Teams webhook URL |
| `CONFIG_PATH` | `./config/providers.yaml` | Path to a custom providers config |
| `STATE_DB_PATH` | `/data/state.sqlite` | SQLite file location |
| `POLL_CRON` | `*/5 * * * *` | When the poller runs |
| `LOG_LEVEL` | `info` | pino log level |
| `USER_AGENT` | `status-page-to-chat/<version> (+<repo>)` | Override the outbound User-Agent (e.g. add a contact address) |

## Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, modules, data flow |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Format of `config/providers.yaml` and env vars |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Specification per status page adapter |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment via Portainer, step by step |

## Development

```bash
pnpm install
pnpm build
pnpm test
WEBHOOK_URL='https://webhook.site/<your-slot>' STATE_DB_PATH=./data/state.sqlite pnpm start
```

Requirements: Node.js 20+, pnpm (via `corepack enable`). Optional: Docker for container work.

## License

MIT — see [LICENSE](LICENSE). Use, fork, modify, redeploy as you wish.

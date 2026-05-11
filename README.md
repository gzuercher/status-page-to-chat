# status-page-to-chat

A small self-hosted service that monitors the status pages of external providers and posts new incidents and their resolutions to **Google Chat** or **Microsoft Teams**.

Designed to be cheap and forgettable: a single Docker container, SQLite for state, a webhook URL as the only secret. Five providers (Atlassian Statuspage, Google Workspace, Metanet RSS, WEDOS, GitHub Issues) cover dozens of services out of the box.

---

## Quick deploy (3 minutes)

You need a Docker host. Anywhere will do — a Synology, a Raspberry Pi, a small VM, your laptop while you try it out.

1. **Get a webhook URL** for your chat target (Google Chat: channel `⋮` → Apps & integrations → Webhooks; Teams: channel `…` → Workflows → "Post to a channel when a webhook request is received"). Copy the URL.
2. **Deploy with zero providers configured**:

   ```bash
   mkdir status-page-to-chat && cd status-page-to-chat
   curl -O https://raw.githubusercontent.com/gzuercher/status-page-to-chat/main/docker-compose.yml
   curl -o providers.yaml https://raw.githubusercontent.com/gzuercher/status-page-to-chat/main/providers.yaml.example
   echo "WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/..." > .env
   docker compose up -d
   ```

   The container is now running with an **empty provider list**. Logs will show `providerCount: 0` and quiet poll cycles. No webhook traffic until you add at least one entry.

3. **Add the services you want to watch**. Two ways:

   - **Edit `providers.yaml` on the host** — see the examples already commented in the file. Save, wait up to 5 minutes for the next poll cycle.
   - **Use the management API** — `PUT /api/providers/<key>` with a small JSON body. Convenient from a chat-driven LLM assistant; see [docs/LLM-INTEGRATION.md](docs/LLM-INTEGRATION.md).

4. **Watch the logs**: `docker compose logs -f` — you should see `Configuration loaded`, `Poller scheduled`, and a `run_summary` line within ~30 seconds.

5. **Update later**: `docker compose pull && docker compose up -d`.

That's it. No cloud account, no fork, no infrastructure setup. Adding providers happens after the container is already running, not before.

## How it works

1. A long-running Node.js process polls every 5 minutes.
2. For each configured service, the status page is queried via the appropriate **adapter** (Atlassian Statuspage, Google Workspace, Metanet RSS, WEDOS, GitHub Issues).
3. New or newly resolved incidents are compared against the last known state (SQLite).
4. On state change, a formatted message is posted via webhook.

**Message format**:

- **New**: `⚠️ <Provider> has reported an incident: "<Title>"` + link to incident
- **Resolved**: `✅ <Provider> has resolved the incident: "<Title>"` + link

## Configuration

The default deploy mounts `./providers.yaml` from the host into the container at `/data/providers.yaml`. Edit that file directly to add, remove, or adjust providers — the next poll cycle (max 5 min) picks up changes automatically. If the edited file is invalid, the container keeps running on the previous configuration and logs a warning, so a typo never takes the service down.

For schema details and per-adapter options see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

**Advanced — bake config into the image (fork-based workflow):** edit `config/providers.yaml` in a fork, push, let CI build a tagged image, point your stack at it. Useful only if you want config to be version-controlled in Git. For most operators, editing `providers.yaml` on the host is simpler.

Environment variables you can set:

| Variable | Default | Purpose |
|---|---|---|
| `WEBHOOK_URL` | required | Google Chat or Teams webhook URL |
| `CONFIG_PATH` | `/data/providers.yaml` (in compose) | Path to the providers config |
| `STATE_DB_PATH` | `/data/state.sqlite` | SQLite file location |
| `POLL_CRON` | `*/5 * * * *` | When the poller runs |
| `LOG_LEVEL` | `info` | pino log level |
| `USER_AGENT` | `status-page-to-chat/<version> (+<repo>)` | Override the outbound User-Agent (e.g. add a contact address) |
| `HEALTH_MAX_AGE_SECONDS` | `900` | Healthcheck threshold — container is reported unhealthy if no poll completed within this window |

## Configure via chat

You can hand over day-to-day maintenance — adding, removing, and inspecting providers — to a backoffice colleague who never touches the host. The container ships an OpenAPI-described REST API; point any OpenAPI-aware LLM platform at it (Langdock, ChatGPT Custom GPTs, OpenWebUI, your own assistant) and they manage the watch list in natural language. See [docs/LLM-INTEGRATION.md](docs/LLM-INTEGRATION.md) for platform-specific setup walkthroughs and [docs/API.md](docs/API.md) for the underlying endpoints.

## Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, modules, data flow |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Format of `providers.yaml` and env vars |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Specification per status page adapter |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment via Portainer, step by step |
| [docs/API.md](docs/API.md) | Management API reference with `curl` examples |
| [docs/LLM-INTEGRATION.md](docs/LLM-INTEGRATION.md) | Chat-based maintenance via any OpenAPI-aware LLM platform |

## Development

```bash
pnpm install
pnpm build
pnpm test
WEBHOOK_URL='https://webhook.site/<your-slot>' STATE_DB_PATH=./data/state.sqlite pnpm start
```

Requirements: Node.js 22.19+, pnpm (via `corepack enable`). Optional: Docker for container work.

## Shipping a change

One step: **open a Pull Request and merge it.** Everything else (Docker build, image push to GHCR, `:latest` tag update) runs automatically — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). Use, fork, modify, redeploy as you wish.

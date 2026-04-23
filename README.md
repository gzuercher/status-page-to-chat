# status-page-to-chat

A small service that monitors the status pages of external providers (Cloudflare, Bexio, Webflow, Bitwarden, Zendesk, and many more) and automatically posts new incidents and their resolutions to **Google Chat** or **Microsoft Teams**.

Operator: [Raptus AG](https://raptus.ch), Lyss.

---

## Motivation

- The team should be proactively informed about disruptions with external services before customers ask.
- Support requests ("Our website is down") can be assessed more quickly when it's known that, for example, Webflow is currently reporting an incident.
- Questions like "Is it working for you?" become unnecessary.

## How it works (summary)

1. A long-running Node.js process (containerised) polls every 5 minutes.
2. For each configured service, the status page is queried via the appropriate **adapter** (Atlassian Statuspage, Google Workspace, Metanet RSS, WEDOS, GitHub Issues).
3. New or newly resolved incidents are compared against the last known state (SQLite).
4. On state change, a formatted message is sent via webhook to the configured chat channel.

**Message format**:

- **New**: `⚠️ <Provider> has reported an incident: "<Title>"` + link to incident
- **Resolved**: `✅ <Provider> has resolved the incident: "<Title>"` + link

## Hosting and costs

- **Platform**: Docker container on the Raptus Synology NAS (Container Manager)
- **Runtime**: Node.js 20 on `node:20-alpine`
- **Scheduler**: In-process cron (`croner`), default `*/5 * * * *`
- **State**: SQLite file on a Docker volume (`/data/state.sqlite`)
- **Logs**: stdout → Docker JSON file driver → Container Manager log viewer
- **Self-monitoring**: Synology Container Manager notification on container stop / restart loop

No cloud dependency, no recurring cost beyond the NAS that Raptus already runs.

## Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, modules, data flow |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Format of `config/providers.yaml` and env vars |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Specification per status page adapter |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment to Synology, step by step |
| [docs/AGENTS.md](docs/AGENTS.md) | Multi-agent work and responsibilities |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Implementation order and open items |
| [docs/PLAN.md](docs/PLAN.md) | Original architecture plan (historical reference) |

## Quick start (local development)

```bash
pnpm install
pnpm build
pnpm test
WEBHOOK_URL='https://webhook.site/<your-slot>' STATE_DB_PATH=./data/state.sqlite pnpm start
```

Or with Docker:

```bash
echo "WEBHOOK_URL=https://webhook.site/<your-slot>" > .env
docker compose up --build
```

## Prerequisites (for development)

- Node.js 20+
- pnpm (via `corepack enable`)
- Optional: Docker + Docker Compose for container work

## License

MIT — see [LICENSE](LICENSE).

## Raptus Claude Playbook

This repo also contains the [Raptus Claude Playbook](CLAUDE.md) with team rules for collaboration with Claude Code. See `CLAUDE.md` and `.claude/rules/`.

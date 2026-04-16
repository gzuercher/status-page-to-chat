# status-page-to-chat

A small service that monitors the status pages of external providers (Cloudflare, Bexio, Webflow, Bitwarden, Zendesk, and many more) and automatically posts new incidents and their resolutions to **Google Chat** or **Microsoft Teams**.

Operator: [Raptus AG](https://raptus.ch), Lyss.

---

## Motivation

- The team should be proactively informed about disruptions with external services before customers ask.
- Support requests ("Our website is down") can be assessed more quickly when it's known that, for example, Webflow is currently reporting an incident.
- Questions like "Is it working for you?" become unnecessary.

## How it works (summary)

1. An Azure Function Timer Trigger runs every 5 minutes.
2. For each configured service, the status page is queried via the appropriate **adapter** (Atlassian Statuspage, Google Workspace, Metanet RSS, WEDOS, GitHub Issues).
3. New or newly resolved incidents are compared against the last known state (Azure Table Storage).
4. On state change, a formatted message is sent via webhook to the configured chat channel.

**Message format**:

- **New**: `⚠️ <Provider> has reported an incident: "<Title>"` + link to incident
- **Resolved**: `✅ <Provider> has resolved the incident: "<Title>"` + link

## Hosting and costs

- **Platform**: Microsoft Azure (Raptus tenant)
- **Runtime**: Azure Functions (Consumption Plan, Linux, Node.js 20)
- **State**: Azure Table Storage
- **Logs**: Application Insights
- **Self-monitoring**: Azure Monitor Alert Rule → email on failure

Expected operating costs: **under CHF 1 per month** (288 executions/day is well below the 1M free tier).

## Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, modules, data flow |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Format of `config/providers.yaml` |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Specification per status page adapter |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Azure deployment step by step |
| [docs/AGENTS.md](docs/AGENTS.md) | Multi-agent work and responsibilities |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Implementation order and open items |
| [docs/PLAN.md](docs/PLAN.md) | Original architecture plan (reference) |

## Project status

> **Status**: Implementation complete. Awaiting first deployment to Azure.

Entry point for deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Prerequisites (for development)

- Node.js 20+
- pnpm
- Azure CLI (`az`)
- Azure Functions Core Tools (`func`)
- Access to the Raptus Azure tenant

## License

MIT — see [LICENSE](LICENSE).

## Raptus Claude Playbook

This repo also contains the [Raptus Claude Playbook](CLAUDE.md) with team rules for collaboration with Claude Code. See `CLAUDE.md` and `.claude/rules/`.

# Agent Guide

This document is written for **humans and for Claude Code agents**. A new agent (or a person on a different machine) should have enough context from **this document + `docs/PLAN.md` + `CLAUDE.md`** to work productively.

## First steps for a new agent

1. Read in this order:
   - `CLAUDE.md` (Raptus rules, communication language, forbidden DIY implementations)
   - `README.md` (project overview)
   - `docs/PLAN.md` (original architecture plan)
   - `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/ADAPTERS.md`
   - `docs/ROADMAP.md` (what to do next)
2. Check current project state: `git log --oneline`, `ls src/`.
3. Pick an open task from the roadmap or align with the human.

## Project language and conventions

- **Communication with the user**: English
- **Comments and documentation**: English
- **Identifiers (variables, functions, files)**: English
- **Commit messages**: German, imperative ("Füge Adapter für Metanet hinzu")
- **TypeScript strict**, no `any`
- **No `console.log`**, use the `pino` logger
- See `.claude/rules/` for details

## Multi-agent work

Multiple agents may work **in parallel** on the project, but only in isolated scopes. Recommended model: **one agent per logical unit** (module, feature, PR).

### Isolation

- Use **git worktrees** so multiple agents can work simultaneously without overwriting each other:

```bash
git worktree add ../status-page-to-chat-adapter-google feature/adapter-google-workspace
git worktree add ../status-page-to-chat-notifier-teams feature/notifier-teams
```

- Within Claude Code: `isolation: "worktree"` when spawning an agent.
- Each agent works on its own feature branch and opens its own PR.

### Responsibility areas

To minimise merge conflicts, the project is divided into **independent zones**:

| Zone | Responsible agent / branch | Typical files |
|---|---|---|
| Foundation | `core` | `package.json`, `tsconfig.json`, `host.json`, `src/lib/types.ts` |
| Config | `config` | `src/lib/config.ts`, `config/providers.yaml` |
| State | `state` | `src/state/tableStore.ts` |
| Adapter: Atlassian | `adapter-atlassian` | `src/adapters/atlassianStatuspage.ts` + test |
| Adapter: Google | `adapter-google` | `src/adapters/googleWorkspace.ts` + test |
| Adapter: Metanet | `adapter-metanet` | `src/adapters/metanetRss.ts` + test |
| Adapter: WEDOS | `adapter-wedos` | `src/adapters/wedosStatusOnline.ts` + test |
| Adapter: GitHub | `adapter-github` | `src/adapters/githubIssues.ts` + test |
| Notifier: Google Chat | `notifier-gchat` | `src/notifiers/googleChat.ts` + test |
| Notifier: Teams | `notifier-teams` | `src/notifiers/teams.ts` + test |
| Orchestration | `orchestration` | `src/functions/poll.ts` |
| Infrastructure | `infra` | `infra/main.bicep` |
| Docs | `docs` | `docs/*.md` |

**Order matters**: Foundation → Types → Config → State → Adapters/Notifiers (parallel) → Orchestration → Infra. Adapter agents should pause until the foundation is in place.

### Coordination

- **One central `lessons.md`** documents errors and corrections (Raptus rule).
- **Pull Requests** are the coordination point. No direct push to `main`.
- When uncertain about scope: **ask**, don't guess (Raptus principle: no uninvited refactoring).

## Tool recommendations within Claude Code

The commands and agents defined in the Raptus Playbook are also available here:

| Tool | Purpose |
|---|---|
| `/commit-push-pr` | Commit, push, create PR |
| `/review` | Code review of the current branch |
| `/build-and-test` | Run build and tests |
| Agent `code-reviewer` | Thorough review with security focus |
| Agent `verify-app` | Verification after larger changes |

## Local development (for agent or human)

### Prerequisites

- Node.js 20+
- pnpm (`npm i -g pnpm`)
- Azure Functions Core Tools (`npm i -g azure-functions-core-tools@4 --unsafe-perm true`)
- Azurite as local storage emulator (`npm i -g azurite`)

### Initial setup

```bash
git clone git@github.com:gzuercher/status-page-to-chat.git
cd status-page-to-chat
pnpm install
cp local.settings.json.example local.settings.json  # then adjust values
```

### Development cycle

```bash
pnpm build         # compile TypeScript
pnpm test          # vitest
pnpm lint          # eslint + prettier check
azurite --silent & # start local storage
func start         # run Function locally
```

## Important limits (for agents)

- **No irreversible actions** without explicit confirmation: no `git push --force`, no `rm -rf`, no Azure resource deletion.
- **No secrets in code**: webhook URLs, tokens, passwords belong in App Settings.
- **No `--no-verify`** on commits.
- **When uncertain about scope**: ask rather than "do everything" (Raptus rule: no uninvited refactoring).
- **On error corrections**: document the lesson in `lessons.md` (format: `- [YYYY-MM-DD]: [What was wrong] → [Correct approach]`).

## State files for re-entry

So an agent on a different machine can pick up the thread, the following artefacts must be current in the repo:

- `docs/ROADMAP.md` — open items with status
- `docs/PLAN.md` — architectural plan (should match current state; for larger deviations: add a new section at the end)
- `lessons.md` — mistakes made
- `config/providers.yaml` — current set of monitored services

## What this service is and isn't

**Is**: A lean, well-maintainable monitoring notifier for external status pages.

**Is not**: A general monitoring tool, an uptime prober, an SRE dashboard, an incident management platform. For those purposes please use specialised solutions (Uptime Kuma, Better Stack, PagerDuty, Grafana Cloud, …).

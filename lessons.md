# Lessons Learned

This document is maintained automatically. When Claude makes a mistake and is corrected, the lesson is documented here.

Format: `- [YYYY-MM-DD]: [What was wrong] → [Correct approach]`

## Lessons

<!-- Add new entries at the top -->

- [2026-04-23]: Built and kept an Azure Functions + Bicep + Action-Group + Alert-Rule stack for a workload that is a 5-minute cron polling ~15 HTTP endpoints → Match infrastructure weight to the actual workload. For a tiny cron-like service, a single container on existing host infrastructure (here: the Raptus Synology NAS) beats a multi-service cloud setup on cost, operational surface and reviewability. Stop accepting "it's cheap, it'll do no harm" as a reason to keep over-engineered infrastructure around.
- [2026-04-23]: After translating log/error strings to English, the test assertions still matched the old German strings and `pnpm lint` had unformatted files — baseline on main was red → When a large edit pass changes user-visible strings, run the full `pnpm build && pnpm test && pnpm lint` *before* committing, not only the narrow subset touched. Translation commits in particular need a full-suite check.
- [2026-04-15]: Documentation not updated immediately after code/config changes (provider list in `ADAPTERS.md`, adapter table in `PLAN.md`, filter task and risks in `ROADMAP.md` remained stale until the user explicitly asked) → Documentation update is part of every change. After each edit, actively check which documentation sections describe the changed area and update them in the same pass.
- [2026-04-15]: Proposed a realistic browser user-agent as a workaround for Sophos' blocked API → Browser impersonation is explicitly forbidden by `docs/CONFIGURATION.md` (section "HTTP User-Agent") because it borders on a ToS violation. When blocked, choose one of the documented alternatives (contact the provider, HTML scraping adapter, or consciously defer the provider).
- [2026-04-15]: Treated the Sophos API endpoint as "reachable" because HTTP status 200 was returned — but the body was a 404 HTML page → HTTP status code alone is not proof of a valid response. Always additionally check Content-Type and wrap JSON parsing in try/catch. Atlassian Statuspage returns an HTML error page with status 200 when the public API is disabled.

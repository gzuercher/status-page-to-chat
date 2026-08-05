# Configuration

There are two configuration surfaces:

- **`providers.yaml`** — the list of monitored status pages. With the default Docker Compose setup it lives on the host (next to `docker-compose.yml`) and is bind-mounted into the container at `/data/providers.yaml`. Edit the file and the next poll cycle (within 5 min) picks up the change. The same file can also be edited via the REST API (see [API.md](API.md)) — handy for chat-driven maintenance via any OpenAPI-aware LLM platform; see [LLM-INTEGRATION.md](LLM-INTEGRATION.md).
- **Environment variables** — set on the container (webhook URL, API token, timing knobs). See the table further down.

The repository also ships `config/providers.yaml` baked into the image, but that's only relevant for the advanced fork-based workflow where you don't want a separate file on the host. The mounted-file path is the documented default.

## Schema

```yaml
# Required fields
chatTarget: googleChat         # "googleChat" | "teams" | "teamsJson"

# Optional: UI language for the chat cards and the target language for
# machine-translated incident titles. "de" (default) | "en".
# Override per deployment with the LANGUAGE env var.
language: de

# List of monitored services
providers:
  - key: <string>              # Unique key, only [a-z0-9-]
    displayName: <string>      # How the name appears in chat ("Bexio", "Webflow")
    description: <string>      # optional, one-line service blurb shown on the card
                               # (max 280 chars, author it in your `language`)
    adapter: <adapter-name>    # see ADAPTERS.md
    # adapter-specific fields:
    baseUrl: <url>             # required for atlassian-statuspage, wedos-status-online,
                               # betterstack-feed, hund-atom, zendesk-ssp, html-scrape
    owner: <string>            # required for github-issues
    repo: <string>             # required for github-issues
    selector: <css-selector>   # required for html-scrape
    healthyMatch: <string>     # required for html-scrape — text or attribute value
                               # that means "no incident"
    titleTemplate: <string>    # optional, only for html-scrape
    componentFilter: <list<string> | string>   # optional, atlassian-statuspage + zendesk-ssp
                               # case-insensitive substring match, OR logic. A single
                               # string is split on commas, so `a, b` means [a, b].
                               # Verify names against <baseUrl>/api/v2/components.json —
                               # a filter that stops matching silences the provider.
    logoUrl: <url>             # optional, override the auto-derived brand favicon
                               # (set this when the status host's icon is not the brand's,
                               # e.g. wedos.status.online shows the status platform's logo)
                               # Legacy www.google.com/s2/favicons values are upgraded
                               # automatically — see "Brand logos" below.
    userAgent: <string>        # optional, overrides the default User-Agent for this provider
```

## Brand logos

Cards carry the provider's brand icon. Without an explicit `logoUrl` it is derived from the host of
`baseUrl`; providers without a `baseUrl` (e.g. `github-issues`) render without a logo.

The icon is fetched **by the chat client**, not by this service, so the URL has to resolve in a
single hop. We therefore address Google's `t0.gstatic.com/faviconV2` endpoint directly instead of
the older `www.google.com/s2/favicons`, which answers `301` — Teams does not follow that
cross-origin redirect and shows a broken image. The same endpoint also returns a usable icon for
hosts that the legacy URL answers `404` for (`status.zendesk.com`, `wedos.status.online`).

Existing `logoUrl` values pointing at the legacy endpoint are rewritten automatically at load time,
so no configuration edit is required. Any other URL is used verbatim — point `logoUrl` at your own
CDN if you want full control.

Set `logoUrl` explicitly when the status host's favicon is not the brand's. `wedos.status.online`,
for instance, serves the status platform's green checkmark rather than the WEDOS logo.

## Output formats: `teams` vs `teamsJson`

Both targets POST to the same kind of webhook (`WEBHOOK_URL`), but differ in the payload:

- **`teams`** — this service builds the finished **Adaptive Card** and posts it. Self-contained; what
  you see is what Teams renders. Titles are machine-translated (see below).
- **`teamsJson`** — this service posts the **raw normalized event as JSON**; a downstream renderer
  (e.g. an Azure Logic App) builds the card from a central template. Use this when card layout is owned
  centrally across several feeds. No translation happens here — the raw source-language `title` is sent,
  and any translation/presentation belongs to the central renderer.

The JSON envelope (`teamsJson`, `schemaVersion: 2`). The key set is **stable across all variants**: every optional field is always present as `null` when unset (never omitted), so a template engine like Logic Apps can reference every field unconditionally. `severity` and `language` are included so the renderer needs no knowledge of our internal derivation rules; `title` is verbatim (source language) — translation belongs to the renderer.

```json
{ "schemaVersion": 2, "source": "status-page-to-chat",
  "event": "incident.opened",           // incident.opened | incident.resolved
  "severity": "problem",                // problem (opened) | ok (resolved)
  "language": "de",                     // configured target UI language
  "incident": {
    "externalId": "…", "providerKey": "…", "displayName": "…",
    "title": "…",                       // source language, not translated
    "description": null,                // string | null
    "status": "open",                   // open | resolved
    "url": "…", "startedAt": "…", "updatedAt": "…",
    "logoUrl": null                     // string | null
  } }
```

```json
{ "schemaVersion": 2, "source": "status-page-to-chat",
  "event": "adapter.down",              // adapter.down | adapter.recovered | adapter.halfDead
  "severity": "problem",                // problem (down, halfDead) | ok (recovered)
  "language": "de",
  "alert": {
    "kind": "down",                     // down | recovered | halfDead
    "providerKey": "…", "providerName": "…",
    "logoUrl": null,                    // string | null
    "errorCategory": "HTTP 503",        // string (down) | null (recovered, halfDead)
    "durationLabel": "2h"               // pre-formatted, language-neutral duration:
                                        // "<1min" | "30min" | "2h" | "2h 15min" | "7d"
  } }
```

## Localisation & translation (Teams)

The Teams Adaptive Card is fully localised and defaults to **German**.

- **Static text** (status badges, button, field labels, adapter-health messages, error categories) comes from a built-in `de`/`en` dictionary — no external service involved. Pick the language with the top-level `language` field or the `LANGUAGE` env var.
- **Incident titles** are provider-supplied and usually English. They are machine-translated into `language` via the **Claude API (Haiku)** when `ANTHROPIC_API_KEY` is set. Translations are cached in SQLite keyed by source text, so repeated titles (a given incident's *opened* and *resolved* cards share one title) cost a single API call. If no key is set, or a call fails, the **original title is shown** — translation never blocks a notification.
- **Service descriptions** (`description` per provider) are shown verbatim — author them in your target language.

> Google Chat cards are not localised yet — they remain English regardless of `language`.

### Teams webhook format

For Teams, `WEBHOOK_URL` must be a **Power Automate Workflows** webhook (the "Post to a channel when a webhook request is received" flow). The notifier posts the **bare Adaptive Card** JSON as the request body — the flow's "Post card in a chat or channel" action renders it directly (e.g. via `string(variables('Body'))`). Do **not** point this at a legacy Office 365 connector webhook: those expect the `{ "type": "message", "attachments": [{ "content": … }] }` envelope, and mixing the two formats makes the card render as an empty box (the flow still reports "Succeeded").

## HTTP User-Agent

All outgoing HTTP requests send a uniform, descriptive User-Agent by default:

```
status-page-to-chat/<version> (+https://github.com/gzuercher/status-page-to-chat)
```

This follows the common practice for well-behaved pollers, respects the logs of status page operators, and makes it easy to get in touch if we are stressing an endpoint. The version is pulled from `package.json` at runtime.

**Global override** — via environment variable `USER_AGENT` (rarely needed, e.g. for tests).

**Per-provider override** — via the optional field `userAgent` in `providers.yaml`. Use only for documented exceptions:

- Endpoint behind a WAF that blocks the default. Justify the decision in the pull request. (Example Sophos: API endpoints are completely blocked — a User-Agent override alone is not sufficient; see commented-out entry in `providers.yaml`.)
- The provider explicitly requires a different format (no known case yet).

⚠️ Impersonating a browser is not a valid reason — it borders on a ToS violation. Prefer contacting the provider or accepting a 403 from the adapter.

## Validation

The file is validated with **`zod`** on container startup. Errors are logged and prevent startup. Minimum requirements:

- `chatTarget` ∈ `{googleChat, teams, teamsJson}`
- `language` ∈ `{de, en}` (optional, defaults to `de`)
- at least one entry in `providers`
- `key` is unique
- adapter-specific required fields are present

## Example (complete)

```yaml
chatTarget: googleChat

providers:
  # --- Atlassian Statuspage ---
  - key: bitbucket
    displayName: Bitbucket
    adapter: atlassian-statuspage
    baseUrl: https://bitbucket.status.atlassian.com

  - key: bitwarden
    displayName: Bitwarden
    adapter: atlassian-statuspage
    baseUrl: https://status.bitwarden.com

  - key: bexio
    displayName: Bexio
    adapter: atlassian-statuspage
    baseUrl: https://www.bexio-status.com

  - key: webflow
    displayName: Webflow
    adapter: atlassian-statuspage
    baseUrl: https://status.webflow.com

  - key: zendesk-helpcenter
    displayName: Zendesk Help Center
    adapter: atlassian-statuspage
    baseUrl: https://status.zendesk.com
    componentFilter: example-helpcenter     # placeholder — replace with your subdomain
                                            # (for the real status.zendesk.com use the
                                            # zendesk-ssp adapter; the service formerly
                                            # called "Help Center" is now "Knowledge")

  - key: kaseya-itglue
    displayName: Kaseya IT Glue
    adapter: atlassian-statuspage
    baseUrl: https://status.kaseya.com
    componentFilter: IT Glue                # only the IT Glue product

  - key: gravityzone-bitdefender
    displayName: Bitdefender GravityZone
    adapter: atlassian-statuspage
    baseUrl: https://status.gravityzone.bitdefender.com
    componentFilter:                        # only the cloud instances actually used
      - cloudgz.gravityzone.bitdefender.com
      - cloud.gravityzone.bitdefender.com

  # --- Sophos: DEFERRED (see ROADMAP.md) ---
  # status.sophos.com runs on Atlassian Statuspage, but all
  # machine-readable endpoints (/api/v2/*, /history.atom, /history.rss)
  # respond with HTTP 200 and return a 404 HTML page instead of JSON —
  # even with a browser User-Agent. Enable requires Sophos opening the
  # API or an HTML scraping adapter (see ROADMAP → Later extensions).
  # - key: sophos
  #   displayName: Sophos
  #   adapter: atlassian-statuspage
  #   baseUrl: https://status.sophos.com

  # --- Google Workspace ---
  - key: google-workspace
    displayName: Google Workspace
    adapter: google-workspace

  # --- WEDOS ---
  - key: wedos
    displayName: WEDOS
    adapter: wedos-status-online
    baseUrl: https://wedos.status.online

  # --- GitHub Issues as status tracker ---
  - key: onetimesecret
    displayName: Onetime Secret
    adapter: github-issues
    owner: onetimesecret
    repo: status
```

## Environment variables (secrets and runtime overrides)

Everything that is not in `providers.yaml` lives as an environment variable on the container. `WEBHOOK_URL`, `ANTHROPIC_API_KEY` and `API_TOKEN` are secrets — keep them out of the YAML and out of version control.

| Variable | Required | Description |
|---|---|---|
| `WEBHOOK_URL` | yes | Google Chat Incoming Webhook, Teams (Workflows) webhook, or (for `teamsJson`) the JSON-consuming endpoint (e.g. a Logic App HTTP trigger) — matches `chatTarget` |
| `ANTHROPIC_API_KEY` | no | Claude API key. When set, Teams incident titles are machine-translated into `language`. Unset → titles shown untranslated. |
| `LANGUAGE` | no | Overrides the `language` field from `providers.yaml` (`de` \| `en`). Default: `de`. |
| `TRANSLATE_MODEL` | no | Claude model id used for translation. Default: `claude-haiku-4-5-20251001`. |
| `CONFIG_PATH` | no | Absolute path to the providers config. Compose sets this to `/data/providers.yaml`. If unset, the image falls back to its baked-in `config/providers.yaml`. |
| `STATE_DB_PATH` | no | Path to the SQLite file. Default in the container: `/data/state.sqlite`. |
| `POLL_CRON` | no | Cron expression for the scheduler. Default: `*/5 * * * *`. |
| `LOG_LEVEL` | no | pino log level (`debug`, `info`, `warn`, `error`). Default: `info`. |
| `USER_AGENT` | no | Overrides the default User-Agent globally (rarely needed, e.g. for tests). |
| `API_TOKEN` | no | Bearer token guarding the management REST API. Required unless `API_AUTH_DISABLED=true`. |
| `API_AUTH_DISABLED` | no | Set to literal `true` to disable API auth entirely (only on trusted networks). |
| `API_PORT` | no | Port the management API listens on. Default: `8080`. |
| `HEALTH_MAX_AGE_SECONDS` | no | Healthcheck threshold for "no recent poll" → unhealthy. Default: `900` (15 min). |

See [DEPLOYMENT.md](DEPLOYMENT.md) for how these are set with plain Docker Compose or Portainer.

## Previewing the chat cards

To send one example of every card type (incident opened/resolved and the three adapter-health variants) to the configured chat target — handy after a design change:

```bash
docker exec raptus-status-notifs node dist/src/main.js demo
```

Pass a type to send just one: `demo opened` | `resolved` | `down` | `recovered` | `halfdead`. The cards use clearly-labelled sample data ("Demo Service", "Beispielkarte – kein echter Vorfall") and exercise the real notifier and translator, so they look exactly like production cards.

## Adding or removing a status page

Three ways, pick what fits:

1. **Edit `providers.yaml` on the host.** The next poll cycle (within 5 min) picks up the change automatically — no restart. Use `docker compose run --rm status-poller node dist/src/main.js validate` to dry-run a change before saving.
2. **Use the REST API.** `PUT /api/providers/<key>` to add or update, `DELETE /api/providers/<key>` to remove. See [API.md](API.md) and [LLM-INTEGRATION.md](LLM-INTEGRATION.md). Same validation gate, same atomic write, comments in the YAML are preserved.
3. **Fork-based (advanced).** Edit `config/providers.yaml` in the repo, open a PR, merge → CI rebuilds the image → Portainer/compose pulls the new image. Use this when you want every config change tracked in Git.

To clean up SQLite state for a removed provider (optional, only saves a few rows):

```sql
DELETE FROM incidents WHERE provider_key = '<key>';
```

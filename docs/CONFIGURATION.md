# Configuration

There are two configuration surfaces:

- **`providers.yaml`** — the list of monitored status pages. With the default Docker Compose setup it lives on the host (next to `docker-compose.yml`) and is bind-mounted into the container at `/data/providers.yaml`. Edit the file and the next poll cycle (within 5 min) picks up the change. The same file can also be edited via the REST API (see [API.md](API.md)) — handy for chat-driven maintenance via any OpenAPI-aware LLM platform; see [LLM-INTEGRATION.md](LLM-INTEGRATION.md).
- **Environment variables** — set on the container (webhook URL, API token, timing knobs). See the table further down.

The repository also ships `config/providers.yaml` baked into the image, but that's only relevant for the advanced fork-based workflow where you don't want a separate file on the host. The mounted-file path is the documented default.

## Schema

```yaml
# Required fields
chatTarget: googleChat         # "googleChat" | "teams"

# List of monitored services
providers:
  - key: <string>              # Unique key, only [a-z0-9-]
    displayName: <string>      # How the name appears in chat ("Bexio", "Webflow")
    adapter: <adapter-name>    # see ADAPTERS.md
    # adapter-specific fields:
    baseUrl: <url>             # for "atlassian-statuspage", "wedos-status-online"
    owner: <string>            # for "github-issues"
    repo: <string>             # for "github-issues"
    componentFilter: <string | list<string>>  # optional, only for atlassian-statuspage
    userAgent: <string>        # optional, overrides the default User-Agent for this provider
```

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

- `chatTarget` ∈ `{googleChat, teams}`
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

Everything that is not in `providers.yaml` lives as an environment variable on the container. Only `WEBHOOK_URL` is secret.

| Variable | Required | Description |
|---|---|---|
| `WEBHOOK_URL` | yes | Google Chat Incoming Webhook **or** Teams (Workflows) webhook URL — matches `chatTarget` |
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

## Adding or removing a status page

Three ways, pick what fits:

1. **Edit `providers.yaml` on the host.** The next poll cycle (within 5 min) picks up the change automatically — no restart. Use `docker compose run --rm status-poller node dist/src/main.js validate` to dry-run a change before saving.
2. **Use the REST API.** `PUT /api/providers/<key>` to add or update, `DELETE /api/providers/<key>` to remove. See [API.md](API.md) and [LLM-INTEGRATION.md](LLM-INTEGRATION.md). Same validation gate, same atomic write, comments in the YAML are preserved.
3. **Fork-based (advanced).** Edit `config/providers.yaml` in the repo, open a PR, merge → CI rebuilds the image → Portainer/compose pulls the new image. Use this when you want every config change tracked in Git.

To clean up SQLite state for a removed provider (optional, only saves a few rows):

```sql
DELETE FROM incidents WHERE provider_key = '<key>';
```

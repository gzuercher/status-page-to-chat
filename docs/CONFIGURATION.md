# Configuration

All runtime configuration lives in **`config/providers.yaml`** in the repo. Changes are versioned, reviewable in pull requests, and become active with the next deployment.

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

  # --- Metanet (RSS) ---
  - key: metanet
    displayName: Metanet
    adapter: metanet-rss

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
| `CONFIG_PATH` | no | Absolute path to an alternative `providers.yaml`. Default: `./config/providers.yaml` inside the image. Use this to mount a host file over the baked-in default. |
| `STATE_DB_PATH` | no | Path to the SQLite file. Default in the container: `/data/state.sqlite`. |
| `POLL_CRON` | no | Cron expression for the scheduler. Default: `*/5 * * * *`. |
| `LOG_LEVEL` | no | pino log level (`debug`, `info`, `warn`, `error`). Default: `info`. |
| `USER_AGENT` | no | Overrides the default User-Agent globally (rarely needed, e.g. for tests). |

See [DEPLOYMENT.md](DEPLOYMENT.md) for how these are set in Portainer.

## Adding a status page (workflow)

1. Add a new entry to `config/providers.yaml` with the appropriate adapter (see [ADAPTERS.md](ADAPTERS.md)).
2. Open a pull request → review by a second person.
3. After merge: GitHub Actions rebuilds the image and pushes to GHCR as `latest`.
4. In Portainer → Stacks → status-page-to-chat → **Update the stack** (with re-pull image enabled). In the next poll cycle the new provider is live.

## Removing a status page

- Delete the entry from `providers.yaml` and merge.
- Optional: remove its rows in SQLite — `DELETE FROM incidents WHERE provider_key = '<key>'`. Otherwise the rows just sit idle.

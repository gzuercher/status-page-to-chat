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
raptus-status-monitor/<version> (+https://github.com/raptus/status-page-to-chat; ops@raptus.ch)
```

This follows the common practice for well-behaved pollers, respects the logs of status page operators, and makes it easy to get in touch if we are stressing an endpoint. The version is pulled from `package.json` at runtime.

**Global override** — via App Setting `USER_AGENT` (rarely needed, e.g. for tests).

**Per-provider override** — via the optional field `userAgent` in `providers.yaml`. Use only for documented exceptions:

- Endpoint behind a WAF that blocks the default. Justify the decision in the pull request. (Example Sophos: API endpoints are completely blocked — a User-Agent override alone is not sufficient; see commented-out entry in `providers.yaml`.)
- The provider explicitly requires a different format (no known case yet).

⚠️ Impersonating a browser is not a valid reason — it borders on a ToS violation. Prefer contacting the provider or accepting a 403 from the adapter.

## Validation

The file is validated with **`zod`** on Function startup. Errors are logged and prevent startup. Minimum requirements:

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
    componentFilter: raptus-helpcenter      # only alerts for our subdomain

  - key: kaseya-itglue
    displayName: Kaseya IT Glue
    adapter: atlassian-statuspage
    baseUrl: https://status.kaseya.com
    componentFilter: IT Glue                # only IT Glue is relevant for us

  - key: gravityzone-bitdefender
    displayName: Bitdefender GravityZone
    adapter: atlassian-statuspage
    baseUrl: https://status.gravityzone.bitdefender.com
    componentFilter:                        # only cloud instances used by Raptus
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

## App Settings (secrets, not in YAML)

Webhook URLs and alert recipients are stored **not** in `providers.yaml` but in the Azure Function App Settings:

| Setting | Description |
|---|---|
| `WEBHOOK_URL` | Google Chat Incoming Webhook **or** Teams Incoming Webhook — depending on `chatTarget` |
| `ALERT_EMAIL` | Recipient for self-monitoring alerts (Azure Monitor) |
| `USER_AGENT` | optional — overrides the default User-Agent globally |
| `AzureWebJobsStorage` | Set automatically by Bicep |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Set automatically by Bicep |

See [DEPLOYMENT.md](DEPLOYMENT.md) for setting values.

## Adding a status page (workflow)

1. Add a new entry to `config/providers.yaml` with the appropriate adapter (see [ADAPTERS.md](ADAPTERS.md)).
2. Open a pull request → review by a second person.
3. After merge: deployment triggers automatically (or `func azure functionapp publish`).
4. In the next 5-minute cycle the service is active.

## Removing a status page

- Delete the entry from `providers.yaml` and merge.
- Optional: delete the corresponding rows in Azure Table Storage (PartitionKey = `key`). Otherwise they remain inactive.

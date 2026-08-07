# Configure status-page-to-chat via chat

This guide is for the person who maintains the list of monitored status pages — typically a backoffice or operations role. No SSH, no Docker commands. They add providers, remove them, and check on the system through a chat interface backed by an LLM.

The container exposes a small **REST API** described by an **OpenAPI 3.1** spec at `/api/openapi.json`. Any LLM platform that understands OpenAPI tools (sometimes also called "Actions", "Tools", "Custom Connectors", or "Skills") can drive it. Many modern LLM platforms support both **OpenAPI** and **MCP (Model Context Protocol)** as tool-integration mechanisms — for those, either route works against this service:

- **OpenAPI directly** — paste `/api/openapi.json`, configure bearer auth, done. Simplest path.
- **MCP natively** — the service ships an MCP server at **`/mcp`** (streamable HTTP transport), authenticated with the same bearer token. No bridge needed.

Both surfaces expose the same operations and validate against the same schema, so the choice is purely which one your platform speaks. The MCP tools carry a longer descriptive prompt — including how to pick the right adapter from a URL — which tends to produce better first attempts from an LLM than the bare OpenAPI spec.

| | OpenAPI | MCP |
|---|---|---|
| Endpoint | `/api/openapi.json` | `/mcp` |
| Tools | 8 REST operations | `list_providers`, `get_provider`, `add_provider`, `remove_provider`, `list_open_incidents`, `last_run` |
| Auth | `Authorization: Bearer <API_TOKEN>` | same |

## What the maintainer needs

1. The **base URL** of the running status-page-to-chat instance (e.g. `https://status-bot.example.com` or `http://192.168.1.20:8080`). Your administrator sets this up.
2. The **`API_TOKEN`** — the bearer token. Treat it like a password.
3. An account on an **LLM platform** that supports OpenAPI tools (or MCP via a bridge — see "Concrete walkthroughs" below).

## Generic setup (any OpenAPI-aware platform)

Every platform asks for roughly the same three things when you add a tool:

| What it wants | What to provide |
|---|---|
| OpenAPI spec URL or file | `https://YOUR-HOST/api/openapi.json` (or download and paste) |
| Authentication scheme | Bearer token |
| Token value | The `API_TOKEN` your administrator gave you |

After you save, the platform reads the spec, discovers the endpoints, and exposes them as tools the LLM can call.

### Recommended system prompt

Most platforms let you give the assistant standing instructions. Paste this (or translate to your team's language):

> You manage the list of monitored status pages for our team. The tool lets you add, update, remove, and inspect providers. Always show the user what you are about to change and ask for confirmation before any PUT or DELETE. When the user is unsure of an adapter or URL, use the `validate` endpoint first. Speak clearly and avoid technical jargon — the user is not a developer.

### Example prompts that work

- "Welche Statuspages werden gerade überwacht?"
- "Füge Cloudflare hinzu, die Status-URL ist https://www.cloudflarestatus.com."
- "Entferne Bitwarden aus der Überwachung."
- "Ändere den Anzeigenamen von 'Figma' auf 'Figma Design'."
- "Gibt es gerade offene Vorfälle?"
- "Wann lief die letzte Prüfung und war alles in Ordnung?"
- "Prüfe ob diese Konfiguration valid wäre: Stripe, https://www.stripestatus.com." (validate only — no save)

The LLM figures out which adapter to use based on URL patterns. If unsure it will ask before saving.

## Concrete walkthroughs

### Langdock

Langdock is a German enterprise LLM platform. It supports **both OpenAPI and MCP** for tool integrations — either works against this service. OpenAPI is the lower-friction route:

1. Create a new assistant.
2. Open **Tools** (or **Actions**) and choose **Add tool → OpenAPI** (the wording may also be "Custom Connector").
3. Paste the spec URL: `https://YOUR-HOST/api/openapi.json`.
4. Choose **Bearer token** authentication and paste the `API_TOKEN`.
5. Save.

If you prefer to register the tool as an MCP server in Langdock instead, point Langdock's MCP-server config directly at `<base-url>/mcp` with the same bearer token — the service speaks MCP natively, no bridge required.

### ChatGPT (Custom GPT)

1. Create a new Custom GPT.
2. **Configure → Actions → Create new action**.
3. Click **Import from URL** and enter `https://YOUR-HOST/api/openapi.json`. ChatGPT downloads the spec.
4. Under **Authentication**, choose **API Key**, type **Bearer**, paste the token.
5. Save.

ChatGPT requires the OpenAPI server to be reachable over public HTTPS. Put the container behind a reverse proxy with a valid certificate.

### OpenWebUI

1. **Settings → Tools → + Add tool → OpenAPI**.
2. Paste the spec URL.
3. Set **Authorization** to `Bearer YOUR-TOKEN`.
4. Save and enable the tool for your model.

### Claude Desktop (via OpenAPI MCP bridge)

Claude Desktop natively speaks MCP, not OpenAPI. To plug this API in, run a small OpenAPI→MCP bridge alongside it (several community projects exist). Point the bridge at `/api/openapi.json`. Then add the bridge to Claude Desktop's MCP server list as usual. The bridge handles the bearer token.

If you don't want to run a bridge, use Claude.ai (Web) which supports OpenAPI tools directly via "Skills" or "Actions" — same setup as ChatGPT above.

### Your own code

For scripts and small integrations, the OpenAPI spec doubles as TypeScript/Python/etc. client generator input. Or just hit the endpoints directly — they're plain JSON. See [API.md](API.md) for `curl` examples.

## What goes wrong (and what to do)

- **"The API returned 401 Unauthorized."** Your token is wrong, missing, or has been rotated. Ask your administrator for the current one. Every auth failure returns the same generic 401 by design — that's not a bug.
- **"The API returned 400 Bad Request."** Your edit would break the configuration (typo in the URL, missing `baseUrl` for an Atlassian status page, …). The response body's `details` field has the specific reason; the assistant should surface it.
- **"It says provider not found."** You're trying to update or delete a key that doesn't exist. Ask the assistant to list current providers first.
- **"The change isn't visible in chat yet."** Notifications are sent on a 5-minute poll cycle. Wait one cycle, then check again. Use `/api/last-run` to see when the last poll completed.
- **"The platform can't reach the API."** Confirm the host is publicly reachable (or that the LLM platform has network access to the private network). LLM platforms generally need HTTPS with a valid certificate.

## Limits

- Only the people who have the URL and the token can talk to the API. Don't share either in shared channels.
- The assistant manages **which** status pages are watched. It does **not** manage the webhook URL — that is set when the container is deployed.
- For complex operations (rolling back to a previous state, changing multiple providers atomically) talk to your administrator. The API is intentionally one-provider-at-a-time.

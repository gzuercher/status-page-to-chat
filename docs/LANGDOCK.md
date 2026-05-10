# Configure status-page-to-chat via chat (Langdock)

This guide is for the person who maintains the list of monitored status pages — typically a backoffice or operations role. No SSH, no Docker commands. You add providers, remove them, and check on the system through a chat interface.

## What you need before you start

1. The URL of the running status-page-to-chat instance — your administrator will give you this. It looks like `https://status-bot.example.com` or `http://192.168.1.20:8080` depending on how it was deployed.
2. The `API_TOKEN` — also from the administrator. Treat it like a password.
3. A Langdock account with permission to create assistants.

## One-time setup in Langdock

1. In Langdock, create a new assistant. Name it something memorable — "Status Page Bot" works.
2. Open the assistant's **Tools** (or **Actions**) section and choose **Add tool → OpenAPI**.
3. Paste the OpenAPI URL: `https://YOUR-HOST/api/openapi.json`.
4. When prompted for authentication, choose **Bearer token** and paste the `API_TOKEN`.
5. Save.

You're done. The assistant now understands every operation the API supports.

## Suggested system prompt

Paste this into the assistant's instructions. It nudges the LLM to behave like a careful operator:

> You manage the list of monitored status pages for our team. The tool lets you add, update, remove, and inspect providers. Always show the user what you are about to change and ask for confirmation before any PUT or DELETE. When the user is unsure of an adapter or URL, use the `validate` endpoint first. Speak clearly and avoid technical jargon — the user is not a developer.

## What you can ask it to do

These are real prompts that work:

- "Welche Statuspages werden gerade überwacht?"
- "Füge Cloudflare hinzu, die Status-URL ist https://www.cloudflarestatus.com."
- "Entferne Bitwarden aus der Überwachung."
- "Ändere den Anzeigenamen von 'Figma' auf 'Figma Design'."
- "Gibt es gerade offene Vorfälle?"
- "Wann lief die letzte Prüfung und war alles in Ordnung?"
- "Prüfe ob diese Konfiguration valid wäre: Stripe, https://www.stripestatus.com." (validate only — no save)

The assistant will figure out which adapter to use based on the URL pattern. If unsure it will ask before saving.

## What goes wrong (and what to do)

- **"The API returned 401 Unauthorized."** Your token is wrong or has been rotated. Ask your administrator for the current one.
- **"The API returned 400 Bad Request."** Your edit would break the configuration (for example, a typo in the URL, or a missing `baseUrl` for an Atlassian status page). The assistant should show you the error from the response.
- **"It says provider not found."** You're trying to update or delete a key that doesn't exist. Ask the assistant to list the current providers first.
- **"The change isn't visible yet."** Notifications are sent on a 5-minute cycle. Wait one cycle, then check again.

## Limits

- Only the people who have the URL and the token can talk to the API. Don't share them in shared channels.
- The assistant only manages **which** status pages are watched. It does not manage the chat target (Google Chat vs. Teams) or the webhook URL — those are set when the container is deployed.
- For complex operations (rolling back to a previous state, changing multiple providers atomically) ask your administrator.

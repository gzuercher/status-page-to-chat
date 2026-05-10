# Management API

The container exposes a small REST API on port `8080` for runtime maintenance: listing and editing the monitored providers, validating payloads, and inspecting the most recent poll result. It is the same surface that Langdock (or any other OpenAPI-aware LLM tool) speaks to — see [LANGDOCK.md](LANGDOCK.md) for a chat-driven setup.

The API edits the live `providers.yaml` on the host. The next poll cycle (within 5 minutes) picks up the new file. If a write would produce an invalid config, it is rejected before the file is touched — the running container is never left in a broken state.

## Authentication

By default a bearer token is required. Set `API_TOKEN` in your environment (e.g. via `.env` next to `docker-compose.yml`) to any reasonably random string and pass it as `Authorization: Bearer <token>` on every request.

To disable auth (only acceptable on a trusted private network), set `API_AUTH_DISABLED=true`. The startup log will warn that the API is open.

Two endpoints are always public: `/api/health` and `/api/openapi.json`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness probe. Returns `lastRunAt` if a poll has completed. |
| `GET` | `/api/providers` | List the currently monitored providers. |
| `GET` | `/api/providers/{key}` | Fetch one provider. 404 if not found. |
| `PUT` | `/api/providers/{key}` | Add or update a provider. 201 on create, 200 on update. |
| `DELETE` | `/api/providers/{key}` | Remove a provider. 204 on success, 404 if not found. |
| `POST` | `/api/providers/validate` | Validate a payload without saving. |
| `GET` | `/api/incidents/open` | Open incidents across all providers, from local state. |
| `GET` | `/api/last-run` | Summary of the most recent poll cycle. 404 if none yet. |
| `GET` | `/api/openapi.json` | OpenAPI 3.1 spec — point Langdock at this URL. |

## Examples

Replace `TOKEN` with the value of `API_TOKEN` and `HOST` with where your container is reachable (`localhost:8080` when running with the default compose).

```bash
# Health check (no auth)
curl -s http://HOST/api/health
# {"status":"ok","lastRunAt":"2026-05-10T07:12:34.567Z"}

# List providers
curl -s -H "Authorization: Bearer TOKEN" http://HOST/api/providers

# Add a new provider
curl -s -X PUT -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"webflow","displayName":"Webflow","adapter":"atlassian-statuspage","baseUrl":"https://status.webflow.com"}' \
  http://HOST/api/providers/webflow

# Validate before saving
curl -s -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"test","displayName":"Test","adapter":"atlassian-statuspage","baseUrl":"https://example.com"}' \
  http://HOST/api/providers/validate

# Remove a provider
curl -s -X DELETE -H "Authorization: Bearer TOKEN" http://HOST/api/providers/webflow

# Show the last poll summary
curl -s -H "Authorization: Bearer TOKEN" http://HOST/api/last-run
```

## Error format

All error responses are JSON with at minimum an `error` field. Validation errors include a `details` object with field-level messages.

```json
{
  "error": "invalid provider payload",
  "details": {
    "formErrors": [],
    "fieldErrors": {
      "baseUrl": ["Invalid url"]
    }
  }
}
```

## Notes

- Path keys and body keys must match on `PUT`. A mismatch returns 400.
- The full configuration is re-validated before every write. If your edit would break the file, the API returns 400 and the file is untouched.
- Editing `providers.yaml` on the host by hand is fully supported. The API only writes through the same schema gate; manual edits go through the same reload path.

# Konfiguration

Die gesamte Laufzeit-Konfiguration liegt in **`config/providers.yaml`** im Repo. Änderungen sind versioniert, im Pull Request reviewbar und werden mit dem nächsten Deployment aktiv.

## Schema

```yaml
# Pflichtfelder
chatTarget: googleChat         # "googleChat" | "teams"

# Liste der überwachten Dienste
providers:
  - key: <string>              # Eindeutiger Schlüssel, nur [a-z0-9-]
    displayName: <string>      # So erscheint der Name im Chat ("Bexio", "Webflow")
    adapter: <adapter-name>    # siehe ADAPTERS.md
    # adapter-spezifische Felder:
    baseUrl: <url>             # für "atlassian-statuspage", "wedos-status-online"
    owner: <string>            # für "github-issues"
    repo: <string>             # für "github-issues"
    componentFilter: <string | list<string>>  # optional, nur bei atlassian-statuspage
    userAgent: <string>        # optional, überschreibt den Default-User-Agent für diesen Provider
```

## HTTP User-Agent

Alle ausgehenden HTTP-Aufrufe senden standardmässig einen einheitlichen, sprechenden User-Agent:

```
raptus-status-monitor/<version> (+https://github.com/raptus/status-page-to-chat; ops@raptus.ch)
```

Das folgt der gängigen Praxis für gutartige Poller, respektiert die Logs der Status-Page-Betreiber und erleichtert die Kontaktaufnahme, falls wir einen Endpunkt belasten. Die Version wird zur Laufzeit aus `package.json` gezogen.

**Override global** — via App Setting `USER_AGENT` (selten nötig, z.B. für Tests).

**Override pro Provider** — via optionales Feld `userAgent` in `providers.yaml`. Einsatzgrund nur dokumentierte Ausnahmen:

- Endpunkt hinter WAF, der den Default blockt. In diesem Fall die Entscheidung im Pull Request begründen. (Beispiel Sophos: API-Endpoints sind vollständig gesperrt — ein User-Agent-Override allein reicht nicht; siehe auskommentierten Eintrag in `providers.yaml`.)
- Der Anbieter verlangt explizit ein anderes Format (bisher kein bekannter Fall).

⚠️ Tarnung als Browser ist kein valider Grund — das grenzt an ToS-Verstoss. Lieber Kontakt aufnehmen oder den Adapter 403 akzeptieren lassen.

## Validierung

Die Datei wird beim Start der Function mit **`zod`** validiert. Fehler werden geloggt und verhindern den Start. Mindestanforderungen:

- `chatTarget` ∈ `{googleChat, teams}`
- mindestens ein Eintrag in `providers`
- `key` ist eindeutig
- adapter-spezifische Pflichtfelder sind vorhanden

## Beispiel (vollständig)

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

  - key: digicert
    displayName: DigiCert
    adapter: atlassian-statuspage
    baseUrl: https://status.digicert.com

  - key: ninjaone
    displayName: NinjaOne
    adapter: atlassian-statuspage
    baseUrl: https://status.ninjaone.com

  - key: sucuri
    displayName: Sucuri
    adapter: atlassian-statuspage
    baseUrl: https://status.sucuri.net

  - key: smartrecruiters
    displayName: SmartRecruiters
    adapter: atlassian-statuspage
    baseUrl: https://status.smartrecruiters.com

  - key: retool
    displayName: Retool
    adapter: atlassian-statuspage
    baseUrl: https://status.retool.com

  - key: langdock
    displayName: Langdock
    adapter: atlassian-statuspage
    baseUrl: https://status.langdock.com

  - key: zendesk-helpcenter
    displayName: Zendesk Help Center
    adapter: atlassian-statuspage
    baseUrl: https://status.zendesk.com
    componentFilter: raptus-helpcenter      # nur Meldungen zu unserer Subdomain

  - key: kaseya-itglue
    displayName: Kaseya IT Glue
    adapter: atlassian-statuspage
    baseUrl: https://status.kaseya.com
    componentFilter: IT Glue                # nur IT Glue ist für uns relevant

  - key: gravityzone-bitdefender
    displayName: Bitdefender GravityZone
    adapter: atlassian-statuspage
    baseUrl: https://status.gravityzone.bitdefender.com
    componentFilter:                        # nur Cloud-Instanzen, die Raptus nutzt
      - cloudgz.gravityzone.bitdefender.com
      - cloud.gravityzone.bitdefender.com

  - key: figma
    displayName: Figma
    adapter: atlassian-statuspage
    baseUrl: https://status.figma.com
    # kein componentFilter: nur 3 generische Komponenten, alle relevant

  # --- Sophos: ZURUECKGESTELLT (siehe ROADMAP.md) ---
  # status.sophos.com laeuft auf Atlassian Statuspage, aber alle
  # maschinenlesbaren Endpoints (/api/v2/*, /history.atom, /history.rss)
  # antworten mit HTTP 200 und liefern eine 404-HTML-Seite statt JSON — auch
  # mit Browser-User-Agent. Aktivierung erfordert Freischaltung durch Sophos
  # oder einen HTML-Scraping-Adapter (siehe ROADMAP → Spätere Erweiterungen).
  # - key: sophos
  #   displayName: Sophos
  #   adapter: atlassian-statuspage
  #   baseUrl: https://status.sophos.com

  - key: claude
    displayName: Claude
    adapter: atlassian-statuspage
    baseUrl: https://status.claude.com
    componentFilter:                        # nur die fuer Raptus genutzten Produkte
      - claude.ai
      - Claude Code
      - api.anthropic.com

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

  # --- GitHub-Issues als Status-Tracker ---
  - key: onetimesecret
    displayName: Onetime Secret
    adapter: github-issues
    owner: onetimesecret
    repo: status
```

## App-Settings (Secrets, nicht in YAML)

Webhook-URLs und Alarm-Empfänger liegen **nicht** in `providers.yaml`, sondern in den Azure Function App Settings:

| Setting | Beschreibung |
|---|---|
| `WEBHOOK_URL` | Google Chat Incoming Webhook **oder** Teams Incoming Webhook — je nach `chatTarget` |
| `ALERT_EMAIL` | Empfänger für Self-Monitoring-Alarme (Azure Monitor) |
| `USER_AGENT` | optional — überschreibt den Default-User-Agent global |
| `AzureWebJobsStorage` | wird automatisch durch Bicep gesetzt |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | wird automatisch durch Bicep gesetzt |

Siehe [DEPLOYMENT.md](DEPLOYMENT.md) für das Setzen der Werte.

## Eine Status-Page hinzufügen (Workflow)

1. Neuer Eintrag in `config/providers.yaml` mit passendem Adapter (siehe [ADAPTERS.md](ADAPTERS.md)).
2. Pull Request aufsetzen → Review durch zweite Person.
3. Nach Merge: Deployment triggert automatisch (bzw. `az functionapp deployment source sync`).
4. Im nächsten 5-Minuten-Zyklus ist der Dienst aktiv.

## Status-Page entfernen

- Eintrag aus `providers.yaml` löschen und mergen.
- Optional: zugehörige Zeilen in Azure Table Storage löschen (PartitionKey = `key`). Sonst: bleiben inaktiv liegen.

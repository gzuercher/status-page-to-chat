# Plan: Status-Page-zu-Chat Benachrichtigungsdienst

## Kontext

Das Raptus-Team soll automatisch informiert werden, wenn bei externen Diensten (Cloudflare, Bexio, Webflow, Bitwarden, Zendesk u.v.m.) Störungen auftreten oder behoben werden. Ziel ist:

- Weniger Rückfragen im Team ("Geht es bei dir?")
- Schnellere Reaktion auf Kundenmeldungen
- Keine verpassten Incidents

Das Repo ist aktuell leer (nur Raptus Playbook). Dieser Plan beschreibt den kompletten Aufbau eines kleinen, modularen Dienstes, der auf Azure läuft, regelmässig die Status-Pages pollt, Zustandsänderungen erkennt und formatierte Meldungen in Google Chat oder Microsoft Teams postet.

## Entscheidungen (bereits mit dir geklärt)

- **Konfiguration**: YAML-Datei im Repo (`config/providers.yaml`) — versioniert, PR-reviewbar
- **Chat-Routing**: Ein globales Ziel zum Start (Webhook-URL in App-Settings)
- **Self-Monitoring**: Azure Monitor Alert → Mail bei Ausfall
- **Scheduled Maintenance**: wird nicht gemeldet (nur Incidents)

## Architektur

**Stack**: TypeScript + Node.js 20, Azure Functions (Consumption Plan, Timer Trigger alle 5 min), Azure Table Storage für State, Bicep für IaC.

**Ablauf pro Durchlauf**:

1. Timer feuert alle 5 min
2. `config/providers.yaml` wird geladen (gebündelt im Deployment)
3. Je konfiguriertem Provider wird der passende Adapter instanziert und `fetchIncidents()` aufgerufen
4. Rohdaten werden in ein einheitliches `NormalizedIncident`-Modell gemappt
5. Abgleich mit letztem bekannten Zustand in Azure Table Storage
6. Für neue / neu behobene Incidents: formatierte Nachricht via Notifier (Google Chat oder Teams Webhook)
7. State in Table Storage aktualisieren

**Kosten**: ~288 Executions/Tag = ~8'700/Monat, weit unter dem 1-Mio-Freikontingent. Storage + App Insights wenige Cent. Erwartung: **< 1 CHF/Monat**.

## Adapter-Module (modular)

Einheitliches Interface `StatusProvider` mit `fetchIncidents(): Promise<NormalizedIncident[]>`. Fünf Adapter decken alle genannten Status-Pages ab:

| Adapter | Typ | Dienste aus deiner Liste |
|---|---|---|
| `atlassian-statuspage` | JSON `/api/v2/incidents/unresolved.json` + `/incidents.json` | bitbucket, bitwarden, bexio, webflow, digicert, kaseya (Komponent-Filter "IT Glue"), ninjaone, sucuri, smartrecruiters, retool, zendesk (Komponent-Filter "raptus-helpcenter"), langdock |
| `google-workspace` | JSON `/appsstatus/dashboard/incidents.json` | Google Workspace |
| `metanet-rss` | RSS `/xml/statusmeldungen.xml` | Metanet |
| `wedos-status-online` | JSON `/json/incidents.json` | WEDOS |
| `github-issues` | GitHub REST `/repos/{owner}/{repo}/issues` | onetimesecret |

Komponent-Filter (optional in Config) erlaubt es, bei Multi-Tenant-Pages (Zendesk, Kaseya) nur relevante Sub-Bereiche zu melden.

## Notifier-Module

Einheitliches Interface `Notifier` mit `notifyOpened(incident)` und `notifyResolved(incident)`.

- `GoogleChatNotifier`: Incoming Webhook, Card v2 mit Titel + Link
- `TeamsNotifier`: Incoming Webhook, Adaptive Card oder MessageCard

**Message-Format** (genau wie gewünscht):

- **Neu**: `⚠️ <Anbieter> hat eine Störung zu "<Titel>" gemeldet` + Link
- **Behoben**: `✅ <Anbieter> hat die Behebung der Störung zu "<Titel>" gemeldet` + Link

## Konfigurationsformat (`config/providers.yaml`)

```yaml
chatTarget: googleChat   # oder "teams"

providers:
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
    componentFilter: raptus-helpcenter
  - key: kaseya-itglue
    displayName: Kaseya IT Glue
    adapter: atlassian-statuspage
    baseUrl: https://status.kaseya.com
    componentFilter: IT Glue
  - key: google-workspace
    displayName: Google Workspace
    adapter: google-workspace
  - key: metanet
    displayName: Metanet
    adapter: metanet-rss
  - key: wedos
    displayName: WEDOS
    adapter: wedos-status-online
  - key: onetimesecret
    displayName: Onetime Secret
    adapter: github-issues
    owner: onetimesecret
    repo: status
  # ... bitbucket, bitwarden, digicert, ninjaone, sucuri, smartrecruiters, retool, langdock analog
```

Validierung mit `zod` beim Laden (laut Raptus-Regeln Pflicht).

## Projektstruktur

```
status-page-to-chat/
├── config/
│   └── providers.yaml              # Konfigurierte Status-Pages
├── infra/
│   └── main.bicep                  # Azure-Ressourcen (Function App, Storage, App Insights, Alert)
├── src/
│   ├── functions/
│   │   └── poll.ts                 # Timer-Trigger Entry Point
│   ├── adapters/
│   │   ├── index.ts                # Adapter-Registry
│   │   ├── atlassianStatuspage.ts
│   │   ├── googleWorkspace.ts
│   │   ├── metanetRss.ts
│   │   ├── wedosStatusOnline.ts
│   │   └── githubIssues.ts
│   ├── notifiers/
│   │   ├── index.ts
│   │   ├── googleChat.ts
│   │   └── teams.ts
│   ├── state/
│   │   └── tableStore.ts           # Azure Table Storage Wrapper
│   ├── lib/
│   │   ├── config.ts               # YAML laden + zod-Validierung
│   │   ├── logger.ts               # pino-Logger
│   │   └── types.ts                # NormalizedIncident, Provider-Interface
│   └── index.ts
├── tests/
│   └── adapters/                   # vitest für jeden Adapter mit Fixture-Responses
├── .env.example
├── host.json
├── local.settings.json.example
├── package.json
├── tsconfig.json
└── README.md
```

## Azure-Ressourcen (Bicep)

- **Resource Group**: `rg-status-page-to-chat`
- **Storage Account** (Standard_LRS): für Function-Runtime + `incidents`-Tabelle
- **Application Insights**: Logs/Metrics
- **Function App** (Linux, Consumption Plan, Node 20): hostet den Timer-Trigger
- **Action Group**: E-Mail-Empfänger für Alarm
- **Alert Rule**: "FunctionExecutionCount < 1 in 15 min" → Action Group

App-Settings enthalten:
- `WEBHOOK_URL` (Google Chat oder Teams, je nach `chatTarget`)
- `ALERT_EMAIL` (als Parameter für Action Group)
- Secrets als Azure-verschlüsselte App-Settings, nie im Code (Regel `security.md`)

## State-Modell (Azure Table Storage)

Tabelle `incidents`:
- `PartitionKey` = Provider-Key (z.B. `bexio`)
- `RowKey` = externe Incident-ID
- Felder: `title`, `status`, `startedAt`, `updatedAt`, `url`, `resolved` (bool), `notifiedOpened`, `notifiedResolved`

Abgleich-Logik:
- Incident existiert nicht in Tabelle + ist offen → Neu → `notifyOpened` → Zeile schreiben, `notifiedOpened = true`
- Incident existiert, war offen, ist jetzt resolved → Behoben → `notifyResolved` → `notifiedResolved = true`
- Sonst: nichts tun

## Kritische Dateien

- `src/functions/poll.ts` — Orchestrierung des gesamten Durchlaufs
- `src/adapters/*.ts` — je ein Adapter, isoliert testbar
- `src/state/tableStore.ts` — State-Persistenz und Abgleich-Logik (Kern-Korrektheit)
- `src/lib/config.ts` — YAML + zod-Schema für Konfiguration
- `infra/main.bicep` — komplette Azure-Infrastruktur als Code

## Verifikation

1. **Unit-Tests** (`pnpm test`): Jeder Adapter mit Fixture-Responses (gespeicherte echte Statuspage-Antworten) — erkennt offene vs. geschlossene Incidents korrekt?
2. **Lokaler Lauf**: `func start` mit `local.settings.json` (dummy Webhook gegen `webhook.site`) — prüft End-to-End ohne Azure.
3. **Webhook-Formate manuell prüfen**: Test-Incident simulieren → Nachricht erscheint korrekt formatiert in Google Chat / Teams.
4. **State-Resilienz**: Test mit manueller Tabellen-Manipulation: Wird eine bereits gemeldete Störung nicht doppelt gepostet? Wird das Behoben-Signal nach Neustart der Function korrekt erkannt?
5. **Azure-Deployment**: `az deployment group create` mit `main.bicep` → Function-Lauf in Azure-Portal verifizieren, Alert-Rule manuell triggern (Function stoppen).
6. **Build & Lint** (Raptus-Regel): `pnpm build && pnpm lint` muss ohne Fehler durchlaufen.

## Umsetzungsreihenfolge

1. Grundgerüst: `package.json`, `tsconfig.json`, `host.json`, Projektstruktur
2. `src/lib/types.ts` + `src/lib/config.ts` inkl. zod-Schema
3. Erster Adapter `atlassianStatuspage.ts` + Tests (deckt ~13 der Status-Pages)
4. `src/state/tableStore.ts`
5. `googleChat.ts` Notifier + `teams.ts`
6. `src/functions/poll.ts` Orchestrierung
7. Weitere Adapter (`googleWorkspace`, `metanetRss`, `wedosStatusOnline`, `githubIssues`) + Tests
8. `infra/main.bicep` + README mit Deployment-Anleitung
9. Alert-Rule für Self-Monitoring
10. Deployment nach Azure, End-to-End-Test

## Offene Punkte für später

- Sprache der Titel: Titel werden 1:1 von der Status-Page übernommen (meist Englisch). Falls eine deutsche Übersetzung gewünscht ist, wäre das eine spätere Erweiterung.
- Update-Nachrichten zwischen Neu und Behoben: aktuell ausgeblendet, kann später pro Provider aktiviert werden.
- Mehrere Chat-Ziele / Pro-Dienst-Routing: laut deiner Entscheidung vorerst bewusst weggelassen — Architektur ist aber vorbereitet (Notifier-Interface).

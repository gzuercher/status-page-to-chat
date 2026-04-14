# Architektur

## Übersicht

`status-page-to-chat` ist ein **Timer-getriebener Serverless-Dienst**. Alle 5 Minuten pollt er eine Liste externer Status-Pages, normalisiert die Antworten zu einem einheitlichen Incident-Modell, vergleicht mit dem letzten bekannten Zustand und verschickt bei Änderungen eine Nachricht in einen Chat-Kanal.

```
           ┌────────────────────┐
           │ Timer Trigger (5m) │
           └──────────┬─────────┘
                      │
                      ▼
           ┌────────────────────┐
           │  Config Loader     │ ◄── config/providers.yaml
           └──────────┬─────────┘
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
  ┌─────────┐   ┌─────────┐    ┌──────────┐
  │ Adapter │   │ Adapter │    │ Adapter  │   (je nach Provider)
  └────┬────┘   └────┬────┘    └─────┬────┘
       │             │               │
       └─────────────┼───────────────┘
                     ▼
         ┌────────────────────────┐
         │ Normalized Incidents   │
         └───────────┬────────────┘
                     │
                     ▼
         ┌────────────────────────┐        ┌──────────────────────┐
         │ State-Diff (Table)     │ ◄────► │ Azure Table Storage  │
         └───────────┬────────────┘        └──────────────────────┘
                     │
                     ▼
         ┌────────────────────────┐
         │ Notifier               │ ──► Google Chat / Teams Webhook
         └────────────────────────┘
```

## Module

| Modul | Pfad | Verantwortung |
|---|---|---|
| Timer Entry | `src/functions/poll.ts` | Orchestriert den gesamten Durchlauf |
| Config Loader | `src/lib/config.ts` | Lädt und validiert `config/providers.yaml` (zod) |
| Adapter-Registry | `src/adapters/index.ts` | Mappt Adapter-Key → Implementierung |
| Adapter | `src/adapters/*.ts` | Pro Status-Page-Typ eine Implementierung des `StatusProvider`-Interface |
| Notifier-Registry | `src/notifiers/index.ts` | Wählt Notifier anhand `chatTarget` |
| Notifier | `src/notifiers/googleChat.ts`, `teams.ts` | Formatieren und POSTen die Nachricht |
| State Store | `src/state/tableStore.ts` | Persistiert zuletzt bekannte Incidents |
| Logger | `src/lib/logger.ts` | pino-Logger mit App-Insights-Sink |
| Types | `src/lib/types.ts` | `NormalizedIncident`, `StatusProvider`, `Notifier` |

## Datenmodell

### `NormalizedIncident`

```ts
type NormalizedIncident = {
  externalId: string;          // ID aus dem Quellsystem
  providerKey: string;         // z.B. "bexio"
  displayName: string;         // z.B. "Bexio"
  title: string;               // Kurzbeschreibung der Störung
  status: "open" | "resolved"; // vereinfacht, siehe unten
  url: string;                 // Link zur Störung oder Status-Page
  startedAt: string;           // ISO-8601
  updatedAt: string;           // ISO-8601
};
```

### Status-Vereinfachung

Status-Pages kennen viele Zustände (`investigating`, `identified`, `monitoring`, `resolved`, `postmortem`, …). Für die Zielgruppe (Endnutzer) wird reduziert auf:

- **open** = aktuell beeinträchtigt (alles außer `resolved`/`completed`)
- **resolved** = behoben

## Datenfluss pro Durchlauf

1. **Config laden**: `config/providers.yaml` lesen, per `zod` validieren, bei Fehler `process.exit` mit Log.
2. **Pollen**: Für jeden Provider parallel (mit Timeout + Einzelfehler-Isolation) `fetchIncidents()` aufrufen. Ein fehlschlagender Provider darf die anderen nicht beeinflussen.
3. **Normalisieren**: Adapter liefert bereits `NormalizedIncident[]`.
4. **Abgleich** (pro Incident):
   - Nicht in Table Storage + Status `open` → neuer offener Incident
   - In Table Storage offen + jetzt `resolved` → behoben
   - Sonst: Zustand übernehmen, keine Nachricht
5. **Benachrichtigen**: Für jeden Zustandswechsel `notifyOpened` oder `notifyResolved`.
6. **State schreiben**: Zeile in Table Storage aktualisieren.

## Fehlerisolation

- Einzelne Adapter laufen in eigenem `try/catch`. Fehler werden geloggt und als Metric gezählt, brechen aber den Gesamtlauf nicht ab.
- Notifier-Aufrufe werden bei Fehler 1-mal mit Backoff wiederholt. Schlägt der Notifier komplett fehl, wird der Incident als "nicht benachrichtigt" im State markiert, damit im nächsten Durchlauf erneut versucht wird.

## Self-Monitoring

- **Azure Monitor Alert Rule** (definiert in `infra/main.bicep`):
  - Regel: Function Execution Count < 1 in einem 15-Minuten-Fenster
  - Aktion: Mail an konfigurierte Adresse via Action Group
- Zusätzlich: jeder Durchlauf loggt eine strukturierte `run_summary`-Nachricht. Dashboards und Queries in App Insights lesen diese.

## Sicherheit

- Webhook-URLs sind **Secrets** → liegen ausschliesslich in Function App Settings (verschlüsselt).
- Kein Secret im Repo (siehe `.claude/rules/security.md`).
- Keine personenbezogenen Daten in Logs.
- Ausgehende Aufrufe gehen nur an statische, konfigurierte Hosts.

## Was explizit NICHT gebaut wird

- Keine eigene Authentifizierung (Service ist Backend-only, keine UI)
- Keine eigene Webseite zur Verwaltung (Konfig erfolgt per YAML im Repo)
- Kein Datenbankserver (Table Storage genügt)
- Keine eigene Queue (pro Durchlauf synchron)

## Referenzen

- Datenformat `providers.yaml`: [CONFIGURATION.md](CONFIGURATION.md)
- Adapter-Details: [ADAPTERS.md](ADAPTERS.md)
- Deployment: [DEPLOYMENT.md](DEPLOYMENT.md)

# Agenten-Leitfaden

Dieses Dokument ist für Menschen **und für Claude-Code-Agenten** geschrieben. Ein neuer Agent (oder ein Mensch auf einem anderen Computer) soll mit **diesem Dokument + `docs/PLAN.md` + `CLAUDE.md`** genug Kontext haben, um produktiv weiterzuarbeiten.

## Erste Schritte für einen neuen Agenten

1. Lies in dieser Reihenfolge:
   - `CLAUDE.md` (Raptus-Regeln, Kommunikationssprache, verbotene Eigenbauten)
   - `README.md` (Projektüberblick)
   - `docs/PLAN.md` (ursprünglicher Architektur-Plan)
   - `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/ADAPTERS.md`
   - `docs/ROADMAP.md` (was als nächstes zu tun ist)
2. Prüfe den aktuellen Projektstand: `git log --oneline`, `ls src/`.
3. Wähle eine offene Aufgabe aus der Roadmap oder stimm dich mit dem Menschen ab.

## Projektsprache und Konventionen

- **Kommunikation mit dem Benutzer**: Deutsch
- **Kommentare und Doku**: Deutsch
- **Bezeichner (Variablen, Funktionen, Dateien)**: Englisch
- **Commit-Messages**: Deutsch, Imperativ ("Füge Adapter für Metanet hinzu")
- **TypeScript strict**, kein `any`
- **Kein `console.log`**, sondern `pino`-Logger
- Siehe `.claude/rules/` für Details

## Multi-Agent-Arbeit

Mehrere Agenten dürfen **parallel** am Projekt arbeiten, aber nur in isolierten Scopes. Empfohlenes Modell: **ein Agent pro logische Einheit** (Modul, Feature, PR).

### Isolation

- **Git Worktrees** nutzen, damit mehrere Agenten gleichzeitig arbeiten können ohne sich gegenseitig zu überschreiben:

```bash
git worktree add ../status-page-to-chat-adapter-google feature/adapter-google-workspace
git worktree add ../status-page-to-chat-notifier-teams feature/notifier-teams
```

- Innerhalb Claude Code: `isolation: "worktree"` beim Agent-Spawn.
- Jeder Agent arbeitet auf einem eigenen Feature-Branch, öffnet einen eigenen PR.

### Zuständigkeits-Bereiche

Um Merge-Konflikte zu minimieren, teilen wir das Projekt in **unabhängige Zonen**:

| Zone | Verantwortlicher Agent / Branch | Typische Dateien |
|---|---|---|
| Grundgerüst | `core` | `package.json`, `tsconfig.json`, `host.json`, `src/lib/types.ts` |
| Config | `config` | `src/lib/config.ts`, `config/providers.yaml` |
| State | `state` | `src/state/tableStore.ts` |
| Adapter: Atlassian | `adapter-atlassian` | `src/adapters/atlassianStatuspage.ts` + Test |
| Adapter: Google | `adapter-google` | `src/adapters/googleWorkspace.ts` + Test |
| Adapter: Metanet | `adapter-metanet` | `src/adapters/metanetRss.ts` + Test |
| Adapter: WEDOS | `adapter-wedos` | `src/adapters/wedosStatusOnline.ts` + Test |
| Adapter: GitHub | `adapter-github` | `src/adapters/githubIssues.ts` + Test |
| Notifier: Google Chat | `notifier-gchat` | `src/notifiers/googleChat.ts` + Test |
| Notifier: Teams | `notifier-teams` | `src/notifiers/teams.ts` + Test |
| Orchestrierung | `orchestration` | `src/functions/poll.ts` |
| Infrastruktur | `infra` | `infra/main.bicep` |
| Doku | `docs` | `docs/*.md` |

**Reihenfolge wichtig**: Grundgerüst → Types → Config → State → Adapter/Notifier (parallel) → Orchestrierung → Infra. Bis das Grundgerüst steht, sollten Adapter-Agenten pausieren.

### Koordination

- **Eine zentrale `lessons.md`** dokumentiert Fehler und Korrekturen (Raptus-Regel).
- **Pull Requests** sind der Koordinationspunkt. Kein direkter Push auf `main`.
- Bei Unsicherheit: **nachfragen**, nicht raten (Raptus-Grundhaltung).

## Tool-Empfehlungen innerhalb Claude Code

Die im Raptus-Playbook definierten Commands und Agents sind hier ebenfalls verfügbar:

| Tool | Zweck |
|---|---|
| `/commit-push-pr` | Änderungen committen, pushen, PR erstellen |
| `/review` | Code Review des aktuellen Branches |
| `/build-and-test` | Build und Tests laufen lassen |
| Agent `code-reviewer` | Gründliches Review mit Sicherheitsfokus |
| Agent `verify-app` | Verifikation nach grösseren Änderungen |

## Lokale Entwicklung (für Agent oder Mensch)

### Voraussetzungen

- Node.js 20+
- pnpm (`npm i -g pnpm`)
- Azure Functions Core Tools (`npm i -g azure-functions-core-tools@4 --unsafe-perm true`)
- Azurite als lokaler Storage-Emulator (`npm i -g azurite`)

### Erstmaliger Setup

```bash
git clone git@github.com:gzuercher/status-page-to-chat.git
cd status-page-to-chat
pnpm install
cp local.settings.json.example local.settings.json  # danach Werte anpassen
```

### Entwicklungs-Zyklus

```bash
pnpm build         # TypeScript kompilieren
pnpm test          # vitest
pnpm lint          # eslint + prettier check
azurite --silent & # lokalen Storage starten
func start         # Function lokal laufen lassen
```

## Wichtige Grenzen (für Agenten)

- **Keine irreversiblen Aktionen** ohne explizite Bestätigung: keine `git push --force`, keine `rm -rf`, keine Azure-Ressourcen löschen.
- **Keine Secrets im Code**: Webhook-URLs, Tokens, Passwörter gehören in App Settings.
- **Kein `--no-verify`** bei Commits.
- **Bei Unsicherheit über Scope**: nachfragen statt "alles mitmachen" (Raptus-Regel: kein ungebetenes Refactoring).
- **Bei Fehler-Korrekturen**: Lektion in `lessons.md` dokumentieren (Format: `- [YYYY-MM-DD]: [Was falsch war] → [Korrekte Vorgehensweise]`).

## Zustands-Dateien für Wieder-Einstieg

Damit ein Agent auf einem anderen Rechner den Faden aufnehmen kann, müssen folgende Artefakte im Repo aktuell sein:

- `docs/ROADMAP.md` — offene Punkte mit Status
- `docs/PLAN.md` — architektonischer Plan (sollte mit aktuellem Stand übereinstimmen; bei grösseren Abweichungen: neuer Abschnitt am Ende)
- `lessons.md` — gemachte Fehler
- `config/providers.yaml` — aktueller Satz überwachter Dienste

## Was dieser Dienst ist und was nicht

**Ist**: Ein schmaler, gut wartbarer Monitoring-Benachrichtiger für externe Status-Pages.

**Ist nicht**: Ein allgemeines Monitoring-Tool, ein Uptime-Prober, ein SRE-Dashboard, eine Incident-Management-Plattform. Für diese Zwecke bitte spezialisierte Lösungen einsetzen (Uptime Kuma, Better Stack, PagerDuty, Grafana Cloud, …).

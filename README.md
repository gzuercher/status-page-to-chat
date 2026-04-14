# status-page-to-chat

Ein kleiner Dienst, der Status-Pages externer Anbieter überwacht (Cloudflare, Bexio, Webflow, Bitwarden, Zendesk u.v.m.) und neue Störungen sowie deren Behebung automatisch in **Google Chat** oder **Microsoft Teams** postet.

Betreiber: [Raptus AG](https://raptus.ch), Lyss.

---

## Motivation

- Das Team soll proaktiv über Störungen externer Dienste informiert sein, bevor Kunden fragen.
- Supportanfragen ("Unsere Website läuft nicht") lassen sich schneller einordnen, wenn bekannt ist, dass beispielsweise Webflow gerade eine Störung meldet.
- Rückfragen wie "Geht es bei dir?" entfallen.

## Funktionsweise (Kurzfassung)

1. Ein Azure Function Timer Trigger läuft alle 5 Minuten.
2. Pro konfiguriertem Dienst wird die Status-Page über den passenden **Adapter** abgefragt (Atlassian-Statuspage, Google Workspace, Metanet RSS, WEDOS, GitHub Issues).
3. Neue bzw. neu behobene Incidents werden mit dem letzten bekannten Zustand (Azure Table Storage) verglichen.
4. Bei Zustandsänderung wird eine formatierte Nachricht per Webhook in den konfigurierten Chat-Kanal geschickt.

**Nachrichtenformat**:

- **Neu**: `⚠️ <Anbieter> hat eine Störung zu "<Titel>" gemeldet` + Link zur Störung
- **Behoben**: `✅ <Anbieter> hat die Behebung der Störung zu "<Titel>" gemeldet` + Link

## Hosting und Kosten

- **Plattform**: Microsoft Azure (Raptus-Tenant)
- **Runtime**: Azure Functions (Consumption Plan, Linux, Node.js 20)
- **State**: Azure Table Storage
- **Logs**: Application Insights
- **Self-Monitoring**: Azure Monitor Alert Rule → E-Mail bei Ausfall

Erwartete Betriebskosten: **unter 1 CHF pro Monat** (288 Executions/Tag liegen weit unter dem 1-Mio-Freikontingent).

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architektur, Module, Datenfluss |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Format der `config/providers.yaml` |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Spezifikation je Status-Page-Adapter |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Azure-Deployment Schritt für Schritt |
| [docs/AGENTS.md](docs/AGENTS.md) | Multi-Agent-Arbeit und Zuständigkeiten |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Umsetzungsreihenfolge und offene Punkte |
| [docs/PLAN.md](docs/PLAN.md) | Ursprünglicher Architektur-Plan (Referenz) |

## Projektstand

> **Status**: Planung abgeschlossen, Dokumentation vorhanden. Implementierung steht noch aus.

Einstiegspunkt für die Umsetzung: [docs/ROADMAP.md](docs/ROADMAP.md).

## Voraussetzungen (später, für Entwicklung)

- Node.js 20+
- pnpm
- Azure CLI (`az`)
- Azure Functions Core Tools (`func`)
- Zugriff auf den Raptus Azure Tenant

## Lizenz

MIT — siehe [LICENSE](LICENSE).

## Raptus Claude Playbook

Dieses Repo enthält zusätzlich das [Raptus Claude Playbook](CLAUDE.md) mit Team-Regeln für die Zusammenarbeit mit Claude Code. Siehe `CLAUDE.md` und `.claude/rules/`.

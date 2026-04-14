# Raptus Claude Playbook

Claude Code Konfiguration und Team-Richtlinien der [Raptus AG](https://raptus.ch).

Dieses Repo ist die gemeinsame Grundlage für die Zusammenarbeit mit Claude Code — für alle Rollen und Projekte. Es kann als **Template** für neue Projekte oder als **Referenz** für bestehende Projekte verwendet werden.

---

## Erste Schritte

### Voraussetzungen

1. [Claude Code installieren](https://docs.anthropic.com/de/docs/claude-code) (`npm install -g @anthropic/claude-code`)
2. Dieses Repo als Template für ein neues Projekt verwenden oder in ein bestehendes Projekt kopieren

### Als Template für ein neues Projekt

1. Auf GitHub: "Use this template" → "Create a new repository"
2. Repo klonen: `git clone git@github.com:Raptus/<neues-projekt>.git`
3. `claude` im Projektverzeichnis starten

### In ein bestehendes Projekt importieren

```bash
cp -r /pfad/zu/raptus-claude-playbook/.claude/ ./.claude/
cp /pfad/zu/raptus-claude-playbook/CLAUDE.md ./CLAUDE.md
cp /pfad/zu/raptus-claude-playbook/lessons.md ./lessons.md
```

---

## Für alle — auch ohne Programmierkenntnisse

Claude Code ist ein KI-Assistent im Terminal. Du schreibst auf Deutsch, was du brauchst — Claude erledigt es.

### Was Claude tun kann

- Dateien erstellen, bearbeiten und erklären
- Fragen zum Projekt beantworten
- Texte, Dokumentationen oder Strukturen vorschlagen
- Bei Entwicklungsprojekten: Code schreiben, testen, reviewen

### Was Claude NICHT selbstständig tut

Diese Aktionen erfordern immer deine explizite Bestätigung:

- Dateien löschen
- Code auf einen Server pushen (deployen)
- Passwörter oder Zugangsdaten speichern
- Irreversible Änderungen an Datenbanken

### Wenn Claude unsicher ist

Claude sagt es. Antworte mit mehr Kontext oder hol eine Person mit der nötigen Fachkenntnis dazu.

### Warnhinweise ernst nehmen

Wenn Claude `⚠️ Review empfohlen` schreibt, bitte jemanden mit dem nötigen Fachwissen drüberzuschauen — bevor du weitermachst.

---

## Struktur

```
├── CLAUDE.md                  # Kern-Regeln (jede Session, alle Rollen)
├── .claude/
│   ├── settings.json          # Berechtigungen & Hooks (Team-shared)
│   ├── settings.local.json    # Persönliche Overrides (git-ignored)
│   ├── rules/
│   │   ├── dev-stack.md       # Tech Stacks und Build-Commands
│   │   ├── security.md        # Sicherheitsprüfungen
│   │   ├── code-quality.md    # Qualitätsregeln
│   │   └── accessibility.md   # Zugänglichkeit
│   ├── commands/
│   │   ├── commit-push-pr.md  # /commit-push-pr
│   │   ├── review.md          # /review
│   │   └── build-and-test.md  # /build-and-test
│   ├── agents/
│   │   ├── code-reviewer.md   # Review-Spezialist
│   │   └── verify-app.md      # QA-Verifikation
│   └── hooks/
│       └── post-edit.sh       # Auto-Formatting nach Edits
├── .mcp.json                  # MCP-Server (GitHub, erweiterbar)
├── lessons.md                 # Fehler-Lern-Dokument
└── CONTRIBUTING.md            # Wie man beiträgt
```

---

## Verfügbare Commands (für Entwickler)

| Command | Beschreibung |
|---|---|
| `/commit-push-pr` | Änderungen committen, pushen, PR erstellen |
| `/review` | Code Review des aktuellen Branches |
| `/build-and-test` | Build und Tests laufen lassen, Fehler beheben |

## Verfügbare Agents (für Entwickler)

| Agent | Beschreibung |
|---|---|
| `code-reviewer` | Gründliches Review mit Sicherheits- und Qualitätsfokus |
| `verify-app` | Verifikation nach grösseren Änderungen |

---

## Anpassung

### Persönliche Einstellungen

Erstelle `.claude/settings.local.json` (git-ignored) für persönliche Overrides:

```json
{
  "permissions": {
    "allow": [
      "Bash(docker *)"
    ]
  }
}
```

### Neue Rules hinzufügen

Erstelle eine `.md`-Datei in `.claude/rules/` mit optionalem Frontmatter:

```markdown
---
description: Kurze Beschreibung
globs: "*.ts,*.tsx"
---
# Regelname
- Regel 1
```

---

## Beitragen

Siehe [CONTRIBUTING.md](CONTRIBUTING.md).

## Team

Gepflegt vom Entwicklungsteam der Raptus AG, Lyss.

## Lizenz

MIT

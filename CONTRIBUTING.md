# Contributing – Claude Code bei Raptus

## Erste Schritte

1. Repo klonen oder Template verwenden
2. `claude` im Projektverzeichnis starten
3. `/help` zeigt verfügbare Commands

## Verfügbare Commands

- `/commit-push-pr` — Git-Workflow automatisieren
- `/review` — Code Review des aktuellen Branches
- `/build-and-test` — Build und Tests laufen lassen

## Wenn Claude einen Fehler macht

1. **Sofort korrigieren.** Nicht durchlaufen lassen.
2. **Lektion dokumentieren:** Sage Claude: "Dokumentiere diese Lektion in lessons.md"
3. **Im PR vermerken:** Wenn es ein wiederkehrendes Problem ist, CLAUDE.md oder eine Rule anpassen

## Code Review mit Claude

Bei Pull Reviews kannst du `@.claude` taggen (braucht die Claude Code GitHub Action). Claude kann dann:
- Fehler in der CLAUDE.md ergänzen
- Lektionen in lessons.md eintragen
- Direkt Verbesserungen vorschlagen

## Rules erweitern

Wenn du eine neue Regel brauchst:
1. Erstelle eine `.md`-Datei in `.claude/rules/`
2. Setze `globs` im Frontmatter auf die relevanten Dateitypen
3. Halte die Regel kurz und konkret
4. Erstelle einen PR

## Persönliche Einstellungen

Für persönliche Anpassungen: `.claude/settings.local.json` (git-ignored).
Diese Datei überschreibt Team-Einstellungen lokal.

## Wichtig

- **CLAUDE.md schlank halten.** Nur was jede Session braucht.
- **Rules für Spezifisches.** Sicherheit, Qualität, A11y sind ausgelagert.
- **Hooks für Determinismus.** Was immer passieren muss (Formatting), gehört in Hooks.
- **lessons.md pflegen.** Jeder Fehler, der dokumentiert wird, spart dem Team Zeit.

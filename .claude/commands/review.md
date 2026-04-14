---
description: Code Review des aktuellen Branches durchführen
---

Führe ein gründliches Code Review durch:

1. Zeige `git diff main...HEAD` (oder den Hauptbranch)
2. Prüfe jede geänderte Datei auf:
   - Sicherheitsprobleme (siehe .claude/rules/security.md)
   - Code-Qualität (siehe .claude/rules/code-quality.md)
   - Zugänglichkeit bei UI-Änderungen (siehe .claude/rules/accessibility.md)
3. Prüfe ob Tests vorhanden und sinnvoll sind
4. Fasse zusammen:
   - ✅ Was gut ist
   - ⚠️ Was verbessert werden sollte (mit konkretem Vorschlag)
   - 🛑 Was blockierend ist (Sicherheit, Breaking Changes)

Sei direkt und konstruktiv. Keine Floskeln.

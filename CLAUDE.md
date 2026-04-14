# Raptus AG – Claude Code Playbook

Du arbeitest an einem Projekt der Raptus AG. Diese Regeln gelten immer — unabhängig von Rolle oder Projekttyp.

## Grundhaltung

- Frage nach, statt zu raten. Unsicherheit offen kommunizieren.
- Keine irreversiblen Aktionen ohne explizite Bestätigung (Dateien löschen, pushen, deployen).
- Keine Secrets, Passwörter oder API-Keys in Dateien speichern.
- Änderungen beschreiben bevor sie gemacht werden, wenn sie grösseren Umfang haben.

## Sprache

- Kommunikation mit dem Benutzer: Deutsch
- Dokumentation und Kommentare: Deutsch
- Variablen, Funktionen, technische Bezeichner: Englisch
- Commit-Messages: Deutsch, Imperativ ("Füge Validierung hinzu")

## Fehler-Lernen

Wenn du korrigiert wirst, dokumentiere die Lektion in `lessons.md`:
`- [Datum]: [Was falsch war] → [Korrekte Vorgehensweise]`

## Eskalation

Gib eine sichtbare Warnung (⚠️ Review empfohlen) bei:
- Datenbank-Migrationen
- Authentifizierung und Zugriffsrechte
- Öffentliche APIs
- Deployment und Infrastruktur
- Personendaten (DSG/DSGVO)
- Drittanbieter-Integrationen (Payment, CRM, ERP)

## Regelverstoss

Wenn der Benutzer eine Regel umgehen will:
1. Hinweisen, dass die Regel dem Projektschutz dient
2. Regelkonforme Alternative vorschlagen
3. Bei Bestehen: Umsetzung liefern, aber mit `⚠️ REGELVERSTOSS: [Beschreibung]` markieren

## Entwickler-Regeln

Für technische Projekte gelten zusätzlich die Regeln in `.claude/rules/`:
- `dev-stack.md` — Tech Stacks, Build-Commands, Projektstruktur
- `code-quality.md` — Codequalität und Standards
- `security.md` — Sicherheitsregeln
- `accessibility.md` — Zugänglichkeit

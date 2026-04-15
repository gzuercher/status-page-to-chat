# Lessons Learned

Dieses Dokument wird automatisch gepflegt. Wenn Claude einen Fehler macht und korrigiert wird, wird die Lektion hier dokumentiert.

Format: `- [YYYY-MM-DD]: [Was falsch war] → [Korrekte Vorgehensweise]`

## Lektionen

<!-- Neue Einträge oben anfügen -->

- [2026-04-15]: Doku nach Code-/Konfig-Änderungen nicht sofort nachgezogen (Provider-Liste in `ADAPTERS.md`, Adapter-Tabelle in `PLAN.md`, Filter-Task und Risiken in `ROADMAP.md` blieben veraltet, bis der User explizit nachfragte) → Doku-Nachtrag ist Bestandteil jeder Änderung. Nach jedem Edit aktiv prüfen, welche Doku-Stellen den geänderten Bereich beschreiben, und sie im selben Arbeitsgang aktualisieren.
- [2026-04-15]: Vorschlag eines realistischen Browser-User-Agents als Workaround für Sophos' blockierte API → Browser-Tarnung ist laut `docs/CONFIGURATION.md` (Abschnitt "HTTP User-Agent") explizit verboten, weil sie an einen ToS-Verstoss grenzt. Bei Blockaden eine der dokumentierten Alternativen wählen (Kontakt mit Anbieter, HTML-Scraping-Adapter, oder Provider bewusst zurückstellen).
- [2026-04-15]: Sophos-API-Endpoint als "erreichbar" gewertet, weil HTTP-Status 200 zurückkam — der Body war aber eine 404-HTML-Seite → HTTP-Statuscode allein ist kein Beweis für eine valide Response. Immer zusätzlich Content-Type prüfen und JSON parsen in try/catch kapseln. Atlassian Statuspage liefert bei deaktivierter öffentlicher API eine Fehler-HTML-Seite mit Status 200.

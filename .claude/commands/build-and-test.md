---
description: Build und Tests ausführen, Fehler beheben
---

1. Erkenne den Tech Stack des Projekts (package.json → Next.js, composer.json → PHP/Laravel)
2. Führe den passenden Build aus:
   - Next.js: `pnpm build`
   - Laravel: `php artisan test`
   - WordPress: `npm run build` (falls vorhanden)
3. Führe Linting aus:
   - Next.js: `pnpm lint`
   - Laravel: `./vendor/bin/pint --test`
4. Falls Fehler auftreten:
   - Analysiere die Fehlermeldung
   - Behebe den Fehler
   - Laufe Build/Tests erneut
   - Wiederhole bis alles grün ist
5. Melde das Ergebnis: was lief, was fehlschlug, was behoben wurde

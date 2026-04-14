---
description: Zugänglichkeitsregeln für UI-Komponenten
globs: "*.tsx,*.jsx,*.html,*.blade.php"
---

# Zugänglichkeit (Accessibility)

- Bilder: `alt`-Attribut immer setzen.
- Formulare: jedes Input hat ein zugehöriges Label.
- Interaktive Elemente: per Tastatur bedienbar (Tab, Enter, Escape).
- Farbkontraste: WCAG AA einhalten (4.5:1 für Text, 3:1 für grosse Elemente).
- Semantisches HTML: `<button>` statt `<div onclick>`, `<nav>`, `<main>`, `<aside>`.
- ARIA: nur verwenden wenn kein natives HTML-Element passt.
- Focus-Management: sichtbarer Focus-Ring bei Tastaturnavigation.

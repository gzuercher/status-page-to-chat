---
description: Accessibility rules for UI components
globs: "*.tsx,*.jsx,*.html,*.blade.php"
---

# Accessibility

- Images: always set the `alt` attribute.
- Forms: every input has an associated label.
- Interactive elements: keyboard-navigable (Tab, Enter, Escape).
- Colour contrast: meet WCAG AA (4.5:1 for text, 3:1 for large elements).
- Semantic HTML: `<button>` instead of `<div onclick>`, `<nav>`, `<main>`, `<aside>`.
- ARIA: only use when no native HTML element fits.
- Focus management: visible focus ring for keyboard navigation.

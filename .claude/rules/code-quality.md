---
description: Code quality rules for TypeScript and PHP
globs: "*.ts,*.tsx,*.js,*.jsx,*.php"
---

# Code Quality

## TypeScript / JavaScript
- Strict mode: no `any` types, all functions typed.
- Error handling: try/catch with meaningful messages, no empty catch blocks.
- No `console.log` in production code. Use a logger (pino).
- Components under 200 lines. Split if exceeded.
- No duplicated code. Extract shared logic into helper functions.
- Imports: prefer absolute paths (e.g. `@/lib/utils`).

## PHP
- Follow PSR-12 coding standard.
- Typing: use PHP 8+ type hints.
- No suppressed errors (avoid `@` operator).
- WordPress: document hooks and filters.
- Laravel: form requests for validation, no controller-level validation.

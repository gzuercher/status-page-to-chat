---
description: Tech stacks, build commands and project structure for development projects
globs: "*.ts,*.tsx,*.js,*.jsx,*.php,*.blade.php,package.json,composer.json"
---

# Development Stack

## Tech Stacks

### Next.js (standard for new projects)
- Framework: Next.js (App Router) with TypeScript
- Styling: Tailwind CSS
- Package manager: pnpm
- Linting: ESLint, Prettier
- Tests: vitest, React Testing Library
- ORM: Prisma or Drizzle
- Auth: NextAuth.js / Auth.js
- Validation: zod

### PHP (legacy and Laravel)
- WordPress: theme/plugin development, WooCommerce
- Laravel: Composer, PHPUnit, Laravel Pint
- Custom PHP: PSR-12 standard

## Build & Test Commands

### Next.js
```bash
pnpm install        # install dependencies
pnpm dev            # development server
pnpm build          # production build
pnpm test           # tests
pnpm lint           # linting
pnpm format         # prettier
```

### Laravel
```bash
composer install     # dependencies
php artisan serve    # dev server
php artisan test     # tests
./vendor/bin/pint    # formatting
```

### WordPress
```bash
composer install     # if Composer is used
npm run build        # asset build (if present)
```

## Verification

Check EVERY change before marking it as done:
1. Build must pass
2. Linting must pass
3. If UI change: describe what you visually expect

## Forbidden DIY implementations

NEVER build the following yourself. Use the named library or ask:

| Topic | Use instead |
|---|---|
| Auth/Login | NextAuth.js / Auth.js (Next.js), Laravel Sanctum (PHP) |
| Password hashing | bcrypt, argon2 |
| JWT | jose |
| Email | Resend, Postmark |
| Payments | Stripe SDK |
| File upload | UploadThing, presigned URLs |
| Rate limiting | @upstash/ratelimit, Laravel throttle |
| Validation | zod (TS), Laravel Validation (PHP) |

## Project structure (Next.js)

```
src/
├── app/              # App Router pages and layouts
├── components/
│   ├── ui/           # Reusable UI components
│   └── features/     # Domain-specific components
├── lib/              # Helper functions, configurations
├── hooks/            # Custom React hooks
├── types/            # TypeScript types
└── server/           # Server logic, DB queries, services
```

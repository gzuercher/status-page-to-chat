#!/bin/bash
# Post-Edit Hook: Formatierung nach jeder Dateiänderung
# Wird automatisch von Claude Code ausgelöst (settings.json → PostToolUse)

FILE="$CLAUDE_FILE_PATHS"

if [ -z "$FILE" ]; then
  exit 0
fi

# Erkennung anhand Dateiendung
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.md)
    # Next.js / TypeScript Projekte: Prettier
    if command -v pnpm &> /dev/null && [ -f "package.json" ]; then
      pnpm prettier --write "$FILE" 2>/dev/null
    elif command -v npx &> /dev/null; then
      npx prettier --write "$FILE" 2>/dev/null
    fi
    ;;
  *.php)
    # Laravel: Pint
    if [ -f "vendor/bin/pint" ]; then
      ./vendor/bin/pint "$FILE" 2>/dev/null
    fi
    ;;
esac

exit 0

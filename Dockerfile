# syntax=docker/dockerfile:1.7

# ---- Build stage: compile TypeScript and resolve production deps -----------
FROM node:22-alpine AS builder

# Native deps for better-sqlite3 build
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Corepack activates pnpm without a network install
RUN corepack enable

# pnpm 10+ raises "ignored build scripts" to fatal ERR_PNPM_IGNORED_BUILDS
# during install AND prune. Neither pnpm.onlyBuiltDependencies in
# package.json nor npm_config_ignore_scripts ENV reliably suppress it in
# non-interactive Docker builds. The only knob that works is the explicit
# --ignore-scripts CLI flag, applied to every pnpm invocation. We then
# rebuild the single native module the runtime actually needs.

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Drop dev deps. --ignore-scripts is needed here too — prune re-runs the
# strict-builds check on the remaining tree.
RUN pnpm prune --prod --ignore-scripts \
 && pnpm rebuild better-sqlite3

# ---- Runtime stage: minimal image, non-root user ---------------------------
FROM node:22-alpine AS runtime

# Runtime only needs node itself; better-sqlite3's prebuilt native module is
# self-contained once installed.
WORKDIR /app

# Non-root user that owns the state volume
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data \
    && chown -R app:app /data

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --chown=app:app config ./config
# Seed template for first-run bootstrap. main.ts copies this to
# /data/providers.yaml when CONFIG_PATH points there and the file is
# missing — that way `docker compose up -d` works with zero host files.
COPY --chown=app:app providers.yaml.example ./providers.yaml.example

USER app

ENV NODE_ENV=production \
    STATE_DB_PATH=/data/state.sqlite \
    CONFIG_PATH=/data/providers.yaml \
    PROVIDERS_TEMPLATE_PATH=/app/providers.yaml.example

VOLUME ["/data"]

# Healthcheck queries the state DB for the last completed poll. Detects
# "process up but poll loop hung" — pure liveness on the entrypoint would
# not. start_period is generous because the first poll fetches ~25 status
# pages over the network.
HEALTHCHECK --interval=2m --timeout=15s --start-period=2m --retries=2 \
  CMD node dist/src/main.js health || exit 1

CMD ["node", "dist/src/main.js"]

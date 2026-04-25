# syntax=docker/dockerfile:1.7

# ---- Build stage: compile TypeScript and resolve production deps -----------
FROM node:20-alpine AS builder

# Native deps for better-sqlite3 build
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Corepack activates pnpm without a network install
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Drop dev deps so only runtime deps are copied to the final stage
RUN pnpm prune --prod

# ---- Runtime stage: minimal image, non-root user ---------------------------
FROM node:20-alpine AS runtime

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

USER app

ENV NODE_ENV=production \
    STATE_DB_PATH=/data/state.sqlite

VOLUME ["/data"]

CMD ["node", "dist/src/main.js"]

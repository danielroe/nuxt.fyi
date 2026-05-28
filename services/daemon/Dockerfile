FROM node:24-bookworm-slim AS workspace

WORKDIR /repo
RUN corepack enable

# Build context is the repo root (see `[build] dockerfile = ...` in fly.toml). We need
# every package.json reachable so `pnpm install` can resolve the workspace graph.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/daemon/package.json services/daemon/
COPY services/scanner/package.json services/scanner/
COPY dashboard/package.json dashboard/

RUN pnpm fetch

# Split deps install into two stages so the daemon image doesn't need Nuxt's devDeps.

# --- daemon: production deps only ---
FROM workspace AS daemon-deps

ENV CI=true
RUN pnpm install --filter @nuxt-fyi/daemon --prod --frozen-lockfile --ignore-scripts --offline

# --- dashboard: install + build ---
FROM workspace AS dashboard-build

RUN pnpm install --filter nuxt-fyi-dashboard --frozen-lockfile --offline
COPY dashboard/ ./dashboard/
RUN pnpm --filter nuxt-fyi-dashboard build

# --- runtime ---
FROM node:24-bookworm-slim AS runtime

# Daemon image is intentionally lean after the scanner extraction: no Chromium, no
# extension, no Playwright. The screenshot pipeline lives on the nuxt-fyi-scanner app.
ENV NODE_ENV=production
ENV NUXT_DATA_DIR=/data
ENV NUXT_SCREENSHOT_DIR=/data/screenshots

WORKDIR /app
RUN corepack enable

COPY --from=daemon-deps /repo/node_modules ./node_modules
COPY services/daemon/package.json ./
COPY services/daemon/scripts ./scripts
# curl/unzip stay for the runtime Tranco/nuxt-versions ingest.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

COPY services/daemon/src ./src
COPY services/daemon/tsconfig.json ./

# Nitro's standalone output bundles its own node_modules; no install needed at runtime.
COPY --from=dashboard-build /repo/dashboard/.output ./dashboard/.output

RUN mkdir -p /data/screenshots

# Single entrypoint runs daemon + dashboard inside one machine.
CMD ["node", "scripts/run-machine.mjs"]

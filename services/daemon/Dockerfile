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

FROM workspace AS daemon-deploy

ENV CI=true
COPY services/daemon/ ./services/daemon/
RUN pnpm install --frozen-lockfile --ignore-scripts --offline \
 && pnpm --filter @nuxt-fyi/daemon --prod deploy --legacy /deploy/daemon

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

WORKDIR /app
RUN corepack enable

COPY --from=daemon-deploy /deploy/daemon/ ./

# curl/unzip stay for the runtime Tranco/nuxt-versions ingest.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# Nitro's standalone output bundles its own node_modules; no install needed at runtime.
COPY --from=dashboard-build /repo/dashboard/.output ./dashboard/.output

RUN mkdir -p /data

# Single entrypoint runs daemon + dashboard inside one machine.
CMD ["node", "scripts/run-machine.mjs"]

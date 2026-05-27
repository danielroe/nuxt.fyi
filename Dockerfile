FROM node:24-bookworm-slim AS workspace

WORKDIR /repo
RUN corepack enable

# Copy the entire workspace metadata so `pnpm install --frozen-lockfile` can resolve the
# whole graph. Source code is copied in the build/runtime stages, not here.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY dashboard/package.json dashboard/

RUN pnpm fetch

# Now copy each package.json into its position (already done above), plus actual source.
# We split deps install into two stages so the daemon image doesn't need Nuxt's devDeps.

# --- daemon: production deps only ---
FROM workspace AS daemon-deps

ENV CI=true
RUN pnpm install --filter nuxt-fyi --prod --frozen-lockfile --ignore-scripts --offline

# --- dashboard: install + build ---
FROM workspace AS dashboard-build

RUN pnpm install --filter nuxt-fyi-dashboard --frozen-lockfile --offline
COPY dashboard/ ./dashboard/
RUN pnpm --filter nuxt-fyi-dashboard build

# --- runtime ---
FROM node:24-bookworm-slim AS runtime

# `playwright install --with-deps chromium` installs the browser binary and its apt deps
# at build time so the runtime container has both baked in.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production
ENV NUXT_DATA_DIR=/data
ENV NUXT_SCREENSHOT_DIR=/data/screenshots

WORKDIR /app
RUN corepack enable

COPY --from=daemon-deps /repo/node_modules ./node_modules
COPY package.json ./
COPY scripts ./scripts
# One apt cycle: Chromium runtime deps (via playwright), plus curl/unzip needed at build
# (extension fetch) and runtime (periodic Tranco/nuxt-versions ingest).
RUN node_modules/.bin/playwright install --with-deps chromium \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && node scripts/fetch-extension.mjs \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY tsconfig.json ./

# Nitro's standalone output bundles its own node_modules; no install needed at runtime.
COPY --from=dashboard-build /repo/dashboard/.output ./dashboard/.output

RUN mkdir -p /data/screenshots

# Single entrypoint runs daemon + dashboard inside one machine.
CMD ["node", "scripts/run-machine.mjs"]

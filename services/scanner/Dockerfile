FROM node:24-bookworm-slim AS workspace

WORKDIR /repo
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ ./patches/
COPY services/daemon/package.json services/daemon/
COPY services/scanner/package.json services/scanner/
COPY dashboard/package.json dashboard/

RUN pnpm fetch

# --- scanner: install + build ---
FROM workspace AS scanner-build

ENV CI=true
# We don't pass --offline here because tfjs-node's postinstall downloads libtensorflow
# from storage.googleapis.com; pnpm fetch above only seeds the store with package
# tarballs, not arbitrary runtime artefacts pulled by postinstalls.
RUN pnpm install --filter @nuxt-fyi/scanner --frozen-lockfile
COPY services/scanner/ ./services/scanner/
# Nitro v3 builds with Vite into .output/server/, bundling its own node_modules. The
# resulting tree is fully self-contained.
RUN pnpm --filter @nuxt-fyi/scanner build

# --- runtime ---
FROM node:24-bookworm-slim AS runtime

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=::
ENV EXTENSION_DIR=/app/services/scanner/vendor/isdcac

WORKDIR /app
RUN corepack enable

# We need Playwright + Chromium pre-installed before the extension fetch script runs.
# Copying just the scanner's package.json + a minimal node_modules tree from workspace
# install would be enough, but running `playwright install` needs the playwright CLI on
# disk, so we re-install scanner deps here. This is a small image anyway since there's
# no SQLite, no Nuxt, no @atproto/api.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ ./patches/
COPY services/scanner/package.json services/scanner/
# We omit --ignore-scripts so tfjs-node's postinstall fetches libtensorflow during the
# build. Playwright's postinstall also runs (cheap; we still call `playwright install`
# below to materialise the browser binaries into PLAYWRIGHT_BROWSERS_PATH).
RUN pnpm install --filter @nuxt-fyi/scanner --prod --frozen-lockfile

COPY services/scanner/scripts ./services/scanner/scripts

# One apt cycle: Chromium runtime deps (via playwright), plus curl/unzip needed for the
# extension fetch step.
RUN cd services/scanner && node_modules/.bin/playwright install --with-deps chromium \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && node scripts/fetch-extension.mjs \
 && rm -rf /var/lib/apt/lists/*

# The Nitro build output is a self-contained Node bundle. We copy it into a sibling
# location to vendor/, so the extension path (`../vendor/isdcac` from the runtime
# bundle's perspective) still resolves.
COPY --from=scanner-build /repo/services/scanner/.output ./services/scanner/.output

WORKDIR /app/services/scanner
CMD ["node", ".output/server/index.mjs"]

# nuxt.fyi

> Spots Nuxt sites being shared on Bluesky and posts screenshots of them.

[👉 &nbsp;Check it out](https://nuxt.fyi/)

The aim of [nuxt.fyi](https://nuxt.fyi/) is to celebrate sites built with [Nuxt](https://nuxt.com/) in the wild.

It watches the Bluesky [Jetstream](https://github.com/bluesky-social/jetstream) firehose, pulls every link out of every post, and for each new domain asks: *is this built with Nuxt?* When the answer is yes, it posts a screenshot on [Bluesky](https://bsky.app/profile/nuxt.fyi).

The [public dashboard](https://nuxt.fyi/) shows everything that's been detected, broken down by version and recency.

## Features

- Detection signals across HTML and a Playwright runtime probe (`<div id="__nuxt">`, `__NUXT_DATA__`, `window.__NUXT__`, `meta[name=generator]`, `/_nuxt/` assets)
- Screenshots taken in a persistent Chromium context, with layered cookie-banner suppression (GTM consent cookie, CSS overlay, and a pinned [`I-Still-Dont-Care-About-Cookies`](https://github.com/OhMyGuus/I-Still-Dont-Care-About-Cookies) extension)
- Discord + Bluesky notifications with rate-limit-aware posting
- Nuxt 4 dashboard reading the same SQLite database read-only
- Runs on a single [Fly.io](https://fly.io/) machine; daemon and dashboard share one volume
- Node 24+ only: native TS execution, `node:sqlite`, global `fetch` and `WebSocket`

## Try it out locally

You will need a [Discord webhook URL](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) and, optionally, a Bluesky account with an [app password](https://bsky.app/settings/app-passwords) for posting.

```bash
cp .env.example .env
# edit .env, set DISCORD_WEBHOOK_URL (and BLUESKY_* if you want)

corepack enable
pnpm install
pnpm install-extension
pnpm --filter @nuxt-fyi/scanner exec playwright install chromium

# scanner (terminal 1: screenshot service on :3001)
pnpm dev:scanner

# daemon (terminal 2)
pnpm dev

# dashboard (terminal 3)
pnpm dev:dashboard
```

Set `VERBOSE=1` to log every post the daemon sees.

## NSFW classification

Screenshots are classified with [nsfwjs](https://github.com/infinitered/nsfwjs) on the
scanner machine at capture time. Each row gets one of three labels:

- `safe` (default): renders normally everywhere.
- `suggestive`: renders normally on the dashboard; Bluesky posts get a `sexual` self-label
  so users can opt to blur via their account preferences.
- `nsfw`: dashboard blurs the image with a click-to-reveal overlay; Bluesky posts get a
  `porn` self-label; Discord posts attach the image as a `SPOILER_*` file rather than
  rendering inline in the embed.

Thresholds are tunable via `NSFW_PORN_THRESHOLD` (default 0.5) and `NSFW_SEXY_THRESHOLD`
(default 0.6) on the scanner. After tweaking, re-run the backfill with `--reclassify` to
relabel historical rows.

## Architecture

Three processes split across two Fly apps:

- `nuxt-fyi` (this `fly.toml`): daemon (Jetstream consumer + detection) and dashboard
  (Nuxt 4) in one container, sharing the SQLite volume at `/data`.
- `nuxt-fyi-scanner` (`fly.scanner.toml`): Nitro v3 service that owns Playwright + the
  screenshot half of the ImageKit upload. No public ingress; daemon reaches it on
  `nuxt-fyi-scanner.internal:3000` via Fly's 6PN private networking. Stays always-on at
  `shared-cpu-2x` because `.internal` doesn't wake stopped machines.
- ImageKit: external CDN for screenshots + og:images.

The daemon talks to the scanner via an authenticated HTTP call (`SCANNER_TOKEN` shared
secret). Scanner outages degrade quality (no screenshot) but don't break the pipeline:
the og:image is still uploaded and the hit is still recorded + posted.

## Image hosting

Screenshots and og:images are uploaded to [ImageKit](https://imagekit.io) at scan time
so the dashboard can render them through `@nuxt/image` with on-the-fly resizing. The
dashboard renders ImageKit URLs only; for the rare row where the daemon recorded an
og:image origin but the upload didn't land, a plain `<img>` falls back to the upstream
URL.

## Backfill scripts

Two idempotent scripts on the daemon side, safe to re-run:

```bash
# Rescan Nuxt-confirmed rows missing an ImageKit screenshot, or with an og:image URL
# recorded but no ImageKit copy. Uses the live scanner; ignores RESCAN_AFTER_MS.
pnpm backfill-images --concurrency=2

# NSFW-classify every row that has an image but no nsfw_label. Calls the scanner's
# /classify endpoint. Add --reclassify after threshold tweaks to relabel all rows.
pnpm backfill-nsfw --concurrency=2
```

Both support `--limit=N` and `--dry-run`.

## Admin CLI

On the running Fly machine (`fly ssh console -C bash`), you can re-scan one or more
domains against the live database:

```bash
cd /app
node src/cli/rescan.ts example.com another.com

# refresh only the screenshot/og:image on an existing Nuxt hit
node src/cli/rescan.ts --screenshot-only example.com

# suppress Discord + Bluesky posts even when the domain is newly detected as Nuxt
node src/cli/rescan.ts --no-notify example.com
```

## Credits

Detection heuristics and the GTM consent-cookie trick are lifted from [`nuxtlabs/vue-telescope-analyzer`](https://github.com/nuxtlabs/vue-telescope-analyzer) ❤️

## License

Made with ❤️

Published under [MIT License](./LICENSE).

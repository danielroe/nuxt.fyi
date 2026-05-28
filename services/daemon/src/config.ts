import { resolve } from 'node:path'

function num(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function bool(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

export const config = {
  jetstreamUrl: process.env.JETSTREAM_URL || 'wss://jetstream2.us-east.bsky.network/subscribe',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  scanConcurrency: num(process.env.SCAN_CONCURRENCY, 2),
  rescanAfterMs: num(process.env.RESCAN_AFTER_MS, 30 * 24 * 60 * 60 * 1000),
  // Defaults point at the repo-root `data/` and `screenshots/` directories, two levels
  // up from this package (`services/daemon/`). The dashboard's defaults resolve to the
  // same paths from its own location so both processes share state out of the box.
  dataDir: resolve(process.env.NUXT_DATA_DIR || '../../data'),
  screenshotDir: resolve(process.env.NUXT_SCREENSHOT_DIR || '../../screenshots'),
  verbose: bool(process.env.VERBOSE),
  scanner: {
    /** Base URL of the screenshot service, e.g. http://nuxt-fyi-scanner.internal:3000.
     *  Empty disables remote capture; the dashboard will still render og:images. */
    url: process.env.SCANNER_URL || '',
    /** Shared bearer token. Must match SCANNER_TOKEN on the scanner machine. */
    token: process.env.SCANNER_TOKEN || '',
  },
  imagekit: {
    /** Public URL endpoint, e.g. https://ik.imagekit.io/<id>. Empty disables uploads. */
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || '',
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY || '',
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY || '',
    /** Base folder inside the bucket. Screenshots and og:images get distinct subfolders
     *  underneath so the dashboard can render both for the same domain. */
    rootFolder: process.env.IMAGEKIT_ROOT_FOLDER || '/nuxt-fyi',
  },
  bluesky: {
    service: process.env.BLUESKY_SERVICE || 'https://bsky.social',
    identifier: process.env.BLUESKY_IDENTIFIER || '',
    appPassword: process.env.BLUESKY_APP_PASSWORD || '',
    /** Minimum interval between Bluesky posts in ms. Defaults to 15 minutes. */
    minIntervalMs: num(process.env.BLUESKY_MIN_INTERVAL_MS, 15 * 60 * 1000),
  },
} as const

export type Config = typeof config

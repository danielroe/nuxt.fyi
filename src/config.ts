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
  dataDir: resolve(process.env.NUXT_DATA_DIR || './data'),
  screenshotDir: resolve(process.env.NUXT_SCREENSHOT_DIR || './screenshots'),
  verbose: bool(process.env.VERBOSE),
  bluesky: {
    service: process.env.BLUESKY_SERVICE || 'https://bsky.social',
    identifier: process.env.BLUESKY_IDENTIFIER || '',
    appPassword: process.env.BLUESKY_APP_PASSWORD || '',
    /** Minimum interval between Bluesky posts in ms. Defaults to 15 minutes. */
    minIntervalMs: num(process.env.BLUESKY_MIN_INTERVAL_MS, 15 * 60 * 1000),
  },
} as const

export type Config = typeof config

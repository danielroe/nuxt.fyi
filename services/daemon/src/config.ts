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
  /**
   * Concurrency for detection jobs (HTML fetch + endpoint probes + JS scan). All I/O-
   * bound, so the daemon can comfortably run a few dozen in parallel.
   */
  detectionConcurrency: num(process.env.DETECTION_CONCURRENCY, 8),
  /**
   * Concurrency for capture jobs (call scanner + upload og:image to ImageKit). Bound
   * by the scanner's `hard_limit` in `fly.scanner.toml`; pushing past that just queues
   * at Fly's edge.
   */
  captureConcurrency: num(process.env.CAPTURE_CONCURRENCY, 4),
  rescanAfterMs: num(process.env.RESCAN_AFTER_MS, 30 * 24 * 60 * 60 * 1000),
  // Defaults point at the repo-root `data/` directory, two levels up from this package
  // (`services/daemon/`). The dashboard's default resolves to the same path from its own
  // location so both processes share the SQLite db out of the box.
  dataDir: resolve(process.env.NUXT_DATA_DIR || '../../data'),
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
  submit: {
    /** Port for the daemon's submit HTTP endpoint. Bound to 127.0.0.1 only; the
     *  dashboard process (running in the same container in prod, same host in dev)
     *  POSTs to it. Set `DAEMON_SUBMIT_ENABLED=0` to disable entirely. Port 0 means
     *  "let the OS pick" (handy for tests). */
    enabled: process.env.DAEMON_SUBMIT_ENABLED !== '0',
    port: num(process.env.DAEMON_SUBMIT_PORT, 3010),
    /** Shared bearer token between the dashboard's `/api/submit` route and this
     *  endpoint. Empty disables: the daemon refuses every request, and the dashboard
     *  surfaces a configuration error. */
    token: process.env.DAEMON_SUBMIT_TOKEN || '',
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

#!/usr/bin/env node
/**
 * Walks every Nuxt-confirmed row in `scans` and uploads its screenshot + og:image to
 * ImageKit, populating the `screenshot_key` / `og_image_key` columns. Idempotent: rows
 * that already have a key for a given source are skipped.
 *
 * Run from the daemon workspace (or `pnpm --filter @nuxt-fyi/daemon backfill-imagekit`):
 *   IMAGEKIT_URL_ENDPOINT=... IMAGEKIT_PRIVATE_KEY=... node scripts/backfill-imagekit.mjs
 *
 * Flags:
 *   --concurrency=N   parallel uploads (default 3, keep low to stay under ImageKit free
 *                     tier rate limits and avoid burning bandwidth budget on a burst)
 *   --limit=N         only process the first N candidate rows (useful for testing)
 *   --dry-run         report what would be uploaded without touching ImageKit or the DB
 */

import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

const { values } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '3' },
    limit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})

const CONCURRENCY = Math.max(1, Number(values.concurrency) || 3)
const LIMIT = values.limit ? Math.max(1, Number(values.limit)) : null
const DRY_RUN = !!values['dry-run']

const dataDir = resolve(process.env.NUXT_DATA_DIR || process.env.DATA_DIR || '../../data')
const screenshotDir = resolve(process.env.NUXT_SCREENSHOT_DIR || '../../screenshots')
const dbPath = join(dataDir, 'nuxt-fyi.db')

if (!existsSync(dbPath)) {
  console.error(`[backfill] no database at ${dbPath}`)
  process.exit(1)
}

const endpoint = process.env.IMAGEKIT_URL_ENDPOINT || ''
const privateKey = process.env.IMAGEKIT_PRIVATE_KEY || ''
const rootFolder = process.env.IMAGEKIT_ROOT_FOLDER || '/nuxt-fyi'

if (!DRY_RUN && (!endpoint || !privateKey)) {
  console.error('[backfill] IMAGEKIT_URL_ENDPOINT and IMAGEKIT_PRIVATE_KEY are required (or pass --dry-run)')
  process.exit(1)
}

let client = null
let toFile = null
if (!DRY_RUN) {
  const mod = await import('@imagekit/nodejs')
  client = new mod.default({ privateKey })
  toFile = mod.toFile
}

const db = new DatabaseSync(dbPath)
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000;`)

// Apply the same idempotent migrations the daemon runs at boot. The script may be the
// first thing to open the db in a fresh deploy, so we can't assume the new columns exist.
for (const ddl of [
  `ALTER TABLE scans ADD COLUMN screenshot_key TEXT`,
  `ALTER TABLE scans ADD COLUMN og_image_key TEXT`,
]) {
  try { db.exec(ddl) }
  catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err
  }
}

const safeName = (domain) => domain.replace(/[^a-z0-9.-]/gi, '_')

function extensionFromMime(type) {
  if (!type) return 'jpg'
  const main = type.split(';')[0].trim().toLowerCase()
  switch (main) {
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/avif': return 'avif'
    case 'image/svg+xml': return 'svg'
    default: return 'jpg'
  }
}

const updateStmt = db.prepare(`
  UPDATE scans SET screenshot_key = COALESCE(?, screenshot_key), og_image_key = COALESCE(?, og_image_key) WHERE domain = ?
`)

const rows = db.prepare(`
  SELECT domain, screenshot_path, og_image, screenshot_key, og_image_key
  FROM scans
  WHERE is_nuxt = 1
    AND (
      (screenshot_path IS NOT NULL AND screenshot_key IS NULL)
      OR (og_image IS NOT NULL AND og_image_key IS NULL)
    )
  ORDER BY scanned_at DESC
  ${LIMIT ? 'LIMIT ?' : ''}
`).all(...(LIMIT ? [LIMIT] : []))

console.log(`[backfill] ${rows.length} row(s) to process (concurrency=${CONCURRENCY}${DRY_RUN ? ', dry-run' : ''})`)

let done = 0
let uploadedScreenshots = 0
let uploadedOgImages = 0
let failures = 0

async function uploadScreenshot(domain, localPath) {
  try {
    await stat(localPath)
  } catch {
    console.warn(`[backfill] ${domain} screenshot missing on disk: ${localPath}`)
    return null
  }
  if (DRY_RUN) return `dry-run/screenshots/${safeName(domain)}.jpg`
  try {
    const stream = createReadStream(localPath)
    const res = await client.files.upload({
      file: stream,
      fileName: `${safeName(domain)}.jpg`,
      folder: `${rootFolder}/screenshots`,
      useUniqueFileName: false,
      overwriteFile: true,
    })
    return res.filePath || null
  } catch (err) {
    console.warn(`[backfill] ${domain} screenshot upload failed: ${err.message}`)
    return null
  }
}

async function uploadOgImage(domain, url) {
  if (DRY_RUN) return `dry-run/og-images/${safeName(domain)}.jpg`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NuxtFyi-Backfill/0.1; +https://nuxt.fyi)' },
    })
    if (!res.ok) {
      console.warn(`[backfill] ${domain} og:image ${url} returned ${res.status}`)
      return null
    }
    const type = res.headers.get('content-type')
    if (!type || !/^image\//i.test(type)) {
      console.warn(`[backfill] ${domain} og:image ${url} non-image content-type ${type}`)
      return null
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > 10 * 1024 * 1024) {
      console.warn(`[backfill] ${domain} og:image too large (${buf.byteLength} bytes)`)
      return null
    }
    const ext = extensionFromMime(type)
    const file = await toFile(buf, `${safeName(domain)}.${ext}`)
    const upload = await client.files.upload({
      file,
      fileName: `${safeName(domain)}.${ext}`,
      folder: `${rootFolder}/og-images`,
      useUniqueFileName: false,
      overwriteFile: true,
    })
    return upload.filePath || null
  } catch (err) {
    console.warn(`[backfill] ${domain} og:image upload failed: ${err.message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function processRow(row) {
  let newScreenshotKey = null
  let newOgImageKey = null

  if (row.screenshot_path && !row.screenshot_key) {
    const localPath = join(screenshotDir, `${safeName(row.domain)}.jpg`)
    const filePath = await uploadScreenshot(row.domain, localPath)
    if (filePath) {
      newScreenshotKey = filePath
      uploadedScreenshots++
    } else {
      failures++
    }
  }
  if (row.og_image && !row.og_image_key) {
    const filePath = await uploadOgImage(row.domain, row.og_image)
    if (filePath) {
      newOgImageKey = filePath
      uploadedOgImages++
    } else {
      failures++
    }
  }

  if (!DRY_RUN && (newScreenshotKey || newOgImageKey)) {
    updateStmt.run(newScreenshotKey, newOgImageKey, row.domain)
  }

  done++
  if (done % 50 === 0 || done === rows.length) {
    console.log(`[backfill] ${done}/${rows.length} processed (screenshots=${uploadedScreenshots} og-images=${uploadedOgImages} failures=${failures})`)
  }
}

const queue = [...rows]
const workers = []
for (let i = 0; i < CONCURRENCY; i++) {
  workers.push((async () => {
    while (queue.length > 0) {
      const row = queue.shift()
      if (!row) break
      await processRow(row)
    }
  })())
}
await Promise.all(workers)

console.log(`[backfill] done. screenshots=${uploadedScreenshots} og-images=${uploadedOgImages} failures=${failures}`)

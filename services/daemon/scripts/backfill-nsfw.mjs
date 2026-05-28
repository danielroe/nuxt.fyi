#!/usr/bin/env node
/**
 * Walks every Nuxt-confirmed row with an unclassified screenshot and asks the scanner
 * to classify it. Idempotent: rows with `nsfw_label IS NOT NULL` are skipped.
 *
 * The scanner classifies whatever image bytes are at the URL we give it; we point it at
 * the ImageKit-hosted screenshot when there is one, otherwise the upstream og:image URL.
 * Rows with neither are skipped (nothing to classify).
 *
 * Run:
 *   SCANNER_URL=... SCANNER_TOKEN=... IMAGEKIT_URL_ENDPOINT=... \
 *     pnpm --filter @nuxt-fyi/daemon backfill-nsfw
 *
 * Flags:
 *   --concurrency=N   parallel classify calls (default 2, scanner has its own gate)
 *   --limit=N         only process the first N candidate rows
 *   --dry-run         report what would be classified without persisting
 *   --reclassify      also re-process rows that already have a label (useful after a
 *                     classifier threshold tweak)
 */

import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '2' },
    limit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    reclassify: { type: 'boolean', default: false },
  },
})

const CONCURRENCY = Math.max(1, Number(values.concurrency) || 2)
const LIMIT = values.limit ? Math.max(1, Number(values.limit)) : null
const DRY_RUN = !!values['dry-run']
const RECLASSIFY = !!values.reclassify

const dataDir = resolve(process.env.NUXT_DATA_DIR || process.env.DATA_DIR || '../../data')
const dbPath = join(dataDir, 'nuxt-fyi.db')

if (!existsSync(dbPath)) {
  console.error(`[backfill-nsfw] no database at ${dbPath}`)
  process.exit(1)
}

const scannerUrl = (process.env.SCANNER_URL || '').replace(/\/$/, '')
const scannerToken = process.env.SCANNER_TOKEN || ''
const imagekitEndpoint = (process.env.IMAGEKIT_URL_ENDPOINT || '').replace(/\/$/, '')

if (!DRY_RUN && (!scannerUrl || !scannerToken)) {
  console.error('[backfill-nsfw] SCANNER_URL and SCANNER_TOKEN are required (or pass --dry-run)')
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000;`)

// Idempotent migrations in case this script runs before the daemon has touched the db.
for (const ddl of [
  `ALTER TABLE scans ADD COLUMN nsfw_label TEXT`,
  `ALTER TABLE scans ADD COLUMN nsfw_score REAL`,
  `ALTER TABLE scans ADD COLUMN nsfw_categories TEXT`,
  `ALTER TABLE scans ADD COLUMN nsfw_classified_at INTEGER`,
]) {
  try { db.exec(ddl) }
  catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err
  }
}

const updateStmt = db.prepare(`
  UPDATE scans SET nsfw_label = ?, nsfw_score = ?, nsfw_categories = ?, nsfw_classified_at = ? WHERE domain = ?
`)

const where = RECLASSIFY
  ? `is_nuxt = 1 AND (screenshot_key IS NOT NULL OR og_image_key IS NOT NULL OR og_image IS NOT NULL)`
  : `is_nuxt = 1 AND nsfw_label IS NULL AND (screenshot_key IS NOT NULL OR og_image_key IS NOT NULL OR og_image IS NOT NULL)`

const rows = db.prepare(`
  SELECT domain, screenshot_key, og_image_key, og_image
  FROM scans
  WHERE ${where}
  ORDER BY scanned_at DESC
  ${LIMIT ? 'LIMIT ?' : ''}
`).all(...(LIMIT ? [LIMIT] : []))

console.log(`[backfill-nsfw] ${rows.length} row(s) to process (concurrency=${CONCURRENCY}${DRY_RUN ? ', dry-run' : ''}${RECLASSIFY ? ', reclassify' : ''})`)

function pickUrl(row) {
  if (row.screenshot_key && imagekitEndpoint) return `${imagekitEndpoint}${row.screenshot_key}`
  if (row.og_image_key && imagekitEndpoint) return `${imagekitEndpoint}${row.og_image_key}`
  if (row.og_image) return row.og_image
  return null
}

let done = 0
let classified = 0
let nsfwHits = 0
let suggestiveHits = 0
let failures = 0

async function processRow(row) {
  const url = pickUrl(row)
  if (!url) {
    failures++
    return
  }
  if (DRY_RUN) {
    console.log(`[backfill-nsfw] would classify ${row.domain} via ${url}`)
    return
  }
  try {
    const res = await fetch(`${scannerUrl}/classify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${scannerToken}`,
      },
      body: JSON.stringify({ url }),
    })
    const result = await res.json()
    if (!res.ok || !result.nsfw) {
      console.warn(`[backfill-nsfw] ${row.domain} classify failed: ${result.error ?? res.status}`)
      failures++
      return
    }
    updateStmt.run(
      result.nsfw.label,
      result.nsfw.score,
      JSON.stringify(result.nsfw.categories),
      Date.now(),
      row.domain,
    )
    classified++
    if (result.nsfw.label === 'nsfw') nsfwHits++
    else if (result.nsfw.label === 'suggestive') suggestiveHits++
  }
  catch (err) {
    console.warn(`[backfill-nsfw] ${row.domain} request failed: ${err.message}`)
    failures++
  }
  finally {
    done++
    if (done % 25 === 0 || done === rows.length) {
      console.log(`[backfill-nsfw] ${done}/${rows.length} processed (classified=${classified} nsfw=${nsfwHits} suggestive=${suggestiveHits} failures=${failures})`)
    }
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

console.log(`[backfill-nsfw] done. classified=${classified} nsfw=${nsfwHits} suggestive=${suggestiveHits} failures=${failures}`)

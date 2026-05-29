#!/usr/bin/env node
/**
 * Rescans every Nuxt-confirmed row that's missing an ImageKit-hosted screenshot, OR has
 * an og:image origin URL recorded but no ImageKit copy of it. Reuses `scanDomain`
 * end-to-end so the same scanner / ImageKit / NSFW pipeline runs as for live scans.
 * Ignores `RESCAN_AFTER_MS`.
 *
 * Rows where the site simply doesn't declare an og:image (so `og_image IS NULL`) are
 * left alone if they already have a screenshot key — there's nothing rescanning would
 * fix.
 *
 * Notifications are suppressed (Bluesky and Discord aren't supposed to re-fire on
 * historical rows). Concurrency is bounded by `--concurrency` and ultimately by the
 * scanner's own per-machine cap.
 *
 * Run:
 *   pnpm --filter @nuxt-fyi/daemon backfill-images
 *
 * Flags:
 *   --concurrency=N   parallel scans (default 2)
 *   --limit=N         only the first N candidate rows
 *   --dry-run         report what would be rescanned
 */

import { parseArgs } from 'node:util'
import { log } from '../log.ts'
import { scanDomain } from '../scan/index.ts'
import { persistOutcome } from '../pipeline.ts'
import { db } from '../store.ts'

const { values } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '2' },
    limit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})

const CONCURRENCY = Math.max(1, Number(values.concurrency) || 2)
const LIMIT = values.limit ? Math.max(1, Number(values.limit)) : null
const DRY_RUN = !!values['dry-run']

interface CandidateRow {
  domain: string
  screenshot_key: string | null
  og_image_key: string | null
  og_image: string | null
}

const where = `
  is_nuxt = 1
  AND (
    screenshot_key IS NULL
    OR (og_image IS NOT NULL AND og_image_key IS NULL)
  )
`

const rows = db.prepare(`
  SELECT domain, screenshot_key, og_image_key, og_image
  FROM scans
  WHERE ${where}
  ORDER BY scanned_at DESC
  ${LIMIT ? 'LIMIT ?' : ''}
`).all(...(LIMIT ? [LIMIT] : [])) as unknown as CandidateRow[]

log.info(`[backfill-images] ${rows.length} row(s) to process (concurrency=${CONCURRENCY}${DRY_RUN ? ', dry-run' : ''})`)

let done = 0
let success = 0
let failures = 0

async function processRow(row: CandidateRow): Promise<void> {
  if (DRY_RUN) {
    log.info(`[backfill-images] would rescan ${row.domain} (shot=${row.screenshot_key ? 'yes' : 'no'} og=${row.og_image_key ? 'yes' : 'no'})`)
    return
  }
  try {
    const outcome = await scanDomain(row.domain)
    persistOutcome(outcome)
    if (outcome.error) {
      log.warn(`[backfill-images] ${row.domain}: ${outcome.error}`)
      failures++
    }
    else {
      success++
      log.info(`[backfill-images] ${row.domain} ok (ik-shot=${outcome.screenshotKey ? 'yes' : 'no'} ik-og=${outcome.ogImageKey ? 'yes' : 'no'} nsfw=${outcome.nsfwLabel ?? 'unknown'})`)
    }
  }
  catch (err) {
    log.error(`[backfill-images] ${row.domain} failed:`, (err as Error).message)
    failures++
  }
  finally {
    done++
    if (done % 10 === 0 || done === rows.length) {
      log.info(`[backfill-images] ${done}/${rows.length} processed (success=${success} failures=${failures})`)
    }
  }
}

const queue = [...rows]
const workers: Promise<void>[] = []
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

log.success(`[backfill-images] done. success=${success} failures=${failures}`)
process.exit(failures > 0 ? 1 : 0)

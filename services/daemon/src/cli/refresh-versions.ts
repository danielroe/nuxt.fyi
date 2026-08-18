#!/usr/bin/env node
/**
 * Corpus-wide Nuxt version refresh. Detection only: 1-3 plain HTTP requests per domain
 * (HTML fetch, endpoint probes, entry-chunk grep), no Chromium, no screenshots, no
 * notifications. Designed to be invoked over `fly ssh console` like the rescan CLI;
 * shares the daemon's SQLite database WAL-safely.
 *
 * Every attempt is appended to `version_checks` (including blocked and errored ones) so
 * adoption is chartable over time. The `scans` row is only overwritten when the fetch
 * produced a trustworthy result (`outcome = 'ok'`): a challenge wall or a network error
 * must not flip a confirmed hit to is_nuxt = 0.
 */
import { parseArgs } from 'node:util'
import { log } from '../log.ts'
import { detectDomain } from '../scan/index.ts'
import { listRefreshCandidates, recordDetection, recordVersionCheck } from '../store.ts'

const USAGE = `usage: refresh-versions [--all | --blocked | --errored] [--concurrency N] [--limit N] [--dry-run] [--verbose]

Re-runs cheap detection over the corpus to refresh nuxt_version data.

  --all           refresh every scanned domain, not just confirmed Nuxt hits
  --blocked       refresh only domains whose last scan was blocked
  --errored       refresh only domains whose last scan errored (combinable with --blocked)
  --concurrency   parallel detections (default 8)
  --limit         stop after N domains (for trial runs)
  --dry-run       detect and report, but write nothing
  --verbose       per-domain logging`

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'all': { type: 'boolean', default: false },
    'blocked': { type: 'boolean', default: false },
    'errored': { type: 'boolean', default: false },
    'concurrency': { type: 'string', default: '8' },
    'limit': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'verbose': { type: 'boolean', short: 'v', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (values.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}
if (values.all && (values.blocked || values.errored)) fail('--all cannot be combined with --blocked/--errored')
if (values.verbose) process.env.VERBOSE = '1'

const concurrency = Number(values.concurrency)
if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency must be a positive integer')
const limit = values.limit ? Number(values.limit) : Infinity
if (values.limit && (!Number.isInteger(limit) || limit < 1)) fail('--limit must be a positive integer')

const candidates = listRefreshCandidates({ nuxtOnly: !values.all, blockedOnly: values.blocked, erroredOnly: values.errored })
  .slice(0, limit === Infinity ? undefined : limit)

log.info(`[refresh] ${candidates.length} domain(s) to check (concurrency=${concurrency}${values['dry-run'] ? ', dry-run' : ''})`)

const counts = { ok: 0, blocked: 0, error: 0, versionChanged: 0, statusChanged: 0 }
const changes: string[] = []

async function refresh(candidate: (typeof candidates)[number]): Promise<void> {
  const { domain } = candidate
  try {
    const outcome = await detectDomain(domain)
    if (!values['dry-run']) {
      recordVersionCheck({
        domain,
        isNuxt: outcome.detection.isNuxt,
        nuxtVersion: outcome.detection.nuxtVersion,
        outcome: outcome.outcome,
        blockSignal: outcome.blockSignal,
      })
    }
    counts[outcome.outcome]++

    if (outcome.outcome !== 'ok') {
      log.warn(`[refresh] ${domain} ${outcome.outcome}${outcome.blockSignal ? ` (${outcome.blockSignal})` : ''}${outcome.error ? `: ${outcome.error}` : ''}; keeping existing row`)
      return
    }

    const wasNuxt = candidate.is_nuxt === 1
    const versionChanged = outcome.detection.nuxtVersion !== candidate.nuxt_version
    const statusChanged = outcome.detection.isNuxt !== wasNuxt
    if (versionChanged) counts.versionChanged++
    if (statusChanged) counts.statusChanged++
    if (versionChanged || statusChanged) {
      const before = wasNuxt ? candidate.nuxt_version ?? 'unknown' : 'not-nuxt'
      const after = outcome.detection.isNuxt ? outcome.detection.nuxtVersion ?? 'unknown' : 'not-nuxt'
      changes.push(`${domain}: ${before} -> ${after}`)
      log.info(`[refresh] ${domain}: ${before} -> ${after}`)
    }
    else {
      log.debug(`[refresh] ${domain} unchanged (${candidate.nuxt_version ?? 'not-nuxt'})`)
    }

    if (!values['dry-run']) {
      recordDetection({
        domain: outcome.domain,
        isNuxt: outcome.detection.isNuxt,
        nuxtVersion: outcome.detection.nuxtVersion,
        confidence: outcome.detection.confidence,
        signals: JSON.stringify(outcome.detection.signals),
        finalUrl: outcome.finalUrl,
        title: outcome.title,
        ogImage: outcome.ogImage,
        redirectedTo: outcome.redirectedTo,
        error: outcome.error,
        outcome: outcome.outcome,
        blockSignal: outcome.blockSignal,
        httpStatus: outcome.httpStatus,
      })
    }
  }
  catch (err) {
    counts.error++
    log.error(`[refresh] ${domain} failed: ${(err as Error).message}`)
  }
}

const queue = [...candidates]
let done = 0
async function worker(): Promise<void> {
  for (let next = queue.shift(); next; next = queue.shift()) {
    await refresh(next)
    done++
    if (done % 100 === 0) log.info(`[refresh] progress: ${done}/${candidates.length}`)
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))

process.stdout.write(`${JSON.stringify({
  checked: candidates.length,
  ...counts,
  changes,
}, null, 2)}\n`)

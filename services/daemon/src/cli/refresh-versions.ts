#!/usr/bin/env node
/**
 * Corpus-wide Nuxt version refresh. Detection only: 1-3 plain HTTP requests per domain
 * (HTML fetch, endpoint probes, entry-chunk grep), no Chromium, no screenshots, no
 * notifications. Designed to be invoked over `fly ssh console` like the rescan CLI;
 * shares the daemon's SQLite database WAL-safely.
 *
 * Every attempt is appended to `version_checks` (including blocked and errored ones) so
 * adoption is chartable over time. Writes to `scans` are deliberately conservative,
 * because a sweep that trusts a single observation degrades the corpus:
 *   - only `outcome = 'ok'` results are persisted at all;
 *   - a version that couldn't be re-detected keeps its previous value (absence of
 *     evidence: chunk fetches time out and version sniffing is best-effort);
 *   - a confirmed hit that now reads as non-Nuxt is reported but not written unless
 *     --allow-downgrade, since a soft wall looks identical to a genuine migration.
 */
import { parseArgs } from 'node:util'
import { log } from '../log.ts'
import { detectDomain } from '../scan/index.ts'
import { lastVersionCheck, listRefreshCandidates, recordDetection, recordVersionCheck } from '../store.ts'
import { mergeDetection } from '../detection-state.ts'

const USAGE = `usage: refresh-versions [--all | --blocked | --errored] [--concurrency N] [--limit N] [--dry-run] [--verbose]

Re-runs cheap detection over the corpus to refresh nuxt_version data.

  --all           refresh every scanned domain, not just confirmed Nuxt hits
  --blocked       refresh only domains whose last scan was blocked
  --errored       refresh only domains whose last scan errored (combinable with --blocked)
  --concurrency   parallel detections (default 8)
  --limit         stop after N domains (for trial runs)
  --allow-downgrade  persist hits that now look non-Nuxt (default: report only)
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
    'allow-downgrade': { type: 'boolean', default: false },
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

const counts = { ok: 0, blocked: 0, error: 0, versionChanged: 0, statusChanged: 0, versionHeld: 0, downgradeHeld: 0 }
const changes: string[] = []
/** Confirmed hits that came back non-Nuxt. Not written unless --allow-downgrade; worth
 *  eyeballing since a soft wall and a genuine migration off Nuxt look identical here. */
const downgrades: string[] = []

async function refresh(candidate: (typeof candidates)[number]): Promise<void> {
  const { domain } = candidate
  try {
    const wasNuxt = candidate.is_nuxt === 1
    const previousCheck = lastVersionCheck(domain)
    const outcome = await detectDomain(domain, { deepVersionScan: wasNuxt && !!candidate.nuxt_version })
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

    const corroborated = previousCheck?.outcome === 'ok' && previousCheck.is_nuxt === 0
    const merged = mergeDetection(candidate, outcome, {
      allowDowngrade: values['allow-downgrade'] || corroborated,
    })

    if (wasNuxt && !outcome.detection.isNuxt) {
      const note = `${domain}: was ${candidate.nuxt_version ?? 'nuxt (version unknown)'}, now reads as not-nuxt`
      downgrades.push(note)
      if (merged.heldDowngrade) {
        counts.downgradeHeld++
        log.warn(`[refresh] ${note}; holding (pass --allow-downgrade to persist)`)
        return
      }
      counts.statusChanged++
      log.info(`[refresh] ${note}; persisting${corroborated ? ' (corroborated by a previous check)' : ''}`)
    }

    const nextVersion = merged.nuxtVersion
    if (merged.heldVersion) {
      counts.versionHeld++
      log.debug(`[refresh] ${domain} version not re-detected; keeping ${candidate.nuxt_version}`)
    }

    const versionChanged = nextVersion !== candidate.nuxt_version
    if (versionChanged) {
      counts.versionChanged++
      const before = candidate.nuxt_version ?? 'unknown'
      const after = nextVersion ?? 'unknown'
      changes.push(`${domain}: ${before} -> ${after}`)
      log.info(`[refresh] ${domain}: ${before} -> ${after}`)
    }
    else {
      log.debug(`[refresh] ${domain} unchanged (${candidate.nuxt_version ?? 'not-nuxt'})`)
    }

    if (!values['dry-run']) {
      recordDetection({
        domain: outcome.domain,
        isNuxt: merged.isNuxt,
        nuxtVersion: nextVersion,
        confidence: merged.confidence,
        signals: merged.signals,
        finalUrl: outcome.finalUrl,
        title: outcome.title,
        ogImage: outcome.ogImage,
        redirectedTo: outcome.redirectedTo,
        error: outcome.error,
        outcome: outcome.outcome,
        blockSignal: outcome.blockSignal,
        httpStatus: outcome.httpStatus,
        hostingPlatform: outcome.hostingPlatform,
        hostingCdn: outcome.hostingCdn,
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
  downgrades,
}, null, 2)}\n`)

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { log } from './log.ts'
import { startJetstream } from './jetstream.ts'
import { extractUrls } from './extract.ts'
import { canonicalDomain, normaliseUrl, shouldSkipDomain } from './domains.ts'

function runIngestScript(scriptName: string, label: string): Promise<void> {
  const script = fileURLToPath(new URL(`../scripts/${scriptName}`, import.meta.url))
  return new Promise((resolve) => {
    const child = spawn('node', [script], {
      env: { ...process.env, DATA_DIR: config.dataDir },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('exit', () => resolve())
    child.on('error', (err) => { log.warn(`[${label}] script failed to spawn`, (err as Error).message); resolve() })
  })
}
import { Queue } from './queue.ts'
import {
  getScan,
  hasNotified,
  recordDomainSeen,
  recordNotification,
  recordScan,
} from './store.ts'
import { scanDomain, type ScanOutcome } from './scan/index.ts'
import { closeBrowser } from './scan/headless.ts'
import { notifyDiscord } from './notify/discord.ts'
import { notifyBluesky } from './notify/bluesky.ts'

async function dispatchNotifications(outcome: ScanOutcome): Promise<void> {
  const channels: Array<{ name: string, post: (o: ScanOutcome) => Promise<boolean> }> = [
    { name: 'discord', post: notifyDiscord },
    { name: 'bluesky', post: notifyBluesky },
  ]
  for (const { name, post } of channels) {
    if (hasNotified(outcome.domain, name)) continue
    try {
      const posted = await post(outcome)
      if (posted) {
        recordNotification(outcome.domain, name)
        log.success(`[${name}] posted ${outcome.domain}`)
      }
    } catch (err) {
      log.error(`[${name}] failed to post ${outcome.domain}:`, (err as Error).message)
    }
  }
}

interface ScanJob {
  domain: string
}

const queue = new Queue<ScanJob>(
  {
    concurrency: config.scanConcurrency,
    worker: handleScan,
    onError: (job, err) => log.error(`[scan] ${job.domain} failed`, err),
  },
  job => job.domain,
)

let postsSeen = 0
let urlsSeen = 0
let domainsQueued = 0
let nuxtFound = 0

async function handleScan({ domain }: ScanJob): Promise<void> {
  try {
    const existing = getScan(domain)
    if (existing && Date.now() - existing.scanned_at < config.rescanAfterMs) {
      log.debug(`[scan] ${domain} recently scanned, skipping`)
      return
    }

    const outcome = await scanDomain(domain)
    persistOutcome(outcome)

    if (outcome.redirectedTo && outcome.redirectedTo !== domain) {
      log.info(`[scan] ${domain} redirects to ${outcome.redirectedTo}; queuing destination`)
      if (!shouldSkipDomain(outcome.redirectedTo) && queue.enqueue({ domain: outcome.redirectedTo })) {
        domainsQueued++
      }
    }
    else if (outcome.detection.isNuxt) {
      nuxtFound++
      log.success(`[scan] ${domain} is Nuxt (confidence=${outcome.detection.confidence}, version=${outcome.detection.nuxtVersion ?? 'unknown'})`)
      await dispatchNotifications(outcome)
    } else if (outcome.error) {
      log.debug(`[scan] ${domain} error: ${outcome.error}`)
    } else {
      log.debug(`[scan] ${domain} not Nuxt`)
    }
  } finally {
    // The persistent scan record gates re-work; safe to let the queue forget this key.
    queue.forget({ domain })
  }
}

function persistOutcome(outcome: ScanOutcome): void {
  recordScan({
    domain: outcome.domain,
    is_nuxt: outcome.detection.isNuxt ? 1 : 0,
    nuxt_version: outcome.detection.nuxtVersion,
    confidence: outcome.detection.confidence,
    signals: JSON.stringify(outcome.detection.signals),
    final_url: outcome.finalUrl,
    title: outcome.title,
    screenshot_path: outcome.screenshotPath,
    og_image: outcome.ogImage,
    redirected_to: outcome.redirectedTo,
    error: outcome.error,
  })
}

const controller = new AbortController()

startJetstream({
  signal: controller.signal,
  onEvent: (event) => {
    const record = event.commit?.record
    if (!record) return
    postsSeen++
    const urls = extractUrls(record)
    if (urls.length === 0) return
    urlsSeen += urls.length

    const domainsInPost = new Set<string>()
    for (const raw of urls) {
      const normalised = normaliseUrl(raw)
      if (!normalised) continue
      if (shouldSkipDomain(normalised.hostname) || shouldSkipDomain(normalised.registrable)) continue
      domainsInPost.add(canonicalDomain(normalised.hostname))
    }

    for (const domain of domainsInPost) {
      recordDomainSeen(domain)
      const existing = getScan(domain)
      if (existing && Date.now() - existing.scanned_at < config.rescanAfterMs) continue
      if (queue.enqueue({ domain })) {
        domainsQueued++
        log.debug(`[queue] +${domain} (size=${queue.size + queue.active})`)
      }
    }
  },
})

const statsInterval = setInterval(() => {
  log.info(`[stats] posts=${postsSeen} urls=${urlsSeen} queued=${domainsQueued} active=${queue.active} pending=${queue.size} nuxt=${nuxtFound}`)
}, 30_000)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`[shutdown] caught ${signal}; closing jetstream and draining queue`)
  clearInterval(statsInterval)
  controller.abort()

  const drainTimeoutMs = Number(process.env.SHUTDOWN_DRAIN_MS || 25_000)
  const result = await queue.drainAndClose(drainTimeoutMs)
  if (result.drained) {
    log.info(`[shutdown] drained (dropped ${result.droppedPending} pending)`)
  } else {
    log.warn(`[shutdown] drain timed out after ${drainTimeoutMs}ms; ${queue.active} scans were still in flight`)
  }
  await closeBrowser()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => log.error('[unhandledRejection]', err))

// Refresh Tranco popularity ranks on boot and every 24h. The ingest script is idempotent
// and cheap (~10MB download + a single transactional INSERT pass). Failing to refresh is
// non-fatal; we just keep the previous day's ranks in the table.
// Tranco ranks + npm-published Nuxt versions on boot and every 24h. Failure is non-fatal;
// the previous day's data remains in the tables.
const DAILY_MS = 24 * 60 * 60 * 1000
async function refreshDailyData(): Promise<void> {
  await Promise.all([
    runIngestScript('ingest-tranco.mjs', 'tranco'),
    runIngestScript('ingest-nuxt-versions.mjs', 'nuxt-versions'),
  ])
}
void refreshDailyData()
setInterval(() => void refreshDailyData(), DAILY_MS)

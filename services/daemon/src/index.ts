import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { log } from './log.ts'
import { startJetstream } from './jetstream.ts'
import { extractUrls } from './extract.ts'
import { canonicalDomain, normaliseUrl, shouldSkipDomain } from './domains.ts'
import { Queue } from './queue.ts'
import { getScan, recordCapture, recordDetection, recordDomainSeen } from './store.ts'
import { captureForDomain, detectDomain, type DetectionOutcome } from './scan/index.ts'
import { dispatchNotifications } from './pipeline.ts'
import { type CaptureJob, loadQueueState, saveQueueState } from './queue-state.ts'

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

interface DetectionJob {
  domain: string
}

const detectionQueue = new Queue<DetectionJob>(
  {
    concurrency: config.detectionConcurrency,
    worker: handleDetection,
    onError: (job, err) => log.error(`[detect] ${job.domain} failed`, err),
  },
  job => job.domain,
)

const captureQueue = new Queue<CaptureJob>(
  {
    concurrency: config.captureConcurrency,
    worker: handleCapture,
    onError: (job, err) => log.error(`[capture] ${job.domain} failed`, err),
  },
  job => job.domain,
)

let postsSeen = 0
let urlsSeen = 0
let domainsEnqueued = 0
let nuxtFound = 0

/**
 * Detection worker: runs the cheap detection pipeline, persists the result, and (on a
 * confirmed Nuxt hit) enqueues a capture job so the image work happens on the separate
 * capture pool. Redirects to a different registrable domain re-enqueue the destination
 * for detection.
 */
async function handleDetection({ domain }: DetectionJob): Promise<void> {
  try {
    const existing = getScan(domain)
    if (existing && Date.now() - existing.scanned_at < config.rescanAfterMs) {
      log.debug(`[detect] ${domain} recently scanned, skipping`)
      return
    }

    const outcome = await detectDomain(domain)
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
    })

    if (outcome.redirectedTo && outcome.redirectedTo !== domain) {
      log.info(`[detect] ${domain} redirects to ${outcome.redirectedTo}; queuing destination`)
      if (!shouldSkipDomain(outcome.redirectedTo) && detectionQueue.enqueue({ domain: outcome.redirectedTo })) {
        domainsEnqueued++
      }
      return
    }

    if (outcome.detection.isNuxt && outcome.finalUrl) {
      nuxtFound++
      log.success(`[detect] ${domain} is Nuxt (confidence=${outcome.detection.confidence}, version=${outcome.detection.nuxtVersion ?? 'unknown'})`)
      captureQueue.enqueue({
        domain: outcome.domain,
        finalUrl: outcome.finalUrl,
        candidateOgImage: outcome.ogImage,
      })
    }
    else if (outcome.error) {
      log.debug(`[detect] ${domain} error: ${outcome.error}`)
    }
    else {
      log.debug(`[detect] ${domain} not Nuxt`)
    }
  }
  finally {
    // The persistent scan record gates re-work; safe to let the queue forget this key.
    detectionQueue.forget({ domain })
  }
}

/**
 * Capture worker: validates og:image, calls the scanner for the screenshot + NSFW
 * classification, uploads og:image to ImageKit, persists the resulting columns, and
 * dispatches notifications. Notifications wait until after capture because Bluesky +
 * Discord embeds want a thumbnail and the rate-limit gate absorbs the latency anyway.
 */
async function handleCapture(job: CaptureJob): Promise<void> {
  try {
    const captured = await captureForDomain(job.domain, job.finalUrl, job.candidateOgImage)
    recordCapture({
      domain: job.domain,
      ogImage: captured.ogImage,
      screenshotKey: captured.screenshotKey,
      ogImageKey: captured.ogImageKey,
      nsfwLabel: captured.nsfwLabel,
      nsfwScore: captured.nsfwScore,
      nsfwCategories: captured.nsfwCategories,
      nsfwClassifiedAt: captured.nsfwClassifiedAt,
      error: captured.error,
    })

    // Notifications need the full scan outcome shape; reconstruct from the persisted
    // detection row + the fresh capture result so the embed has both halves.
    const stored = getScan(job.domain)
    if (!stored || !stored.is_nuxt) return
    await dispatchNotifications({
      domain: job.domain,
      detection: {
        isNuxt: true,
        confidence: stored.confidence,
        nuxtVersion: stored.nuxt_version,
        signals: parseSignals(stored.signals),
      },
      finalUrl: stored.final_url,
      title: stored.title,
      description: null,
      ogImage: captured.ogImage,
      screenshotKey: captured.screenshotKey,
      ogImageKey: captured.ogImageKey,
      nsfwLabel: captured.nsfwLabel,
      nsfwScore: captured.nsfwScore,
      nsfwCategories: captured.nsfwCategories,
      nsfwClassifiedAt: captured.nsfwClassifiedAt,
      redirectedTo: stored.redirected_to,
      error: captured.error ?? stored.error,
    })
  }
  finally {
    captureQueue.forget(job)
  }
}

function parseSignals(raw: string): Array<{ name: string, weight: number, detail?: string }> {
  try { return JSON.parse(raw) as Array<{ name: string, weight: number, detail?: string }> }
  catch { return [] }
}

/**
 * Restore pending work from the previous shutdown's snapshot file (if any). Runs before
 * Jetstream so we don't race new domains against the saved set; idempotent against\n * concurrent jetstream events too because `Queue.enqueue` dedupes by key. Capture jobs\n * land directly on the capture queue (they already passed detection last time round).\n */
function restoreQueues(): void {
  const state = loadQueueState()
  if (!state) return
  let det = 0
  let cap = 0
  for (const domain of state.detection) {
    if (!shouldSkipDomain(domain) && detectionQueue.enqueue({ domain })) det++
  }
  for (const job of state.capture) {
    if (!shouldSkipDomain(job.domain) && captureQueue.enqueue(job)) cap++
  }
  log.info(`[queue-state] restored ${det} detection + ${cap} capture jobs from disk`)
}

const controller = new AbortController()

restoreQueues()

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
      if (detectionQueue.enqueue({ domain })) {
        domainsEnqueued++
        log.debug(`[queue] +${domain} (detect=${detectionQueue.size + detectionQueue.active})`)
      }
    }
  },
})

const statsInterval = setInterval(() => {
  log.info(`[stats] posts=${postsSeen} urls=${urlsSeen} enqueued=${domainsEnqueued} detect=${detectionQueue.active}+${detectionQueue.size} capture=${captureQueue.active}+${captureQueue.size} nuxt=${nuxtFound}`)
}, 30_000)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`[shutdown] caught ${signal}; closing jetstream and draining queues`)
  clearInterval(statsInterval)
  controller.abort()

  // Snapshot pending work before drain so a fast Fly deploy can pick it back up next
  // boot. In-flight jobs aren't saved here; they get the drain timeout to finish, and
  // any that hit the timeout are simply lost (consistent with pre-split behaviour).
  saveQueueState({
    detection: detectionQueue.snapshotPending().map(j => j.domain),
    capture: captureQueue.snapshotPending(),
  })

  const drainTimeoutMs = Number(process.env.SHUTDOWN_DRAIN_MS || 25_000)
  const [detResult, capResult] = await Promise.all([
    detectionQueue.drainAndClose(drainTimeoutMs),
    captureQueue.drainAndClose(drainTimeoutMs),
  ])
  if (detResult.drained && capResult.drained) {
    log.info(`[shutdown] drained (saved+dropped detect=${detResult.droppedPending} capture=${capResult.droppedPending})`)
  }
  else {
    log.warn(`[shutdown] drain timed out after ${drainTimeoutMs}ms; detect.active=${detectionQueue.active} capture.active=${captureQueue.active}`)
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => log.error('[unhandledRejection]', err))

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

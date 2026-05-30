import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { log } from './log.ts'
import { startJetstream } from './jetstream.ts'
import { extractTrigger, extractUrls } from './extract.ts'
import { canonicalDomain, normaliseUrl, shouldSkipDomain } from './domains.ts'
import { Queue } from './queue.ts'
import {
  getScan,
  hasReplied,
  markReplySent,
  pendingRepliesForDomain,
  recordCapture,
  recordDetection,
  recordDomainSeen,
  recordReplyRequest,
} from './store.ts'
import { startSubmitServer } from './submit-server.ts'
import { captureForDomain, detectDomain, type DetectionOutcome } from './scan/index.ts'
import { dispatchNotifications } from './pipeline.ts'
import { type CaptureJob, loadQueueState, saveQueueState } from './queue-state.ts'
import { getSelfDid } from './notify/bluesky-client.ts'
import { replyWithScan, targetFromRow, type ReplyTarget } from './notify/bluesky-reply.ts'

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
let triggerPostsSeen = 0
let repliesPosted = 0

let selfDid: string | null = null

/**
 * Maximum age of a stored scan that we'll serve directly to a user-requested reply.
 * Older rows get a forced rescan: the requester explicitly asked, so a stale answer is
 * worse than a small delay. Capped tighter than `RESCAN_AFTER_MS` (which targets the
 * firehose path where bulk re-coverage is the goal).
 */
const REPLY_FRESHNESS_MS = Number(process.env.REPLY_FRESHNESS_MS || 24 * 60 * 60 * 1000)

/**
 * Flush every pending reply for `domain` using the row's current scan state. Called from
 * both queue workers (detection-end for non-Nuxt / errored rows, capture-end for Nuxt
 * rows) so a request that arrived while the scan was in flight gets a reply as soon as
 * the result lands. Failures leave the row pending; a later flush will retry it.
 */
async function flushPendingReplies(domain: string): Promise<void> {
  const pending = pendingRepliesForDomain(domain)
  if (pending.length === 0) return
  const scan = getScan(domain) ?? null
  for (const row of pending) {
    const target = targetFromRow(row)
    try {
      const ok = await replyWithScan(target, domain, scan)
      if (ok) {
        markReplySent(row.post_uri, domain)
        repliesPosted++
        log.success(`[bluesky-reply] replied to ${row.post_uri} for ${domain}`)
      }
    }
    catch (err) {
      log.error(`[bluesky-reply] flush failed for ${domain} -> ${row.post_uri}:`, (err as Error).message)
    }
  }
}

/**
 * Try to satisfy a trigger immediately from the current scan row. Returns true iff the
 * row is fresh enough to serve and we either posted a reply or recorded that one was
 * already sent. On false, the caller should record a pending reply and enqueue a scan.
 */
async function tryImmediateReply(target: ReplyTarget, domain: string, authorDid: string): Promise<boolean> {
  const scan = getScan(domain)
  if (!scan) return false
  if (Date.now() - scan.scanned_at > REPLY_FRESHNESS_MS) return false
  if (hasReplied(target.postUri, domain)) return true
  const ok = await replyWithScan(target, domain, scan)
  if (!ok) return false
  recordReplyRequest({
    postUri: target.postUri,
    postCid: target.postCid,
    rootUri: target.rootUri,
    rootCid: target.rootCid,
    authorDid,
    domain,
  })
  markReplySent(target.postUri, domain)
  repliesPosted++
  log.success(`[bluesky-reply] replied to ${target.postUri} for ${domain} (cached scan)`)
  return true
}

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
      // Capture worker will flush pending replies once the screenshot lands.
    }
    else if (outcome.error) {
      log.debug(`[detect] ${domain} error: ${outcome.error}`)
      await flushPendingReplies(domain)
    }
    else {
      log.debug(`[detect] ${domain} not Nuxt`)
      await flushPendingReplies(domain)
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

    // Pending user-requested replies fire as soon as the screenshot lands, before the
    // firehose-notify dispatch. They use the row's current state so this works whether
    // the request arrived before or during the capture.
    await flushPendingReplies(job.domain)

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

const submitServer = startSubmitServer({
  enqueueDetection: (domain) => {
    const accepted = detectionQueue.enqueue({ domain })
    if (accepted) {
      domainsEnqueued++
      log.info(`[submit] +${domain} (detect=${detectionQueue.size + detectionQueue.active})`)
    }
    return accepted
  },
  getScan,
  recordDomainSeen,
})

/**
 * Canonical, skip-filtered, deduped domain list extracted from a Bluesky post's URLs.
 * Shared between the firehose path (enqueue everything new) and the trigger path
 * (target list for user-requested replies) so both apply the same filters.
 */
function domainsFromUrls(urls: string[]): Set<string> {
  const out = new Set<string>()
  for (const raw of urls) {
    const normalised = normaliseUrl(raw)
    if (!normalised) continue
    if (shouldSkipDomain(normalised.hostname) || shouldSkipDomain(normalised.registrable)) continue
    out.add(canonicalDomain(normalised.hostname))
  }
  return out
}

startJetstream({
  signal: controller.signal,
  onEvent: (event) => {
    const record = event.commit?.record
    if (!record) return
    postsSeen++
    const urls = extractUrls(record)
    if (urls.length === 0) return
    urlsSeen += urls.length

    const domainsInPost = domainsFromUrls(urls)

    for (const domain of domainsInPost) {
      recordDomainSeen(domain)
      const existing = getScan(domain)
      if (existing && Date.now() - existing.scanned_at < config.rescanAfterMs) continue
      if (detectionQueue.enqueue({ domain })) {
        domainsEnqueued++
        log.debug(`[queue] +${domain} (detect=${detectionQueue.size + detectionQueue.active})`)
      }
    }

    // User-requested replies: posts that @-mention our bot account get a per-domain reply
    // built from the scan result. selfDid is resolved asynchronously at boot; until it's
    // set this branch is a no-op (same as if Bluesky credentials weren't configured).
    const trigger = extractTrigger(event, selfDid)
    if (!trigger) return
    const targetDomains = domainsFromUrls(trigger.urls)
    // Don't reply about nuxt.fyi itself if the user happens to drop a link to it alongside
    // the @-mention; that's almost certainly the mention's own profile/handle URL.
    targetDomains.delete('nuxt.fyi')
    if (targetDomains.size === 0) return
    triggerPostsSeen++
    log.info(`[trigger] ${trigger.post.uri} -> [${[...targetDomains].join(', ')}]`)
    for (const domain of targetDomains) {
      void handleTrigger(trigger.post, domain)
    }
  },
})

/**
 * Dispatch the reply path for a single `(post, domain)` pair: try to serve from the
 * cached scan if it's recent enough, otherwise record the request and enqueue a scan so
 * the worker can flush it on completion.
 */
async function handleTrigger(
  post: { uri: string, cid: string, rootUri: string, rootCid: string, authorDid: string },
  domain: string,
): Promise<void> {
  const target: ReplyTarget = {
    postUri: post.uri,
    postCid: post.cid,
    rootUri: post.rootUri,
    rootCid: post.rootCid,
  }
  if (hasReplied(post.uri, domain)) return
  try {
    if (await tryImmediateReply(target, domain, post.authorDid)) return
  }
  catch (err) {
    log.error(`[trigger] immediate reply failed for ${domain}:`, (err as Error).message)
  }
  recordReplyRequest({
    postUri: post.uri,
    postCid: post.cid,
    rootUri: post.rootUri,
    rootCid: post.rootCid,
    authorDid: post.authorDid,
    domain,
  })
  if (!shouldSkipDomain(domain) && detectionQueue.enqueue({ domain })) {
    domainsEnqueued++
    log.debug(`[trigger] enqueued ${domain} for ${post.uri}`)
  }
}

const statsInterval = setInterval(() => {
  log.info(`[stats] posts=${postsSeen} urls=${urlsSeen} enqueued=${domainsEnqueued} detect=${detectionQueue.active}+${detectionQueue.size} capture=${captureQueue.active}+${captureQueue.size} nuxt=${nuxtFound} triggers=${triggerPostsSeen} replies=${repliesPosted}`)
}, 30_000)

// Resolve the bot's own DID once at boot. Until this promise lands `extractTrigger`
// short-circuits, so trigger handling is effectively a no-op for the first few seconds
// of a process; that's preferable to issuing a synchronous network call from `onEvent`.
void (async () => {
  try {
    selfDid = await getSelfDid()
    if (selfDid) log.info(`[bluesky] self DID resolved: ${selfDid}`)
    else log.warn('[bluesky] could not resolve self DID; @-mention replies disabled')
  }
  catch (err) {
    log.warn(`[bluesky] self-DID resolution failed: ${(err as Error).message}`)
  }
})()

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`[shutdown] caught ${signal}; closing jetstream and draining queues`)
  clearInterval(statsInterval)
  controller.abort()
  if (submitServer) submitServer.close()

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

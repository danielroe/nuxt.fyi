import { log } from '../log.ts'
import { scanHtml } from './html.ts'
import { probeNuxtEndpoints } from './probe.ts'
import { scanReferencedJs } from './js.ts'
import { remoteCapture } from './remote.ts'
import { canonicalDomain } from '../domains.ts'
import { parse as parseHost } from 'tldts'
import type { DetectionResult, DetectionSignal } from './detect.ts'
import { uploadOgImage } from '../imagekit.ts'

export interface ScanOutcome {
  domain: string
  detection: DetectionResult
  finalUrl: string | null
  title: string | null
  /** og:description / twitter:description / <meta name="description">, trimmed. */
  description: string | null
  /** og:image URL declared by the site, validated as reachable and image-typed. */
  ogImage: string | null
  /** ImageKit path for the captured screenshot, when upload succeeded. */
  screenshotKey: string | null
  /** ImageKit path for the uploaded copy of the og:image, when both fetch and upload
   *  succeeded. */
  ogImageKey: string | null
  /** NSFW classification of the screenshot, when classification ran. The scanner only
   *  classifies its own screenshot; og:image-only rows stay unclassified (null) on the
   *  steady-state path. The backfill script fills both in retrospectively. */
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
  nsfwScore: number | null
  nsfwCategories: string | null
  nsfwClassifiedAt: number | null
  /** Set when the HTML fetch followed a redirect to a different registrable domain. The
   *  outcome itself doesn't include detection results in that case; the destination should
   *  be scanned independently. */
  redirectedTo: string | null
  error: string | null
}

const OG_IMAGE_HEAD_TIMEOUT_MS = 5_000

/**
 * HEAD-requests the declared og:image to confirm it's reachable and serves an image
 * content-type. We do this once at scan time so the downstream consumers (Discord embed,
 * dashboard <img>) can trust the URL without their own validation. Returns the validated
 * URL on success or null on any failure mode (network error, non-2xx, non-image type).
 */
export async function validateOgImage(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OG_IMAGE_HEAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NuxtFyi/0.1; +https://nuxt.fyi)' },
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') || ''
    if (!/^image\//i.test(type)) return null
    return res.url
  }
  catch { return null }
  finally { clearTimeout(timer) }
}

const CONFIDENCE_THRESHOLD = 5

function registrableHostFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return parseHost(host).domain || null
  }
  catch { return null }
}

function combine(...resultSignals: DetectionSignal[][]): { signals: DetectionSignal[], confidence: number } {
  const seen = new Set<string>()
  const merged: DetectionSignal[] = []
  for (const list of resultSignals) {
    for (const sig of list) {
      if (seen.has(sig.name)) continue
      seen.add(sig.name)
      merged.push(sig)
    }
  }
  return { signals: merged, confidence: merged.reduce((sum, s) => sum + s.weight, 0) }
}

/**
 * Detection-only outcome: HTML + endpoint probes + JS scan. Cheap (just HTTP calls) so
 * the daemon can run this at high concurrency. The image fields are always null at this
 * stage; `captureForDomain` fills them in afterwards if the row is Nuxt.
 */
export interface DetectionOutcome {
  domain: string
  detection: DetectionResult
  finalUrl: string | null
  title: string | null
  description: string | null
  /** og:image origin URL declared by the site. Validated as reachable and image-typed.
   *  The image bytes don't get fetched/uploaded here; `captureForDomain` does that. */
  ogImage: string | null
  redirectedTo: string | null
  error: string | null
}

function emptyDetectionOutcome(domain: string, error: string | null): DetectionOutcome {
  return {
    domain,
    detection: { isNuxt: false, confidence: 0, nuxtVersion: null, signals: [] },
    finalUrl: null,
    title: null,
    description: null,
    ogImage: null,
    redirectedTo: null,
    error,
  }
}

/**
 * Detection half of a scan: HTML fetch + regex, Nuxt-specific endpoint probes, entry-
 * chunk JS grep. Returns enough state for the caller to persist the detection row and
 * decide whether to enqueue capture. No image work happens here.
 */
export async function detectDomain(domain: string): Promise<DetectionOutcome> {
  const url = `https://${domain}/`

  let html: Awaited<ReturnType<typeof scanHtml>>
  try {
    html = await scanHtml(url)
  }
  catch (err) {
    return emptyDetectionOutcome(domain, (err as Error).message)
  }

  // If the fetch followed a redirect to a different registrable domain (e.g. a URL
  // shortener or `.link` alias), short-circuit. The destination is a separate site and
  // should be scanned under its own canonical key, not attributed to the shortener.
  const destination = registrableHostFromUrl(html.finalUrl)
  const sourceRegistrable = parseHost(domain).domain || domain
  if (destination && destination !== sourceRegistrable) {
    log.debug(`[detect] ${domain} redirected to ${destination}; deferring detection to that domain`)
    return {
      domain,
      detection: { isNuxt: false, confidence: 0, nuxtVersion: null, signals: [] },
      finalUrl: html.finalUrl,
      title: html.title,
      description: html.description,
      ogImage: null,
      redirectedTo: canonicalDomain(new URL(html.finalUrl).hostname),
      error: null,
    }
  }
  // (Fall through to the detection pipeline below.)

  log.debug(`[detect] ${domain} html confidence=${html.detection.confidence} signals=${html.detection.signals.map(s => s.name).join(',')}`)

  let nuxtVersion = html.detection.nuxtVersion
  let signals = [...html.detection.signals]

  if (html.detection.confidence < CONFIDENCE_THRESHOLD || !nuxtVersion) {
    const probe = await probeNuxtEndpoints(html.finalUrl)
    if (probe.signals.length > 0) {
      log.debug(`[detect] ${domain} probe hits: ${probe.signals.map(s => s.name).join(', ')}`)
    }
    signals = combine(signals, probe.signals).signals
  }

  let confidence = signals.reduce((sum, s) => sum + s.weight, 0)

  if (confidence < CONFIDENCE_THRESHOLD) {
    const js = await scanReferencedJs(html.html, html.finalUrl)
    if (js.signals.length > 0) {
      log.debug(`[detect] ${domain} js hits (${js.fetched} chunks): ${js.signals.map(s => s.name).join(', ')}`)
    }
    signals = combine(signals, js.signals).signals
    if (!nuxtVersion && js.nuxtVersion) nuxtVersion = js.nuxtVersion
    confidence = signals.reduce((sum, s) => sum + s.weight, 0)
  }

  // Confirmed Nuxt but no version yet: one extra JS fetch to find it. Bounded to the ~2%
  // of scans that pass the threshold.
  if (confidence >= CONFIDENCE_THRESHOLD && !nuxtVersion) {
    const js = await scanReferencedJs(html.html, html.finalUrl, { limit: 1 })
    if (js.nuxtVersion) {
      nuxtVersion = js.nuxtVersion
      log.debug(`[detect] ${domain} version from entry chunk: ${nuxtVersion}`)
    }
  }

  const detection: DetectionResult = {
    isNuxt: confidence >= CONFIDENCE_THRESHOLD,
    confidence,
    nuxtVersion,
    signals,
  }

  return {
    domain,
    detection,
    finalUrl: html.finalUrl,
    title: html.title,
    description: html.description,
    redirectedTo: null,
    ogImage: html.ogImage,
    error: null,
  }
}

/**
 * Image-capture half of a scan. Validates the og:image, calls the scanner for the
 * screenshot + NSFW classification, and uploads the og:image bytes to ImageKit. The
 * caller passes in the detection outcome so this function doesn't need to redo any of
 * the cheap detection work.
 *
 * Returns the image-related fields the caller should persist. All four image fields can
 * be null independently; failure of one doesn't block the others.
 */
export interface CaptureOutcome {
  ogImage: string | null
  screenshotKey: string | null
  ogImageKey: string | null
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
  nsfwScore: number | null
  nsfwCategories: string | null
  nsfwClassifiedAt: number | null
  error: string | null
}

export async function captureForDomain(
  domain: string,
  finalUrl: string,
  candidateOgImage: string | null,
): Promise<CaptureOutcome> {
  let ogImage: string | null = null
  let screenshotKey: string | null = null
  let ogImageKey: string | null = null
  let nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null = null
  let nsfwScore: number | null = null
  let nsfwCategories: string | null = null
  let nsfwClassifiedAt: number | null = null
  let error: string | null = null

  if (candidateOgImage) {
    ogImage = await validateOgImage(candidateOgImage)
    if (ogImage) log.debug(`[capture] ${domain} og:image ok: ${ogImage}`)
    else log.debug(`[capture] ${domain} og:image rejected (${candidateOgImage})`)
  }
  const capture = await remoteCapture(finalUrl, domain)
  if (capture) {
    screenshotKey = capture.imageKey
    if (capture.nsfw) {
      nsfwLabel = capture.nsfw.label
      nsfwScore = capture.nsfw.score
      nsfwCategories = JSON.stringify(capture.nsfw.categories)
      nsfwClassifiedAt = capture.capturedAt
    }
    if (capture.error && !capture.imageKey) {
      error = `screenshot: ${capture.error}`
      log.warn(`[capture] ${domain} scanner reported: ${capture.error}`)
    }
  }
  if (ogImage) {
    const uploaded = await uploadOgImage(domain, ogImage)
    if (uploaded) ogImageKey = uploaded.filePath
  }

  return {
    ogImage,
    screenshotKey,
    ogImageKey,
    nsfwLabel,
    nsfwScore,
    nsfwCategories,
    nsfwClassifiedAt,
    error,
  }
}

/**
 * Convenience wrapper that runs detection then capture in series, returning the unified
 * `ScanOutcome` shape. Used by the rescan CLI and the image-less backfill script, where
 * the caller wants the combined behaviour in a single process. The daemon's main scan
 * pipeline calls `detectDomain` and `captureForDomain` directly so they can run on
 * separate queues.
 */
export async function scanDomain(domain: string): Promise<ScanOutcome> {
  const detected = await detectDomain(domain)
  // No detection work, no capture: short-circuit so the outcome matches what the daemon
  // would have written before the queue split.
  if (!detected.detection.isNuxt || !detected.finalUrl) {
    return {
      ...detected,
      screenshotKey: null,
      ogImageKey: null,
      nsfwLabel: null,
      nsfwScore: null,
      nsfwCategories: null,
      nsfwClassifiedAt: null,
    }
  }
  const captured = await captureForDomain(detected.domain, detected.finalUrl, detected.ogImage)
  return {
    ...detected,
    ogImage: captured.ogImage,
    screenshotKey: captured.screenshotKey,
    ogImageKey: captured.ogImageKey,
    nsfwLabel: captured.nsfwLabel,
    nsfwScore: captured.nsfwScore,
    nsfwCategories: captured.nsfwCategories,
    nsfwClassifiedAt: captured.nsfwClassifiedAt,
    error: detected.error ?? captured.error,
  }
}

export interface RecaptureOutcome {
  ogImage: string | null
  screenshotKey: string | null
  ogImageKey: string | null
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
  nsfwScore: number | null
  nsfwCategories: string | null
  nsfwClassifiedAt: number | null
  finalUrl: string
  title: string | null
  description: string | null
  error: string | null
}

/**
 * Refreshes just the image bits of an existing hit: re-fetches HTML to find the current
 * og:image and recaptures the screenshot, then uploads both to ImageKit. Detection
 * signals, confidence and version are untouched; the caller is expected to be operating
 * on a domain already classified as Nuxt. Returns the new image fields plus the live
 * HTML metadata (title, description) so the caller can decide whether to update those
 * too.
 */
export async function recaptureImage(domain: string): Promise<RecaptureOutcome> {
  const url = `https://${domain}/`
  const html = await scanHtml(url)

  let ogImage: string | null = null
  let screenshotKey: string | null = null
  let ogImageKey: string | null = null
  let nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null = null
  let nsfwScore: number | null = null
  let nsfwCategories: string | null = null
  let nsfwClassifiedAt: number | null = null
  let error: string | null = null

  if (html.ogImage) {
    ogImage = await validateOgImage(html.ogImage)
    if (ogImage) log.debug(`[recapture] ${domain} og:image ok: ${ogImage}`)
    else log.debug(`[recapture] ${domain} og:image rejected (${html.ogImage})`)
  }
  const capture = await remoteCapture(html.finalUrl, domain)
  if (capture) {
    screenshotKey = capture.imageKey
    if (capture.nsfw) {
      nsfwLabel = capture.nsfw.label
      nsfwScore = capture.nsfw.score
      nsfwCategories = JSON.stringify(capture.nsfw.categories)
      nsfwClassifiedAt = capture.capturedAt
    }
    if (capture.error && !capture.imageKey) {
      error = `screenshot: ${capture.error}`
      log.warn(`[recapture] ${domain} scanner reported: ${capture.error}`)
    }
  }
  if (ogImage) {
    const uploaded = await uploadOgImage(domain, ogImage)
    if (uploaded) ogImageKey = uploaded.filePath
  }

  return {
    ogImage,
    screenshotKey,
    ogImageKey,
    nsfwLabel,
    nsfwScore,
    nsfwCategories,
    nsfwClassifiedAt,
    finalUrl: html.finalUrl,
    title: html.title,
    description: html.description,
    error,
  }
}

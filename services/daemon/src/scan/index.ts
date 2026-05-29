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
 * Scans `domain` for Nuxt via a four-stage pipeline ordered cheapest first: HTML fetch +
 * regex, Nuxt-specific endpoint probes, entry-chunk JS grep, and finally a Playwright
 * screenshot reserved for confirmed hits.
 */
export async function scanDomain(domain: string): Promise<ScanOutcome> {
  const url = `https://${domain}/`

  let html: Awaited<ReturnType<typeof scanHtml>>
  try {
    html = await scanHtml(url)
  }
  catch (err) {
    return {
      domain,
      detection: { isNuxt: false, confidence: 0, nuxtVersion: null, signals: [] },
      finalUrl: null,
      title: null,
      description: null,
      ogImage: null,
      screenshotKey: null,
      ogImageKey: null,
      nsfwLabel: null,
      nsfwScore: null,
      nsfwCategories: null,
      nsfwClassifiedAt: null,
      redirectedTo: null,
      error: (err as Error).message,
    }
  }

  // If the fetch followed a redirect to a different registrable domain (e.g. a URL
  // shortener or `.link` alias), short-circuit. The destination is a separate site and
  // should be scanned under its own canonical key, not attributed to the shortener.
  const destination = registrableHostFromUrl(html.finalUrl)
  const sourceRegistrable = parseHost(domain).domain || domain
  if (destination && destination !== sourceRegistrable) {
    log.debug(`[scan] ${domain} redirected to ${destination}; deferring detection to that domain`)
    return {
      domain,
      detection: { isNuxt: false, confidence: 0, nuxtVersion: null, signals: [] },
      finalUrl: html.finalUrl,
      title: html.title,
      description: html.description,
      ogImage: null,
      screenshotKey: null,
      ogImageKey: null,
      nsfwLabel: null,
      nsfwScore: null,
      nsfwCategories: null,
      nsfwClassifiedAt: null,
      redirectedTo: canonicalDomain(new URL(html.finalUrl).hostname),
      error: null,
    }
  }

  log.debug(`[scan] ${domain} html confidence=${html.detection.confidence} signals=${html.detection.signals.map(s => s.name).join(',')}`)

  let nuxtVersion = html.detection.nuxtVersion
  let signals = [...html.detection.signals]

  if (html.detection.confidence < CONFIDENCE_THRESHOLD || !nuxtVersion) {
    const probe = await probeNuxtEndpoints(html.finalUrl)
    if (probe.signals.length > 0) {
      log.debug(`[scan] ${domain} probe hits: ${probe.signals.map(s => s.name).join(', ')}`)
    }
    signals = combine(signals, probe.signals).signals
  }

  let confidence = signals.reduce((sum, s) => sum + s.weight, 0)

  if (confidence < CONFIDENCE_THRESHOLD) {
    const js = await scanReferencedJs(html.html, html.finalUrl)
    if (js.signals.length > 0) {
      log.debug(`[scan] ${domain} js hits (${js.fetched} chunks): ${js.signals.map(s => s.name).join(', ')}`)
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
      log.debug(`[scan] ${domain} version from entry chunk: ${nuxtVersion}`)
    }
  }

  const detection: DetectionResult = {
    isNuxt: confidence >= CONFIDENCE_THRESHOLD,
    confidence,
    nuxtVersion,
    signals,
  }

  let ogImage: string | null = null
  let screenshotKey: string | null = null
  let ogImageKey: string | null = null
  let nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null = null
  let nsfwScore: number | null = null
  let nsfwCategories: string | null = null
  let nsfwClassifiedAt: number | null = null
  let screenshotError: string | null = null
  if (detection.isNuxt) {
    // Both sources are captured and uploaded independently so the dashboard can offer a
    // toggle between them. The screenshot is delegated to the scanner service (which
    // owns Playwright + nsfwjs classification + the screenshot half of the ImageKit
    // upload); the og:image is fetched and uploaded directly from here. Either failing
    // is non-fatal.
    if (html.ogImage) {
      ogImage = await validateOgImage(html.ogImage)
      if (ogImage) log.debug(`[scan] ${domain} og:image ok: ${ogImage}`)
      else log.debug(`[scan] ${domain} og:image rejected (${html.ogImage})`)
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
        screenshotError = `screenshot: ${capture.error}`
        log.warn(`[scan] ${domain} scanner reported: ${capture.error}`)
      }
    }
    if (ogImage) {
      const uploaded = await uploadOgImage(domain, ogImage)
      if (uploaded) ogImageKey = uploaded.filePath
    }
  }

  return {
    domain,
    detection,
    finalUrl: html.finalUrl,
    title: html.title,
    description: html.description,
    redirectedTo: null,
    ogImage,
    screenshotKey,
    ogImageKey,
    nsfwLabel,
    nsfwScore,
    nsfwCategories,
    nsfwClassifiedAt,
    error: screenshotError,
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

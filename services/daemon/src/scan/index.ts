import { log } from '../log.ts'
import { scanHtml } from './html.ts'
import { probeNuxtEndpoints } from './probe.ts'
import { scanReferencedJs } from './js.ts'
import { screenshot } from './headless.ts'
import { canonicalDomain } from '../domains.ts'
import { parse as parseHost } from 'tldts'
import type { DetectionResult, DetectionSignal } from './detect.ts'

export interface ScanOutcome {
  domain: string
  detection: DetectionResult
  finalUrl: string | null
  title: string | null
  /** og:description / twitter:description / <meta name="description">, trimmed. */
  description: string | null
  screenshotPath: string | null
  /** og:image URL declared by the site, validated as reachable and image-typed. */
  ogImage: string | null
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
async function validateOgImage(url: string): Promise<string | null> {
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
      screenshotPath: null,
      ogImage: null,
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
      screenshotPath: null,
      ogImage: null,
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
  let screenshotPath: string | null = null
  let screenshotError: string | null = null
  if (detection.isNuxt) {
    // Prefer the site's own og:image when available and reachable: it's higher quality
    // than our 1280x800 screenshot, hosted on the site's CDN, and avoids the cost of a
    // headless capture. We still take a screenshot as a fallback so the dashboard always
    // has something to render even if the og:image goes 404 later.
    if (html.ogImage) {
      ogImage = await validateOgImage(html.ogImage)
      if (ogImage) log.debug(`[scan] ${domain} og:image ok: ${ogImage}`)
      else log.debug(`[scan] ${domain} og:image rejected (${html.ogImage})`)
    }
    if (!ogImage) {
      try {
        screenshotPath = await screenshot(html.finalUrl, domain)
      }
      catch (err) {
        screenshotError = `screenshot: ${(err as Error).message}`
        log.warn(`[scan] ${domain} screenshot failed: ${(err as Error).message}`)
      }
    }
  }

  return {
    domain,
    detection,
    finalUrl: html.finalUrl,
    title: html.title,
    description: html.description,
    redirectedTo: null,
    screenshotPath,
    ogImage,
    error: screenshotError,
  }
}

import { detectFromHtml, type DetectionResult } from './detect.ts'
import { detectBlock, type BlockSignal } from './block.ts'
import { detectHosting, type HostingResult } from './hosting.ts'
import { documentHeaders, type ProfileName } from './fetch-profile.ts'

export interface HtmlScanResult {
  detection: DetectionResult
  finalUrl: string
  title: string | null
  /** og:description or <meta name="description">, trimmed. */
  description: string | null
  /** og:image URL resolved against finalUrl, or null if none / unresolvable. */
  ogImage: string | null
  status: number
  /** Bot-mitigation signal detected in the response, or null for a clean page. */
  blockSignal: BlockSignal | null
  /** Hosting platform + fronting CDN detected from response headers. */
  hosting: HostingResult
  /** Which header profile produced this result. 'browser' means the polite pass was
   *  refused and we retried; downstream subresource fetches should match it. */
  profile: ProfileName
  html: string
}

/**
 * Returns the `content` attribute of the first <meta> tag whose `property` or `name`
 * matches `key` (case-insensitive). Accepts the `content` attribute on either side of
 * the key attribute. Returns null when no match.
 */
function extractMeta(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*\\scontent\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*\\s(?:property|name)\\s*=\\s*["']${k}["']`, 'i'),
  ]
  for (const re of patterns) {
    const m = html.match(re)?.[1]?.trim()
    if (m) return m
  }
  return null
}

function firstMeta(html: string, keys: string[]): string | null {
  for (const k of keys) {
    const v = extractMeta(html, k)
    if (v) return v
  }
  return null
}

/**
 * Resolves a candidate URL against `baseUrl` and returns it only if it's http(s). Data
 * URLs and other schemes would inflate row size or break downstream consumers.
 */
function resolveHttpUrl(raw: string, baseUrl: string): string | null {
  try {
    const u = new URL(raw, baseUrl).toString()
    return /^https?:/i.test(u) ? u : null
  }
  catch { return null }
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_BYTES = 2 * 1024 * 1024

interface RawFetch {
  res: Response
  html: string
}

async function fetchDocument(url: string, profile: ProfileName): Promise<RawFetch> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: documentHeaders(profile),
    })

    const reader = res.body?.getReader()
    let html = ''
    if (reader) {
      const decoder = new TextDecoder()
      let received = 0
      while (received < MAX_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        html += decoder.decode(value, { stream: true })
      }
      try { await reader.cancel() } catch { /* noop */ }
    }
    return { res, html }
  }
  finally {
    clearTimeout(timer)
  }
}

export async function scanHtml(url: string): Promise<HtmlScanResult> {
  let profile: ProfileName = 'polite'
  let { res, html } = await fetchDocument(url, profile)

  // One retry as a browser when the polite pass is refused. If the retry is also
  // blocked we keep its result: the block signal from a browser-shaped request is the
  // more meaningful one to record.
  if (detectBlock(res.status, res.headers, html)) {
    profile = 'browser'
    try {
      ({ res, html } = await fetchDocument(url, profile))
    }
    catch {
      profile = 'polite'
    }
  }

  // og:title is the site's own framing; fall back to <title>. og:description likewise
  // falls back to <meta name="description">. We prefer og:* because those values are
  // explicitly chosen for social embeds.
  const titleTag = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i)?.[1]?.trim() ?? null
  const title = firstMeta(html, ['og:title', 'twitter:title']) ?? titleTag
  const description = firstMeta(html, ['og:description', 'twitter:description', 'description'])
  const detection = detectFromHtml(html, res.headers)
  const ogImageRaw = firstMeta(html, ['og:image:secure_url', 'og:image', 'twitter:image'])
  const ogImage = ogImageRaw ? resolveHttpUrl(ogImageRaw, res.url) : null

  return {
    detection,
    finalUrl: res.url,
    title,
    description,
    ogImage,
    status: res.status,
    blockSignal: detectBlock(res.status, res.headers, html),
    hosting: detectHosting(res.headers),
    profile,
    html,
  }
}

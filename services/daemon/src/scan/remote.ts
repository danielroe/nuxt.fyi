import { config } from '../config.ts'
import { log } from '../log.ts'

/**
 * HTTP client for the scanner service. The daemon hands the page URL + canonical domain
 * to the scanner over Fly private networking; the scanner captures the screenshot,
 * uploads it to ImageKit, and returns the bucket path. The scanner is best-effort: any
 * failure (network, 5xx, scanner unavailable / scaled to zero) returns a result with
 * `imageKey: null` and the scan continues with the og:image as the only image source.
 */

export interface RemoteCaptureResult {
  imageKey: string | null
  imageUrl: string | null
  width: number
  height: number
  bytes: number
  capturedAt: number
  nsfw: {
    label: 'safe' | 'suggestive' | 'nsfw'
    score: number | null
    categories: Record<string, unknown>
  } | null
  error: string | null
}

/**
 * Wall-clock budget for the HTTP round-trip, including:
 *   - cold-start of a scaled-to-zero scanner machine (~3-5s)
 *   - the scanner's own internal capture budget (60s)
 *   - the ImageKit upload (a few hundred ms on the happy path)
 *
 * The scanner itself returns 500 well within its own budget for genuinely stuck pages;
 * this outer timeout only fires when the scanner machine itself is wedged or unreachable.
 */
const HTTP_TIMEOUT_MS = 90_000

export async function remoteCapture(url: string, domain: string): Promise<RemoteCaptureResult | null> {
  if (!config.scanner.url || !config.scanner.token) {
    log.debug('[scanner] not configured, skipping remote capture')
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(`${config.scanner.url.replace(/\/$/, '')}/capture`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${config.scanner.token}`,
      },
      body: JSON.stringify({ url, domain }),
    })
    const result = await res.json() as RemoteCaptureResult
    if (!res.ok) {
      log.warn(`[scanner] ${domain} returned ${res.status}: ${result.error ?? '(no error message)'}`)
    }
    return result
  }
  catch (err) {
    const e = err as Error & { cause?: { code?: string, message?: string } }
    if (e.name === 'AbortError') {
      log.warn(`[scanner] ${domain} request timed out after ${HTTP_TIMEOUT_MS}ms`)
    }
    else {
      const cause = e.cause?.code ? `${e.cause.code}: ${e.cause.message ?? ''}` : e.cause?.message ?? e.message
      log.warn(`[scanner] ${domain} request failed: ${cause}`)
    }
    return null
  }
  finally {
    clearTimeout(timer)
  }
}

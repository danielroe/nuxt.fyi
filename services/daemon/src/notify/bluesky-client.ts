import { AtpAgent } from '@atproto/api'
import { config } from '../config.ts'
import { log } from '../log.ts'

let agent: AtpAgent | null = null
let loginPromise: Promise<AtpAgent | null> | null = null

/**
 * Lazy-login + cached `AtpAgent`. Returns null when credentials aren't configured or
 * login fails; callers are expected to treat that as "feature disabled" rather than an
 * error. Concurrent callers during the initial login share one in-flight login promise.
 */
export async function getAgent(): Promise<AtpAgent | null> {
  if (agent) return agent
  if (loginPromise) return loginPromise

  if (!config.bluesky.identifier || !config.bluesky.appPassword) {
    log.debug('[bluesky] no identifier or app password configured, skipping')
    return null
  }

  loginPromise = (async () => {
    const a = new AtpAgent({ service: config.bluesky.service })
    try {
      await a.login({
        identifier: config.bluesky.identifier,
        password: config.bluesky.appPassword,
      })
      log.info(`[bluesky] logged in as ${config.bluesky.identifier}`)
      agent = a
      return a
    }
    catch (err) {
      log.error(`[bluesky] login failed: ${(err as Error).message}`)
      return null
    }
    finally {
      loginPromise = null
    }
  })()
  return loginPromise
}

/**
 * DID of the currently-logged-in account, or null if we're not logged in. Used by the
 * Jetstream consumer to identify mentions of our own bot and to ignore posts we
 * authored ourselves.
 */
export async function getSelfDid(): Promise<string | null> {
  const a = await getAgent()
  return a?.session?.did ?? null
}

/** Bluesky blob upload limit. Our 1280x800 quality-80 JPEGs are 60–150KB so well under. */
const MAX_IMAGE_BYTES = 1_000_000

export interface ThumbSource {
  /** Direct URL to an image we'll fetch and re-upload as a Bluesky blob. */
  url: string
  /** Short label used only in log lines. */
  label: string
}

/**
 * Fetches each `ThumbSource` in order, uploading the first one that returns a valid
 * image under Bluesky's blob size cap, and returns the resulting blob ref ready to drop
 * into an `app.bsky.embed.external` card. Returns `undefined` if every source fails;
 * callers should render the card without a thumb in that case rather than erroring.
 */
export async function uploadCardThumb(
  agent: AtpAgent,
  sources: ThumbSource[],
  context: string,
): Promise<unknown | undefined> {
  for (const { url, label } of sources) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      let res: Response
      try {
        res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
      }
      finally { clearTimeout(timer) }
      if (!res.ok) {
        log.warn(`[bluesky] ${label} fetch returned ${res.status} for ${context}`)
        continue
      }
      const type = res.headers.get('content-type') || 'image/jpeg'
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        log.warn(`[bluesky] ${label} for ${context} is ${buf.byteLength} bytes (>${MAX_IMAGE_BYTES}); trying next source`)
        continue
      }
      const uploaded = await agent.uploadBlob(buf, { encoding: type.split(';')[0]!.trim() })
      return uploaded.data.blob
    }
    catch (err) {
      log.warn(`[bluesky] ${label} upload failed for ${context}: ${(err as Error).message}`)
    }
  }
  return undefined
}

export function imagekitUrl(filePath: string): string | null {
  if (!config.imagekit.urlEndpoint) return null
  return `${config.imagekit.urlEndpoint.replace(/\/$/, '')}${filePath}`
}

/**
 * Build the `ThumbSource[]` fallback chain from the three image fields we record per
 * scan. Order is: ImageKit-hosted screenshot, ImageKit-hosted og:image copy, then the
 * upstream og:image URL as a last resort. Identical chain used by the firehose-notify
 * path and the reply path; only the input shape differs.
 */
export function thumbSourcesFromImages(
  screenshotKey: string | null,
  ogImageKey: string | null,
  ogImage: string | null,
): ThumbSource[] {
  const sources: ThumbSource[] = []
  const screenshotUrl = screenshotKey ? imagekitUrl(screenshotKey) : null
  const ogImageKeyUrl = ogImageKey ? imagekitUrl(ogImageKey) : null
  if (screenshotUrl) sources.push({ url: screenshotUrl, label: 'imagekit screenshot' })
  if (ogImageKeyUrl) sources.push({ url: ogImageKeyUrl, label: 'imagekit og:image' })
  if (ogImage) sources.push({ url: ogImage, label: 'upstream og:image' })
  return sources
}

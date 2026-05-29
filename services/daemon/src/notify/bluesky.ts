import { AtpAgent, RichText } from '@atproto/api'
import { config } from '../config.ts'
import { log } from '../log.ts'
import { lastNotifiedAt } from '../store.ts'
import type { ScanOutcome } from '../scan/index.ts'

let agent: AtpAgent | null = null
let loginPromise: Promise<AtpAgent | null> | null = null

/** Bluesky blob upload limit. Our 1280x800 quality-80 JPEGs are 60–150KB so well under. */
const MAX_IMAGE_BYTES = 1_000_000

/** Title cap on external embed card; longer values are truncated by the client anyway. */
const CARD_TITLE_MAX = 300

/** Description cap on external embed card. */
const CARD_DESC_MAX = 1000

async function getAgent(): Promise<AtpAgent | null> {
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
    } catch (err) {
      log.error(`[bluesky] login failed: ${(err as Error).message}`)
      return null
    } finally {
      loginPromise = null
    }
  })()
  return loginPromise
}

/**
 * Post text is just "Nuxt v<version>" when we know it, otherwise empty. The card carries
 * the title/description/thumbnail; the post text only needs to disambiguate when there's
 * something the card can't say (i.e. the precise Nuxt version).
 */
function buildPostText(outcome: ScanOutcome): string {
  return outcome.detection.nuxtVersion ? `Nuxt v${outcome.detection.nuxtVersion}` : ''
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}\u2026`
}

export async function notifyBluesky(outcome: ScanOutcome): Promise<boolean> {
  if (!outcome.detection.isNuxt) return false

  const a = await getAgent()
  if (!a) return false

  // Rate limit tracked via the notifications table so it survives restarts.
  const since = Date.now() - lastNotifiedAt('bluesky')
  if (since < config.bluesky.minIntervalMs) {
    const wait = Math.ceil((config.bluesky.minIntervalMs - since) / 1000)
    log.debug(`[bluesky] rate-limited, ${wait}s until next post; skipping ${outcome.domain}`)
    return false
  }

  const text = buildPostText(outcome)
  const rt = new RichText({ text })
  await rt.detectFacets(a)

  const link = outcome.finalUrl || `https://${outcome.domain}`
  const thumb = await uploadCardThumb(a, outcome)
  const embed = {
    $type: 'app.bsky.embed.external',
    external: {
      uri: link,
      title: truncate(outcome.title || outcome.domain, CARD_TITLE_MAX),
      description: truncate(outcome.description || '', CARD_DESC_MAX),
      ...(thumb ? { thumb } : {}),
    },
  }

  const post: Record<string, unknown> = {
    text: rt.text,
    createdAt: new Date().toISOString(),
    embed,
  }
  if (rt.facets) post.facets = rt.facets

  // Self-label NSFW posts via Bluesky's standard moderation labels. Users opt in/out of
  // seeing each label via their account preferences; we apply the label and let their
  // client decide whether to blur, hide, or show. `nsfw` -> `porn` (Adult content);
  // `suggestive` -> `sexual` (Sexually suggestive).
  const labelValue = outcome.nsfwLabel === 'nsfw'
    ? 'porn'
    : outcome.nsfwLabel === 'suggestive'
      ? 'sexual'
      : null
  if (labelValue) {
    post.labels = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{ val: labelValue }],
    }
  }

  try {
    await a.post(post as Parameters<typeof a.post>[0])
    return true
  } catch (err) {
    log.error(`[bluesky] post failed for ${outcome.domain}: ${(err as Error).message}`)
    return false
  }
}

function imagekitUrl(filePath: string): string | null {
  if (!config.imagekit.urlEndpoint) return null
  return `${config.imagekit.urlEndpoint.replace(/\/$/, '')}${filePath}`
}

/**
 * Uploads a thumbnail blob for the external embed. Pulls bytes from ImageKit (preferring
 * the screenshot, falling back to the og:image copy, then to the upstream og:image URL).
 * Returns undefined if none of those produce a valid blob within Bluesky's 1MB cap; the
 * card then renders without a thumbnail.
 */
async function uploadCardThumb(a: AtpAgent, outcome: ScanOutcome): Promise<unknown | undefined> {
  const sources: Array<{ url: string, label: string }> = []
  const screenshotUrl = outcome.screenshotKey ? imagekitUrl(outcome.screenshotKey) : null
  const ogImageKeyUrl = outcome.ogImageKey ? imagekitUrl(outcome.ogImageKey) : null
  if (screenshotUrl) sources.push({ url: screenshotUrl, label: 'imagekit screenshot' })
  if (ogImageKeyUrl) sources.push({ url: ogImageKeyUrl, label: 'imagekit og:image' })
  if (outcome.ogImage) sources.push({ url: outcome.ogImage, label: 'upstream og:image' })

  for (const { url, label } of sources) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      let res: Response
      try {
        res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
      } finally { clearTimeout(timer) }
      if (!res.ok) {
        log.warn(`[bluesky] ${label} fetch returned ${res.status} for ${outcome.domain}`)
        continue
      }
      const type = res.headers.get('content-type') || 'image/jpeg'
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        log.warn(`[bluesky] ${label} for ${outcome.domain} is ${buf.byteLength} bytes (>${MAX_IMAGE_BYTES}); trying next source`)
        continue
      }
      const uploaded = await a.uploadBlob(buf, { encoding: type.split(';')[0]!.trim() })
      return uploaded.data.blob
    }
    catch (err) {
      log.warn(`[bluesky] ${label} upload failed for ${outcome.domain}: ${(err as Error).message}`)
    }
  }

  return undefined
}

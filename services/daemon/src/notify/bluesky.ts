import { RichText } from '@atproto/api'
import { config } from '../config.ts'
import { log } from '../log.ts'
import { lastNotifiedAt } from '../store.ts'
import { getAgent, thumbSourcesFromImages, uploadCardThumb } from './bluesky-client.ts'
import type { ScanOutcome } from '../scan/index.ts'

/** Title cap on external embed card; longer values are truncated by the client anyway. */
const CARD_TITLE_MAX = 300

/** Description cap on external embed card. */
const CARD_DESC_MAX = 1000

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
  const thumb = await uploadCardThumb(
    a,
    thumbSourcesFromImages(outcome.screenshotKey, outcome.ogImageKey, outcome.ogImage),
    outcome.domain,
  )
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



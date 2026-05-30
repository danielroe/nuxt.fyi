import { RichText } from '@atproto/api'
import { log } from '../log.ts'
import { getAgent, thumbSourcesFromImages, uploadCardThumb } from './bluesky-client.ts'
import type { ReplyRequestRow, ScanRow } from '../store.ts'

/** Cap on external embed card title; clients truncate beyond this anyway. */
const CARD_TITLE_MAX = 300
/** Cap on external embed card description. */
const CARD_DESC_MAX = 1000
/** Bluesky post text limit (graphemes; we treat as UTF-16 chars, which is conservative). */
const POST_TEXT_MAX = 300

export interface ReplyTarget {
  postUri: string
  postCid: string
  rootUri: string
  rootCid: string
}

function strongRef(uri: string, cid: string): { uri: string, cid: string } {
  return { uri, cid }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}\u2026`
}

/**
 * URL of the dashboard's per-domain detail page. Used as the embed-card link in replies
 * so the requester gets a clear "this is what we think, with signals" page whether the
 * site turned out to be Nuxt or not.
 */
function hitsUrl(domain: string): string {
  return `https://nuxt.fyi/hits/${encodeURIComponent(domain)}`
}

/**
 * Builds the body of a reply post: the text the user sees in their notifications, and
 * the embed-card payload (if any). Three shapes:
 *
 *  - confirmed Nuxt: short text ("`<domain>` is built with Nuxt v4.x"), card with screenshot.
 *  - confirmed not Nuxt: text only ("As far as I can tell, `<domain>` isn't built with Nuxt"),
 *    link to `/hits/<domain>` in a card with no thumb.
 *  - scan error: text only ("Couldn't reach `<domain>` to check"), link to `/hits/<domain>`.
 */
function buildReplyBody(scan: ScanRow | null, domain: string): { text: string, link: string, title: string, description: string } {
  if (!scan) {
    return {
      text: `Couldn't reach ${domain} to check.`,
      link: hitsUrl(domain),
      title: `${domain} on nuxt.fyi`,
      description: 'Scan failed; no detection result recorded.',
    }
  }
  if (scan.is_nuxt) {
    const version = scan.nuxt_version ? `v${scan.nuxt_version}` : ''
    const text = version ? `${domain} is built with Nuxt ${version}.` : `${domain} is built with Nuxt.`
    return {
      text,
      link: hitsUrl(domain),
      title: scan.title || domain,
      description: version ? `Detected Nuxt ${version} on ${domain}.` : `Detected Nuxt on ${domain}.`,
    }
  }
  if (scan.error) {
    return {
      text: `Couldn't reach ${domain} to check.`,
      link: hitsUrl(domain),
      title: `${domain} on nuxt.fyi`,
      description: scan.error,
    }
  }
  return {
    text: `As far as I can tell, ${domain} isn't built with Nuxt.`,
    link: hitsUrl(domain),
    title: `${domain} on nuxt.fyi`,
    description: 'No Nuxt signals detected.',
  }
}

/**
 * Posts a reply to a single `ReplyTarget` with the scan result for `domain`. Returns
 * `true` iff the post landed; `false` (with a logged warning) on any failure mode so the
 * caller can decide whether to leave the row pending for a future retry. Bypasses the
 * Bluesky rate-limit gate used by firehose notifications: replies are user-initiated, not
 * spammy, and rate-limiting them would silently swallow user requests.
 */
export async function replyWithScan(
  target: ReplyTarget,
  domain: string,
  scan: ScanRow | null,
): Promise<boolean> {
  const a = await getAgent()
  if (!a) return false

  const body = buildReplyBody(scan, domain)
  const text = truncate(body.text, POST_TEXT_MAX)
  const rt = new RichText({ text })
  await rt.detectFacets(a)

  let thumb: unknown | undefined
  if (scan?.is_nuxt) {
    thumb = await uploadCardThumb(
      a,
      thumbSourcesFromImages(scan.screenshot_key, scan.og_image_key, scan.og_image),
      domain,
    )
  }

  const post: Record<string, unknown> = {
    text: rt.text,
    createdAt: new Date().toISOString(),
    reply: {
      root: strongRef(target.rootUri, target.rootCid),
      parent: strongRef(target.postUri, target.postCid),
    },
    embed: {
      $type: 'app.bsky.embed.external',
      external: {
        uri: body.link,
        title: truncate(body.title, CARD_TITLE_MAX),
        description: truncate(body.description, CARD_DESC_MAX),
        ...(thumb ? { thumb } : {}),
      },
    },
  }
  if (rt.facets) post.facets = rt.facets

  // NSFW self-labelling: only when we're attaching a screenshot. Bluesky scopes labels
  // to the whole post, so labelling a thumb-less reply would be a lie.
  if (scan?.is_nuxt && thumb) {
    const labelValue = scan.nsfw_label === 'nsfw'
      ? 'porn'
      : scan.nsfw_label === 'suggestive'
        ? 'sexual'
        : null
    if (labelValue) {
      post.labels = {
        $type: 'com.atproto.label.defs#selfLabels',
        values: [{ val: labelValue }],
      }
    }
  }

  try {
    await a.post(post as Parameters<typeof a.post>[0])
    return true
  }
  catch (err) {
    log.error(`[bluesky-reply] post failed for ${domain} -> ${target.postUri}: ${(err as Error).message}`)
    return false
  }
}

export function targetFromRow(row: ReplyRequestRow): ReplyTarget {
  return {
    postUri: row.post_uri,
    postCid: row.post_cid,
    rootUri: row.root_uri,
    rootCid: row.root_cid,
  }
}

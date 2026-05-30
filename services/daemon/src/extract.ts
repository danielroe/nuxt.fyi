export interface JetstreamEvent {
  did?: string
  time_us?: number
  kind?: string
  commit?: {
    operation?: string
    collection?: string
    rkey?: string
    cid?: string
    record?: PostRecord
  }
}

export interface PostRecord {
  $type?: string
  text?: string
  facets?: Facet[]
  embed?: Embed
  langs?: string[]
  reply?: {
    root?: StrongRef
    parent?: StrongRef
  }
}

export interface StrongRef {
  uri?: string
  cid?: string
}

interface Facet {
  features?: FacetFeature[]
  index?: { byteStart: number, byteEnd: number }
}

interface FacetFeature {
  $type?: string
  uri?: string
  did?: string
  tag?: string
}

interface Embed {
  $type?: string
  external?: { uri?: string, title?: string, description?: string }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)]+/gi

export function extractUrls(record: PostRecord | undefined): string[] {
  if (!record) return []
  const urls = new Set<string>()

  if (record.facets) {
    for (const facet of record.facets) {
      if (!facet.features) continue
      for (const feature of facet.features) {
        if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
          urls.add(feature.uri)
        }
      }
    }
  }

  const externalUri = record.embed?.external?.uri
  if (externalUri) urls.add(externalUri)

  if (record.text && urls.size === 0) {
    const matches = record.text.match(URL_RE)
    if (matches) for (const m of matches) urls.add(m)
  }

  return [...urls]
}

/**
 * DIDs referenced by `app.bsky.richtext.facet#mention` features in the post. Used to
 * decide whether a post is addressed to our bot account. Returns a deduped list; order
 * is preserved for callers that want the first mention.
 */
export function extractMentionDids(record: PostRecord | undefined): string[] {
  if (!record?.facets) return []
  const out = new Set<string>()
  for (const facet of record.facets) {
    if (!facet.features) continue
    for (const feature of facet.features) {
      if (feature.$type === 'app.bsky.richtext.facet#mention' && feature.did) {
        out.add(feature.did)
      }
    }
  }
  return [...out]
}

export interface TriggerPost {
  /** at:// URI of the post itself, built from author DID + collection + rkey. */
  uri: string
  /** CID of the post commit, used as the strong-ref companion to `uri`. */
  cid: string
  /** at:// URI of the conversation root. Equals `uri` when the post itself is the root. */
  rootUri: string
  /** CID of the conversation root, paired with `rootUri`. */
  rootCid: string
  /** Author DID; used to skip posts authored by our own bot. */
  authorDid: string
}

export interface Trigger {
  post: TriggerPost
  /** Raw URLs extracted from the post, deduped. Caller is expected to normalise and
   *  registrable-collapse these via the existing `domains.ts` helpers. */
  urls: string[]
}

const POST_COLLECTION = 'app.bsky.feed.post'

/**
 * If the post mentions `selfDid` via a `#mention` facet, returns the post identity plus
 * the URLs the post carries; otherwise null. Self-authored posts (where `event.did ===
 * selfDid`) are filtered out so the bot can't reply to itself if it ever ends up posting
 * a domain alongside its own mention.
 *
 * `selfDid` is the DID of the logged-in bot account, resolved at login time. Pass null
 * to skip detection entirely (e.g. when Bluesky credentials aren't configured).
 */
export function extractTrigger(event: JetstreamEvent, selfDid: string | null): Trigger | null {
  if (!selfDid) return null
  const authorDid = event.did
  if (!authorDid || authorDid === selfDid) return null
  const commit = event.commit
  if (!commit?.rkey || !commit.cid) return null
  const record = commit.record
  if (!record) return null

  const mentions = extractMentionDids(record)
  if (!mentions.includes(selfDid)) return null

  const urls = extractUrls(record)
  if (urls.length === 0) return null

  const uri = `at://${authorDid}/${POST_COLLECTION}/${commit.rkey}`
  const cid = commit.cid
  // If this post is itself a reply, the conversation root is whatever the parent post
  // declared as its root; otherwise this post _is_ the root.
  const rootRef = record.reply?.root
  const hasRoot = !!(rootRef?.uri && rootRef.cid)
  const rootUri = hasRoot ? rootRef!.uri! : uri
  const rootCid = hasRoot ? rootRef!.cid! : cid

  return {
    post: { uri, cid, rootUri, rootCid, authorDid },
    urls,
  }
}

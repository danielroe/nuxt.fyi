export interface JetstreamEvent {
  did?: string
  time_us?: number
  kind?: string
  commit?: {
    operation?: string
    collection?: string
    rkey?: string
    record?: PostRecord
  }
}

interface PostRecord {
  $type?: string
  text?: string
  facets?: Facet[]
  embed?: Embed
  langs?: string[]
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

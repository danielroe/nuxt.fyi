import { parse } from 'tldts'

const SKIP_DOMAINS = new Set([
  'bsky.app',
  'bsky.social',
  'go.bsky.app',
  'staging.bsky.app',
  'twitter.com',
  'x.com',
  't.co',
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'google.com',
  'www.google.com',
  'facebook.com',
  'm.facebook.com',
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'old.reddit.com',
  'github.com',
  'gist.github.com',
  'medium.com',
  'linkedin.com',
  'wikipedia.org',
  'en.wikipedia.org',
  'amazon.com',
  'amzn.to',
  'spotify.com',
  'open.spotify.com',
  'apple.com',
  'imdb.com',
  'discord.com',
  'discord.gg',
  'mastodon.social',
  'threads.net',
  'tumblr.com',
  'pinterest.com',
  'twitch.tv',
  'paypal.com',
  'patreon.com',
  'substack.com',
  'tinyurl.com',
  'bit.ly',
  'buff.ly',
  'ow.ly',
  'is.gd',
  'goo.gl',
  'lnkd.in',
  'dlvr.it',
  'ift.tt',
  'trib.al',
  'apple.news',
  'meli.la',
  'shar.es',
  'flip.it',
  'threads.com',
  // GIF / media pickers embedded by the Bluesky composer.
  'klipy.com',
  'tenor.com',
  'giphy.com',
  // Large user-content platforms; the link target isn't a site we'd attribute to a framework.
  'soundcloud.com',
  'vimeo.com',
  'imgur.com',
  'flickr.com',
  'i.redd.it',
  'v.redd.it',
])

export interface NormalisedUrl {
  href: string
  hostname: string
  registrable: string
}

export function normaliseUrl(raw: string): NormalisedUrl | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Only prefix when there's no scheme at all so we don't coerce mailto: / ftp: into https.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`
  let u: URL
  try {
    u = new URL(candidate)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const hostname = u.hostname.toLowerCase()
  const parsed = parse(hostname)
  if (!parsed.domain || !parsed.isIcann) return null

  return {
    href: u.toString(),
    hostname,
    registrable: parsed.domain,
  }
}

/** Load-balancer / region noise to collapse into a single content host. */
const NOISE_PATTERNS: Array<{ match: RegExp, canonical: string }> = [
  { match: /^[a-z]{2}\d+web\.zoom\.us$/, canonical: 'zoom.us' },
  { match: /^(staging|main|go)\.bsky\.app$/, canonical: 'bsky.app' },
]

/**
 * Canonical host for storage and display. Collapses `www.` and known noisy subdomain patterns;
 * leaves other subdomains alone so `support.zoom.us` and `marketplace.zoom.us` stay distinct.
 */
export function canonicalDomain(hostname: string): string {
  const lower = hostname.toLowerCase().trim()
  for (const { match, canonical } of NOISE_PATTERNS) {
    if (match.test(lower)) return canonical
  }
  if (lower.startsWith('www.')) return lower.slice(4)
  return lower
}

export function shouldSkipDomain(domain: string): boolean {
  if (SKIP_DOMAINS.has(domain)) return true
  for (const skip of SKIP_DOMAINS) {
    if (domain.endsWith(`.${skip}`)) return true
  }
  return false
}

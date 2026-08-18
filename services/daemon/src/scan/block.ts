/**
 * Bot-mitigation detection for the HTML fetch. A "block" is a response that isn't the
 * site's real page: a challenge interstitial, a captcha wall, or an outright deny from
 * a WAF/CDN. Vendor checks run first (they're more actionable than a bare status code);
 * plain 4xx/5xx statuses only count as blocks when no vendor matched, since a challenge
 * page usually arrives with a 403/429/503 of its own.
 */

export type BlockSignal
  = | 'cloudflare-challenge'
    | 'datadome'
    | 'akamai'
    | 'perimeterx'
    | 'imperva'
    | 'kasada'
    | 'vercel-challenge'
    | 'http-401'
    | 'http-403'
    | 'http-429'
    | 'http-503'

const BLOCK_STATUSES: Record<number, BlockSignal> = {
  401: 'http-401',
  403: 'http-403',
  429: 'http-429',
  503: 'http-503',
}

export function detectBlock(status: number, headers: Headers, html: string): BlockSignal | null {
  if (
    headers.get('cf-mitigated') === 'challenge'
    || html.includes('/cdn-cgi/challenge-platform/')
    || html.includes('__cf_chl_')
    || /<title[^>]*>\s*(?:just a moment|attention required!\s*\|\s*cloudflare)/i.test(html)
  ) {
    return 'cloudflare-challenge'
  }

  if (headers.has('x-datadome') || html.includes('captcha-delivery.com') || /ct\.datadome\.co/i.test(html)) {
    return 'datadome'
  }

  const server = headers.get('server') ?? ''
  if (
    (/akamaighost/i.test(server) && status >= 400)
    || html.includes('errors.edgesuite.net')
    || (/<title[^>]*>\s*access denied/i.test(html) && /Reference&#32;#|Reference #\d/.test(html))
  ) {
    return 'akamai'
  }

  if (html.includes('px-captcha') || /client\.perimeterx\.net|captcha\.px-cdn\.net/i.test(html)) {
    return 'perimeterx'
  }

  if (html.includes('_Incapsula_Resource') || /incapsula incident/i.test(html)) {
    return 'imperva'
  }

  if (headers.has('x-kpsdk-ct') || /kpsdk-load|ips\.js\?timestamp/i.test(html)) {
    return 'kasada'
  }

  if (headers.get('x-vercel-mitigated') === 'challenge') {
    return 'vercel-challenge'
  }

  return BLOCK_STATUSES[status] ?? null
}

/**
 * Request header profiles used by the scanner.
 *
 * We identify ourselves honestly by default: `polite` carries a contactable bot UA so
 * operators can see who we are and block us deliberately if they want. Plenty of WAFs
 * refuse any non-browser UA outright though, so a refusal is met with one retry under
 * `browser`, which sends the header set a real Chrome navigation would. We escalate only
 * after being turned away, never pre-emptively.
 */

export const POLITE_UA = 'Mozilla/5.0 (compatible; NuxtFyi/0.1; +https://nuxt.fyi)'
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

export type ProfileName = 'polite' | 'browser'

/** Headers for a top-level document request. */
export function documentHeaders(profile: ProfileName): Record<string, string> {
  if (profile === 'polite') {
    return {
      'user-agent': POLITE_UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en',
    }
  }
  return {
    'user-agent': BROWSER_UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-GB,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="133", "Not(A:Brand";v="24", "Google Chrome";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  }
}

/** Headers for a subresource request (JS chunk, JSON probe) made after a document load. */
export function subresourceHeaders(profile: ProfileName, accept: string): Record<string, string> {
  if (profile === 'polite') {
    return { 'user-agent': POLITE_UA, accept }
  }
  return {
    'user-agent': BROWSER_UA,
    accept,
    'accept-language': 'en-GB,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="133", "Not(A:Brand";v="24", "Google Chrome";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  }
}

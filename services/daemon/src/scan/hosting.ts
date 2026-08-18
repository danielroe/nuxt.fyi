/**
 * Hosting detection from response headers, split into two independent facts: the
 * platform serving the origin (Vercel, Netlify, Fly, ...) and the CDN fronting it
 * (Cloudflare, CloudFront, Fastly, Akamai). A Vercel site behind Cloudflare is common
 * and reports as both. Platforms that ship their own edge (Vercel, Netlify) don't count
 * as a CDN here; only third-party fronting does.
 *
 * A CDN with no detectable platform means the origin is hidden behind it: Cloudflare
 * Pages/Workers sites land in that bucket too, since they expose nothing beyond cf-ray.
 */

export interface HostingResult {
  platform: string | null
  cdn: string | null
}

function detectPlatform(headers: Headers): string | null {
  const server = headers.get('server')?.toLowerCase() ?? ''
  const via = headers.get('via')?.toLowerCase() ?? ''

  if (headers.has('x-vercel-id') || headers.has('x-vercel-cache') || server === 'vercel') return 'vercel'
  if (headers.has('x-nf-request-id') || server === 'netlify') return 'netlify'
  if (headers.has('fly-request-id')) return 'fly'
  if (headers.has('x-render-origin-server') || headers.has('x-render-routing')) return 'render'
  if (server === 'railway-edge' || headers.has('x-railway-request-id')) return 'railway'
  if (via.includes('vegur') || server === 'heroku') return 'heroku'
  if (server === 'github.com') return 'github-pages'
  if (server === 'amplifyhosting') return 'aws-amplify'
  if (server.startsWith('deno/')) return 'deno-deploy'
  if (headers.has('x-do-app-origin') || server === 'digitalocean') return 'digitalocean'
  if (headers.has('x-kinsta-cache')) return 'kinsta'
  if (headers.has('x-azure-ref')) return 'azure'

  return null
}

function detectCdn(headers: Headers): string | null {
  const server = headers.get('server')?.toLowerCase() ?? ''
  const via = headers.get('via')?.toLowerCase() ?? ''

  if (headers.has('cf-ray')) return 'cloudflare'
  if (headers.has('x-amz-cf-id') || via.includes('cloudfront')) return 'aws-cloudfront'
  if (headers.has('x-fastly-request-id') || (headers.has('x-served-by') && /\bcache-[a-z]{3}/.test(headers.get('x-served-by') ?? ''))) return 'fastly'
  if (server.includes('akamai') || headers.has('x-akamai-transformed')) return 'akamai'

  return null
}

export function detectHosting(headers: Headers): HostingResult {
  return { platform: detectPlatform(headers), cdn: detectCdn(headers) }
}

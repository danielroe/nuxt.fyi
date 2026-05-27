/**
 * Resolves the image URL for a hit. The site's og:image is preferred (CDN-hosted, higher
 * quality, no proxy hop); the locally-captured screenshot is the fallback when the site
 * doesn't declare one or it failed validation at scan time. Returns null when neither is
 * available, signalling "no image" to the template.
 */
export function imageUrlFor(domain: string, ogImage: string | null, screenshotPath: string | null): string | null {
  if (ogImage) return ogImage
  if (screenshotPath) return `/api/screenshots/${encodeURIComponent(domain)}`
  return null
}

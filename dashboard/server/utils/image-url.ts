/**
 * Image sources for a hit, returned to the client so it can render either the screenshot
 * or the upstream og:image (and let the user toggle). All four URL fields are nullable;
 * the client falls through to the first one that's set within each family.
 *
 * - `screenshotKey` / `ogImageKey` are ImageKit paths to feed `<NuxtImg provider="imagekit">`.
 *   These exist only for rows that have been scanned since ImageKit upload was wired in,
 *   plus rows touched by the backfill script.
 * - `screenshotUrl` / `ogImageUrl` are the legacy non-ImageKit fallbacks: the local-disk
 *   screenshot served by `/api/screenshots/<domain>`, and the upstream og:image URL on the
 *   site's own CDN.
 * - `nsfwLabel` is the classifier's verdict on the screenshot bytes. Null = unclassified
 *   (older row or classifier failed). `suggestive` renders normally; `nsfw` is blurred
 *   with a click-to-reveal control.
 */
export interface ImageSources {
  screenshotKey: string | null
  ogImageKey: string | null
  screenshotUrl: string | null
  ogImageUrl: string | null
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
}

export function imageSourcesFor(
  domain: string,
  ogImage: string | null,
  screenshotPath: string | null,
  screenshotKey: string | null,
  ogImageKey: string | null,
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null,
): ImageSources {
  return {
    screenshotKey,
    ogImageKey,
    screenshotUrl: screenshotPath ? `/api/screenshots/${encodeURIComponent(domain)}` : null,
    ogImageUrl: ogImage,
    nsfwLabel,
  }
}

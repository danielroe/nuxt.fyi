/**
 * Image sources for a hit, returned to the client so it can render either the screenshot
 * or the upstream og:image (and let the user toggle). All three URL fields are nullable;
 * the client falls through to the first one that's set.
 *
 * - `screenshotKey` / `ogImageKey` are ImageKit paths to feed `<NuxtImg provider="imagekit">`.
 *   These exist only for rows that have been scanned since ImageKit upload was wired in,
 *   plus rows touched by the backfill script.
 * - `screenshotUrl` / `ogImageUrl` are the legacy non-ImageKit fallbacks: the local-disk
 *   screenshot served by `/api/screenshots/<domain>`, and the upstream og:image URL on the
 *   site's own CDN. These let the dashboard render images for rows that pre-date the
 *   ImageKit migration or where upload failed.
 */
export interface ImageSources {
  screenshotKey: string | null
  ogImageKey: string | null
  screenshotUrl: string | null
  ogImageUrl: string | null
}

export function imageSourcesFor(
  domain: string,
  ogImage: string | null,
  screenshotPath: string | null,
  screenshotKey: string | null,
  ogImageKey: string | null,
): ImageSources {
  return {
    screenshotKey,
    ogImageKey,
    screenshotUrl: screenshotPath ? `/api/screenshots/${encodeURIComponent(domain)}` : null,
    ogImageUrl: ogImage,
  }
}

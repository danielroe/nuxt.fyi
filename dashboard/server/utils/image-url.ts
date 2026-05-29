/**
 * Image sources for a hit, returned to the client so it can render either the screenshot
 * or the upstream og:image (and let the user toggle).
 *
 * - `screenshotKey` / `ogImageKey` are ImageKit paths to feed `<NuxtImg provider="imagekit">`.
 *   These exist for every Nuxt-confirmed row scanned after ImageKit was wired in.
 * - `ogImageUrl` is the original upstream og:image URL, retained as a last-resort fallback
 *   for the handful of rows where the daemon recorded an og:image origin but the ImageKit
 *   upload never landed (network failure, ImageKit downtime). Plain `<img src>` renders it.
 * - `nsfwLabel` is the classifier's verdict on the screenshot bytes. Null = unclassified
 *   (older row or classifier failed). `suggestive` renders normally; `nsfw` is blurred
 *   with a click-to-reveal control.
 */
export interface ImageSources {
  screenshotKey: string | null
  ogImageKey: string | null
  ogImageUrl: string | null
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
}

export function imageSourcesFor(
  ogImage: string | null,
  screenshotKey: string | null,
  ogImageKey: string | null,
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null,
): ImageSources {
  return {
    screenshotKey,
    ogImageKey,
    ogImageUrl: ogImage,
    nsfwLabel,
  }
}

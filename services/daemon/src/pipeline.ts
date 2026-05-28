import { log } from './log.ts'
import { hasNotified, recordNotification, recordScan } from './store.ts'
import type { ScanOutcome } from './scan/index.ts'
import { notifyDiscord } from './notify/discord.ts'
import { notifyBluesky } from './notify/bluesky.ts'

/**
 * Writes a scan outcome to the `scans` table, overwriting any prior row for the same
 * domain. Pure SQLite work; no I/O outside the database.
 */
export function persistOutcome(outcome: ScanOutcome): void {
  recordScan({
    domain: outcome.domain,
    is_nuxt: outcome.detection.isNuxt ? 1 : 0,
    nuxt_version: outcome.detection.nuxtVersion,
    confidence: outcome.detection.confidence,
    signals: JSON.stringify(outcome.detection.signals),
    final_url: outcome.finalUrl,
    title: outcome.title,
    screenshot_path: outcome.screenshotPath,
    og_image: outcome.ogImage,
    screenshot_key: outcome.screenshotKey,
    og_image_key: outcome.ogImageKey,
    redirected_to: outcome.redirectedTo,
    error: outcome.error,
  })
}

/**
 * Posts a confirmed Nuxt hit to every configured notification channel, skipping channels
 * that have already received this domain. Failures on one channel don't abort the others;
 * each is logged and swallowed so a flaky webhook can't block a Bluesky post.
 */
export async function dispatchNotifications(outcome: ScanOutcome): Promise<void> {
  const channels: Array<{ name: string, post: (o: ScanOutcome) => Promise<boolean> }> = [
    { name: 'discord', post: notifyDiscord },
    { name: 'bluesky', post: notifyBluesky },
  ]
  for (const { name, post } of channels) {
    if (hasNotified(outcome.domain, name)) continue
    try {
      const posted = await post(outcome)
      if (posted) {
        recordNotification(outcome.domain, name)
        log.success(`[${name}] posted ${outcome.domain}`)
      }
    } catch (err) {
      log.error(`[${name}] failed to post ${outcome.domain}:`, (err as Error).message)
    }
  }
}

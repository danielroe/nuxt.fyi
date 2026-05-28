import { config } from '../config.ts'
import { log } from '../log.ts'
import type { ScanOutcome } from '../scan/index.ts'

const IMAGE_FETCH_TIMEOUT_MS = 10_000

/**
 * Fetches the ImageKit-hosted screenshot or og:image so we can attach it directly to the
 * Discord webhook. Used for NSFW posts where we want a `SPOILER_*` filename instead of
 * an auto-rendered `embed.image` URL; Discord only honours spoiler semantics on attached
 * files, not on URL embeds.
 */
async function fetchImageBytes(url: string): Promise<{ bytes: Uint8Array, type: string } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) {
      log.warn(`[discord] image fetch returned ${res.status} for ${url}`)
      return null
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      type: res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg',
    }
  }
  catch (err) {
    log.warn(`[discord] image fetch failed for ${url}: ${(err as Error).message}`)
    return null
  }
  finally { clearTimeout(timer) }
}

function imagekitUrl(filePath: string): string | null {
  if (!config.imagekit.urlEndpoint) return null
  return `${config.imagekit.urlEndpoint.replace(/\/$/, '')}${filePath}`
}

export async function notifyDiscord(outcome: ScanOutcome): Promise<boolean> {
  if (!config.discordWebhookUrl) {
    log.debug('[discord] no webhook configured, skipping')
    return false
  }
  if (!outcome.detection.isNuxt) return false

  const { domain, detection, finalUrl, title, ogImage, screenshotKey, ogImageKey, nsfwLabel } = outcome
  const versionLabel = detection.nuxtVersion ? ` v${detection.nuxtVersion}` : ''
  const signalList = detection.signals.map(s => `\`${s.name}\``).join(', ') || '_none_'
  const isNsfw = nsfwLabel === 'nsfw'

  interface DiscordEmbed {
    title: string
    url: string
    description: string
    color: number
    fields: Array<{ name: string, value: string, inline?: boolean }>
    timestamp: string
    image?: { url: string }
  }

  const embed: DiscordEmbed = {
    title: title || domain,
    url: finalUrl || `https://${domain}`,
    description: `Nuxt${versionLabel} detected on \`${domain}\`${isNsfw ? ' — image hidden as spoiler (NSFW)' : ''}`,
    color: 0x00dc82,
    fields: [
      { name: 'Confidence', value: String(detection.confidence), inline: true },
      { name: 'Version', value: detection.nuxtVersion || 'unknown', inline: true },
      { name: 'Signals', value: signalList },
    ],
    timestamp: new Date().toISOString(),
  }

  const form = new FormData()

  if (isNsfw) {
    // Discord only honours spoiler semantics on attached files (`SPOILER_*` filename),
    // not on URL-shaped `embed.image`. Fetch the ImageKit copy and attach it.
    const sourceFilePath = screenshotKey || ogImageKey
    const sourceUrl = sourceFilePath ? imagekitUrl(sourceFilePath) : null
    if (sourceUrl) {
      const img = await fetchImageBytes(sourceUrl)
      if (img) {
        const ext = img.type === 'image/png' ? 'png' : 'jpg'
        const blob = new Blob([Buffer.from(img.bytes)], { type: img.type })
        form.set('files[0]', blob, `SPOILER_${domain}.${ext}`)
        embed.image = { url: `attachment://SPOILER_${domain}.${ext}` }
      }
    }
  }
  else if (ogImageKey) {
    // Prefer ImageKit URL when available; falls through to upstream og:image otherwise.
    const url = imagekitUrl(ogImageKey)
    if (url) embed.image = { url }
  }
  else if (screenshotKey) {
    const url = imagekitUrl(screenshotKey)
    if (url) embed.image = { url }
  }
  else if (ogImage) {
    embed.image = { url: ogImage }
  }

  form.set('payload_json', JSON.stringify({ embeds: [embed] }))

  const res = await fetch(config.discordWebhookUrl, { method: 'POST', body: form })
  if (!res.ok) {
    log.error(`[discord] webhook failed: ${res.status} ${await res.text().catch(() => '')}`)
    return false
  }
  return true
}

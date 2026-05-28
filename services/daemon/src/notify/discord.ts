import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { config } from '../config.ts'
import { log } from '../log.ts'
import type { ScanOutcome } from '../scan/index.ts'

export async function notifyDiscord(outcome: ScanOutcome): Promise<boolean> {
  if (!config.discordWebhookUrl) {
    log.debug('[discord] no webhook configured, skipping')
    return false
  }
  if (!outcome.detection.isNuxt) return false

  const { domain, detection, finalUrl, title, screenshotPath, ogImage } = outcome
  const versionLabel = detection.nuxtVersion ? ` v${detection.nuxtVersion}` : ''
  const signalList = detection.signals.map(s => `\`${s.name}\``).join(', ') || '_none_'

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
    description: `Nuxt${versionLabel} detected on \`${domain}\``,
    color: 0x00dc82,
    fields: [
      { name: 'Confidence', value: String(detection.confidence), inline: true },
      { name: 'Version', value: detection.nuxtVersion || 'unknown', inline: true },
      { name: 'Signals', value: signalList },
    ],
    timestamp: new Date().toISOString(),
  }

  const form = new FormData()

  if (ogImage) {
    embed.image = { url: ogImage }
  }
  else if (screenshotPath) {
    try {
      const buf = await readFile(screenshotPath)
      const blob = new Blob([new Uint8Array(buf)], { type: 'image/jpeg' })
      form.set('files[0]', blob, basename(screenshotPath))
      embed.image = { url: `attachment://${basename(screenshotPath)}` }
    } catch (err) {
      log.warn(`[discord] could not attach screenshot ${screenshotPath}`, (err as Error).message)
    }
  }
  form.set('payload_json', JSON.stringify({ embeds: [embed] }))

  const res = await fetch(config.discordWebhookUrl, { method: 'POST', body: form })
  if (!res.ok) {
    log.error(`[discord] webhook failed: ${res.status} ${await res.text().catch(() => '')}`)
    return false
  }
  return true
}

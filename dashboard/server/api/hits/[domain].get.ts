import { getDb, type ScanRow, type DomainRow, type NotificationRow } from '../../utils/db'
import { imageSourcesFor } from '../../utils/image-url'

export default defineEventHandler((event) => {
  const domain = getRouterParam(event, 'domain')
  if (!domain) throw createError({ statusCode: 400, statusMessage: 'domain required' })

  const db = getDb()
  const scan = db.prepare(`SELECT * FROM scans WHERE domain = ?`).get(domain) as unknown as ScanRow | undefined
  if (!scan) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const seen = db.prepare(`SELECT * FROM domains WHERE domain = ?`).get(domain) as unknown as DomainRow | undefined
  const notifications = db.prepare(`SELECT * FROM notifications WHERE domain = ? ORDER BY posted_at`).all(domain) as unknown as NotificationRow[]
  const rank = (db.prepare(
    `SELECT rank FROM tranco_rank WHERE domain = ? OR domain = REPLACE(?, 'www.', '') LIMIT 1`,
  ).get(domain, domain) as { rank: number } | undefined)?.rank ?? null

  return {
    rank,
    domain: scan.domain,
    isNuxt: !!scan.is_nuxt,
    scannedAt: scan.scanned_at,
    version: scan.nuxt_version,
    confidence: scan.confidence,
    signals: (() => { try { return JSON.parse(scan.signals) as Array<{ name: string, weight: number, detail?: string }> } catch { return [] } })(),
    finalUrl: scan.final_url,
    title: scan.title,
    error: scan.error,
    image: imageSourcesFor(scan.domain, scan.og_image, scan.screenshot_path, scan.screenshot_key, scan.og_image_key),
    redirectedTo: scan.redirected_to,
    firstSeenAt: seen?.first_seen_at ?? null,
    lastSeenAt: seen?.last_seen_at ?? null,
    seenCount: seen?.seen_count ?? null,
    notifications: notifications.map(n => ({ channel: n.channel, postedAt: n.posted_at })),
  }
})

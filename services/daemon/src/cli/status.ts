#!/usr/bin/env node
/**
 * Read-only status dump for one domain. Pulls the stored scan row, the seen/notification
 * sidecar tables, and the optional Tranco rank, then formats them for human reading. No
 * scanner/ImageKit/network calls; this is a pure DB query suitable for `fly ssh console`
 * spot-checks.
 *
 * Use `--json` to get a single object instead of formatted lines.
 */
import { parseArgs } from 'node:util'
import { config } from '../config.ts'
import { db } from '../store.ts'

const USAGE = `usage: status [--json] <domain>`

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
})

if (values.help || positionals.length === 0) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(values.help ? 0 : 2)
}

const raw = positionals[0]!
const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()

interface ScanRow {
  domain: string
  scanned_at: number | null
  is_nuxt: number | null
  nuxt_version: string | null
  confidence: number | null
  signals: string | null
  final_url: string | null
  title: string | null
  screenshot_key: string | null
  og_image_key: string | null
  og_image: string | null
  nsfw_label: 'safe' | 'suggestive' | 'nsfw' | null
  nsfw_score: number | null
  nsfw_categories: string | null
  nsfw_classified_at: number | null
  redirected_to: string | null
  error: string | null
}
interface DomainRow {
  first_seen_at: number
  last_seen_at: number
  seen_count: number
}
interface NotificationRow { channel: string, posted_at: number }

const scan = db.prepare(`SELECT * FROM scans WHERE domain = ?`).get(domain) as unknown as ScanRow | undefined
const seen = db.prepare(`SELECT first_seen_at, last_seen_at, seen_count FROM domains WHERE domain = ?`).get(domain) as unknown as DomainRow | undefined
const notifications = db.prepare(`SELECT channel, posted_at FROM notifications WHERE domain = ? ORDER BY posted_at`).all(domain) as unknown as NotificationRow[]
// tranco_rank is populated by `pnpm ingest-tranco` and may not exist in a fresh dev db.
let rank: number | null = null
try {
  rank = (db.prepare(
    `SELECT rank FROM tranco_rank WHERE domain = ? OR domain = REPLACE(?, 'www.', '') LIMIT 1`,
  ).get(domain, domain) as { rank: number } | undefined)?.rank ?? null
}
catch (err) {
  if (!/no such table/i.test((err as Error).message)) throw err
}

if (!scan && !seen) {
  process.stderr.write(`no record for ${domain}\n`)
  process.exit(1)
}

if (values.json) {
  process.stdout.write(`${JSON.stringify({ domain, scan, seen, notifications, rank }, null, 2)}\n`)
  process.exit(0)
}

function imagekitUrl(filePath: string | null): string | null {
  if (!filePath) return null
  // Fall back to showing the bucket key alone when the endpoint isn't configured (e.g.
  // a fresh dev environment), so the user can still see whether an upload landed.
  if (!config.imagekit.urlEndpoint) return `${filePath}  (no IMAGEKIT_URL_ENDPOINT set)`
  return `${config.imagekit.urlEndpoint.replace(/\/$/, '')}${filePath}`
}

function fmtTime(ms: number | null): string {
  if (!ms) return '-'
  const iso = new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
  const delta = Date.now() - ms
  return `${iso} (${fmtAge(delta)})`
}

function fmtAge(deltaMs: number): string {
  const s = Math.floor(deltaMs / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 14) return `${d}d ago`
  return `${Math.floor(d / 7)}w ago`
}

function row(label: string, value: string | null | undefined): void {
  process.stdout.write(`  ${label.padEnd(22)} ${value ?? '-'}\n`)
}

process.stdout.write(`\n${domain}\n`)
if (scan) {
  row('scanned', fmtTime(scan.scanned_at))
  if (scan.is_nuxt) {
    const v = scan.nuxt_version ? `v${scan.nuxt_version}` : 'version ?'
    row('nuxt', `yes  ${v}  confidence=${scan.confidence}`)
    try {
      const sigs = JSON.parse(scan.signals || '[]') as Array<{ name: string }>
      row('signals', sigs.map(s => s.name).join(', ') || '-')
    }
    catch { row('signals', '(unparseable)') }
  }
  else {
    row('nuxt', 'no')
  }
  if (scan.redirected_to) row('redirect', scan.redirected_to)
  if (scan.final_url && scan.final_url !== `https://${domain}/`) row('final url', scan.final_url)
  if (scan.title) row('title', scan.title)
  if (scan.error) row('error', scan.error)
}

process.stdout.write(`\nimages\n`)
if (scan) {
  row('imagekit screenshot', imagekitUrl(scan.screenshot_key) ?? '-')
  row('imagekit og:image', imagekitUrl(scan.og_image_key) ?? '-')
  row('upstream og:image', scan.og_image ?? '-')
  if (scan.nsfw_label) {
    const score = scan.nsfw_score != null ? `  score=${scan.nsfw_score.toFixed(3)}` : ''
    const when = scan.nsfw_classified_at ? `  classified ${fmtAge(Date.now() - scan.nsfw_classified_at)}` : ''
    row('nsfw', `${scan.nsfw_label}${score}${when}`)
    if (scan.nsfw_categories) {
      try {
        const cats = JSON.parse(scan.nsfw_categories) as Record<string, unknown>
        const parts = Object.entries(cats)
          .map(([k, v]) => typeof v === 'number' ? `${k}=${v.toFixed(2)}` : `${k}=${String(v)}`)
          .join(' ')
        row('  categories', parts)
      }
      catch { /* noop */ }
    }
  }
  else {
    row('nsfw', 'unclassified')
  }
}
else {
  row('(no scan recorded yet)', null)
}

process.stdout.write(`\nactivity\n`)
if (seen) {
  row('first seen', fmtTime(seen.first_seen_at))
  row('last seen', fmtTime(seen.last_seen_at))
  row('mentioned', `${seen.seen_count} time${seen.seen_count === 1 ? '' : 's'}`)
}
else {
  row('(never seen on bluesky)', null)
}
if (rank != null) row('tranco rank', `#${rank.toLocaleString()}`)

if (notifications.length > 0) {
  process.stdout.write(`\nnotifications\n`)
  for (const n of notifications) {
    row(n.channel, fmtTime(n.posted_at))
  }
}

process.stdout.write('\n')

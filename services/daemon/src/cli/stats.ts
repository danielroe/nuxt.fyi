#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'


const dbPath = join(config.dataDir, 'nuxt-fyi.db')
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} - run \`pnpm start\` first`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })

interface CountRow { c: number }
interface ScanRow {
  domain: string
  confidence: number
  nuxt_version: string | null
  signals: string
  title: string | null
  scanned_at: number
  is_nuxt: number
}
interface SignalListRow { signals: string }
interface RecentRow {
  domain: string
  confidence: number
  nuxt_version: string | null
  title: string | null
  scanned_at: number
}
interface NotifRow { domain: string, posted_at: number, channel: string }
interface ErrRow { domain: string, error: string }
interface SeenRow { domain: string, seen_count: number }

function count(sql: string): number {
  return (db.prepare(sql).get() as unknown as CountRow).c
}

function fmtTime(ms: number): string {
  if (!ms) return '-'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function fmtAge(ms: number): string {
  if (!ms) return '-'
  const delta = Date.now() - ms
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const domains = count('SELECT COUNT(*) AS c FROM domains')
const scans = count('SELECT COUNT(*) AS c FROM scans')
const nuxtHits = count('SELECT COUNT(*) AS c FROM scans WHERE is_nuxt = 1')
const errors = count('SELECT COUNT(*) AS c FROM scans WHERE error IS NOT NULL')
const notified = count('SELECT COUNT(*) AS c FROM notifications')
const pendingScan = count(`
  SELECT COUNT(*) AS c FROM domains d
  WHERE NOT EXISTS (SELECT 1 FROM scans s WHERE s.domain = d.domain)
`)
const dueForRescan = count(`
  SELECT COUNT(*) AS c FROM scans
  WHERE scanned_at < ${Date.now() - config.rescanAfterMs}
`)

console.log('═══ nuxt.fyi stats ═══')
console.log(`  domains observed:   ${domains.toLocaleString()}`)
console.log(`  scans completed:    ${scans.toLocaleString()}`)
console.log(`  scans pending:      ${pendingScan.toLocaleString()}  (seen, never scanned)`)
console.log(`  scans due re-run:   ${dueForRescan.toLocaleString()}  (older than RESCAN_AFTER_MS)`)
console.log(`  scan errors:        ${errors.toLocaleString()}`)
console.log(`  Nuxt confirmed:     ${nuxtHits.toLocaleString()}`)
console.log(`  Discord notified:   ${notified.toLocaleString()}`)

if (nuxtHits > 0) {
  const versionRows = db.prepare(`
    SELECT COALESCE(nuxt_version, 'unknown') AS v, COUNT(*) AS c
    FROM scans WHERE is_nuxt = 1
    GROUP BY v ORDER BY c DESC
  `).all() as Array<{ v: string, c: number }>
  console.log('\n  versions:')
  for (const r of versionRows) console.log(`    ${r.v.padEnd(12)} ${r.c}`)

  const sigRows = db.prepare(`SELECT signals FROM scans WHERE is_nuxt = 1`).all() as unknown as SignalListRow[]
  const sigCounts = new Map<string, number>()
  for (const row of sigRows) {
    for (const s of JSON.parse(row.signals) as Array<{ name: string }>) {
      sigCounts.set(s.name, (sigCounts.get(s.name) ?? 0) + 1)
    }
  }
  console.log('\n  signals that fired on Nuxt hits:')
  for (const [name, c] of [...sigCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name.padEnd(36)} ${c}`)
  }

  const recent = db.prepare(`
    SELECT domain, confidence, nuxt_version, title, scanned_at
    FROM scans WHERE is_nuxt = 1
    ORDER BY scanned_at DESC LIMIT 10
  `).all() as unknown as RecentRow[]
  console.log('\n  most recent Nuxt hits:')
  for (const r of recent) {
    const v = r.nuxt_version ? `v${r.nuxt_version}` : '?'
    console.log(`    ${fmtAge(r.scanned_at).padEnd(8)} conf=${String(r.confidence).padEnd(3)} ${v.padEnd(10)} ${r.domain}`)
  }
}

if (notified > 0) {
  const notif = db.prepare(`
    SELECT domain, posted_at, channel FROM notifications ORDER BY posted_at DESC LIMIT 5
  `).all() as unknown as NotifRow[]
  console.log('\n  recently notified:')
  for (const n of notif) {
    console.log(`    ${fmtAge(n.posted_at).padEnd(8)} ${n.channel.padEnd(8)} ${n.domain}`)
  }
}

if (errors > 0) {
  const errRows = db.prepare(`
    SELECT domain, error FROM scans WHERE error IS NOT NULL ORDER BY scanned_at DESC LIMIT 5
  `).all() as unknown as ErrRow[]
  console.log('\n  recent errors:')
  for (const e of errRows) {
    console.log(`    ${e.domain.padEnd(40)} ${e.error.slice(0, 60)}`)
  }
}

const topSeen = db.prepare(`
  SELECT domain, seen_count FROM domains ORDER BY seen_count DESC LIMIT 5
`).all() as unknown as SeenRow[]
if (topSeen.length > 0) {
  console.log('\n  most-linked domains (post-skiplist):')
  for (const r of topSeen) {
    console.log(`    ${String(r.seen_count).padStart(4)}  ${r.domain}`)
  }
}

console.log(`\n  last scan: ${fmtTime((db.prepare('SELECT MAX(scanned_at) AS c FROM scans').get() as unknown as CountRow).c)}`)

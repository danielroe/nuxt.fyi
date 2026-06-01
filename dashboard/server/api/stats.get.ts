import type { StatsResponse, VersionBucket } from '#shared/api'
import { getDb } from '../utils/db'
import { fixtureStats } from '../utils/fixtures'
import { getPublishedNuxtVersions } from '../utils/nuxt-versions'

interface CountRow { c: number }
interface SignalListRow { signals: string }

export default defineEventHandler((): StatsResponse => {
  if (process.env.NUXT_FIXTURES) return fixtureStats
  const db = getDb()
  const c = (sql: string): number => (db.prepare(sql).get() as unknown as CountRow).c
  const published = getPublishedNuxtVersions()

  const stats = {
    domains: c('SELECT COUNT(*) AS c FROM domains'),
    scans: c('SELECT COUNT(*) AS c FROM scans'),
    nuxtHits: c('SELECT COUNT(*) AS c FROM scans WHERE is_nuxt = 1'),
    errors: c('SELECT COUNT(*) AS c FROM scans WHERE error IS NOT NULL'),
    notifications: c('SELECT COUNT(*) AS c FROM notifications'),
    pendingScan: c(`
      SELECT COUNT(*) AS c FROM domains d
      WHERE NOT EXISTS (SELECT 1 FROM scans s WHERE s.domain = d.domain)
    `),
    lastScanAt: (db.prepare('SELECT MAX(scanned_at) AS c FROM scans').get() as unknown as CountRow).c,
  }

  const rawVersions = db.prepare(`
    SELECT COALESCE(nuxt_version, 'unknown') AS version, COUNT(*) AS count
    FROM scans WHERE is_nuxt = 1
    GROUP BY version ORDER BY count DESC
  `).all() as unknown as Array<{ version: string, count: number }>

  // Versions split into three buckets used by the dashboard's chart vs. sidebar:
  //   'published'    - found in npm's nuxt registry
  //   'off-registry' - semver-shaped but not in npm (detection leak)
  //   'unknown'      - Nuxt was detected but no version could be sniffed
  // When the registry table is empty (first boot before ingest runs), every detected version
  // falls back to 'published' so the dataset isn't silently mislabelled.
  const haveRegistry = published.size > 0
  const versions = rawVersions.map((row) => {
    let bucket: VersionBucket
    if (row.version === 'unknown') bucket = 'unknown'
    else if (!haveRegistry) bucket = 'published'
    else bucket = published.has(row.version) ? 'published' : 'off-registry'
    return { ...row, bucket }
  })

  const sigRows = db.prepare(`SELECT signals FROM scans WHERE is_nuxt = 1`).all() as unknown as SignalListRow[]
  const signalCounts = new Map<string, number>()
  for (const row of sigRows) {
    try {
      for (const s of JSON.parse(row.signals) as Array<{ name: string }>) {
        signalCounts.set(s.name, (signalCounts.get(s.name) ?? 0) + 1)
      }
    } catch { /* malformed; skip */ }
  }
  const signals = [...signalCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  const notificationChannels = db.prepare(`
    SELECT channel, COUNT(*) AS count FROM notifications GROUP BY channel
  `).all() as unknown as Array<{ channel: string, count: number }>

  return { stats, versions, signals, notificationChannels }
})

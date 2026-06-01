import { defineCachedHandler } from 'nitro/cache'
import { getQuery } from 'nitro/h3'
import type { RecentResponse } from '#shared/api'
import { getDb } from '../utils/db'

/** Allowlist mapping URL-friendly sort names to SQL fragments. */
const SORTS: Record<string, string> = {
  last_seen: 'd.last_seen_at',
  first_seen: 'd.first_seen_at',
  seen_count: 'd.seen_count',
  scanned_at: 's.scanned_at',
  confidence: 's.confidence',
}

const FILTERS = new Set(['all', 'nuxt', 'not-nuxt', 'error', 'pending'])

export default defineCachedHandler((event): RecentResponse => {
  const query = getQuery(event)
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100))

  const sortKey = typeof query.sort === 'string' && SORTS[query.sort] ? query.sort : 'last_seen'
  const orderRaw = typeof query.order === 'string' ? query.order.toLowerCase() : 'desc'
  const order = orderRaw === 'asc' ? 'ASC' : 'DESC'
  const filter = typeof query.filter === 'string' && FILTERS.has(query.filter) ? query.filter : 'all'

  const sortCol = SORTS[sortKey]!
  // Push unscanned rows to the end regardless of direction when sorting by a scans column.
  const orderClause = sortCol.startsWith('s.')
    ? `${sortCol} IS NULL, ${sortCol} ${order}, d.last_seen_at DESC`
    : `${sortCol} ${order}`

  let where = '1 = 1'
  switch (filter) {
    case 'nuxt': where = 's.is_nuxt = 1'; break
    case 'not-nuxt': where = 's.is_nuxt = 0'; break
    case 'error': where = 's.error IS NOT NULL'; break
    case 'pending': where = 's.domain IS NULL'; break
  }

  const db = getDb()
  const rows = db.prepare(`
    SELECT d.domain, d.first_seen_at, d.last_seen_at, d.seen_count,
           s.is_nuxt, s.nuxt_version, s.confidence, s.scanned_at, s.error
    FROM domains d
    LEFT JOIN scans s ON s.domain = d.domain
    WHERE ${where}
    ORDER BY ${orderClause}
    LIMIT ?
  `).all(limit) as unknown as Array<{
    domain: string
    first_seen_at: number
    last_seen_at: number
    seen_count: number
    is_nuxt: number | null
    nuxt_version: string | null
    confidence: number | null
    scanned_at: number | null
    error: string | null
  }>

  return {
    sort: sortKey,
    order: order.toLowerCase(),
    filter,
    rows: rows.map(r => ({
      domain: r.domain,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      seenCount: r.seen_count,
      scanned: r.scanned_at !== null,
      isNuxt: r.is_nuxt === 1,
      version: r.nuxt_version,
      confidence: r.confidence,
      scannedAt: r.scanned_at,
      error: r.error,
    })),
  }
}, {
  swr: true,
  maxAge: 1,
  getKey: event => {
    const query = getQuery(event)
    return `recent:${query.limit ?? 100}:${query.sort ?? 'last_seen'}:${query.order ?? 'desc'}:${query.filter ?? 'all'}`
  }
})

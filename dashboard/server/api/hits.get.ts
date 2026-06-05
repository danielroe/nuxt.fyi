import type { SQLInputValue } from 'node:sqlite'
import { defineCachedHandler } from 'nitro/cache'
import { getQuery } from 'nitro/h3'
import type { HitsResponse, Signal } from '#shared/api'
import { sanitizeSearchTerm } from '#shared/utils/search-term'
import { getDb, type ScanRow } from '../utils/db'
import { imageSourcesFor } from '../utils/image-url'

const PAGE_SIZE = 30

// Allowlist of safe sort columns. `tranco_rank_value` is the COALESCE'd alias used in the
// SELECT to avoid SQLite's bare `rank` ambiguity when both joins are in scope.
const SORTS: Record<string, string> = {
  scanned_at: 's.scanned_at',
  confidence: 's.confidence',
  seen_count: 'd.seen_count',
  rank: 'tranco_rank_value',
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => `\\${m}`)
}

export default defineCachedHandler((event): HitsResponse => {
  const db = getDb()
  const query = getQuery(event)
  const page = Math.max(1, Number(query.page) || 1)
  const version = typeof query.version === 'string' ? query.version : null

  const sortKey = typeof query.sort === 'string' && SORTS[query.sort] ? query.sort : 'scanned_at'
  const orderRaw = typeof query.order === 'string' ? query.order.toLowerCase() : 'desc'
  const order = orderRaw === 'asc' ? 'ASC' : 'DESC'
  const sortCol = SORTS[sortKey]!
  // Rank 1 = most popular, so the natural order is ascending; unranked rows go last.
  const isRank = sortKey === 'rank'
  const rankOrder = isRank ? (order === 'DESC' ? 'DESC' : 'ASC') : order
  const orderClause = isRank
    ? `${sortCol} IS NULL, ${sortCol} ${rankOrder}, s.scanned_at DESC`
    : `${sortCol} ${order}`

  let where = `s.is_nuxt = 1 AND (s.screenshot_key IS NOT NULL OR s.og_image_key IS NOT NULL)`
  const params: SQLInputValue[] = []
  if (version) {
    if (version === 'unknown') {
      where += ` AND s.nuxt_version IS NULL`
    } else {
      where += ` AND s.nuxt_version = ?`
      params.push(version)
    }
  }

  const q = sanitizeSearchTerm(query.q)
  if (q) {
    where += ` AND (LOWER(s.domain) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(s.title, '')) LIKE ? ESCAPE '\\')`
    const term = `%${escapeLike(q).toLowerCase()}%`
    params.push(term, term)
  }

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM scans s WHERE ${where}`).get(...params) as unknown as { c: number }).c

  const rows = db.prepare(`
    SELECT s.domain, s.scanned_at, s.nuxt_version, s.confidence, s.signals,
           s.final_url, s.title, s.og_image,
           s.screenshot_key, s.og_image_key, s.nsfw_label,
           d.seen_count,
           COALESCE(tw.rank, ta.rank) AS tranco_rank_value
    FROM scans s
    LEFT JOIN domains d     ON d.domain  = s.domain
    LEFT JOIN tranco_rank tw ON tw.domain = s.domain
    LEFT JOIN tranco_rank ta ON ta.domain = REPLACE(s.domain, 'www.', '')
    WHERE ${where}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as Array<Pick<ScanRow, 'domain' | 'scanned_at' | 'nuxt_version' | 'confidence' | 'signals' | 'final_url' | 'title' | 'og_image' | 'screenshot_key' | 'og_image_key' | 'nsfw_label'> & { seen_count: number | null, tranco_rank_value: number | null }>

  return {
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.ceil(total / PAGE_SIZE),
    sort: sortKey,
    order: order.toLowerCase(),
    hits: rows.map(r => ({
      domain: r.domain,
      scannedAt: r.scanned_at,
      version: r.nuxt_version,
      confidence: r.confidence,
      signals: (() => { try { return JSON.parse(r.signals) as Signal[] } catch { return [] } })(),
      finalUrl: r.final_url,
      title: r.title,
      image: imageSourcesFor(r.og_image, r.screenshot_key, r.og_image_key, r.nsfw_label),
      seenCount: r.seen_count,
      rank: r.tranco_rank_value,
    })),
  }
}, {
  swr: true,
  maxAge: 1,
  getKey: event => {
    const query = getQuery(event)
    return `hits:${query.page ?? 1}:${query.version ?? 'all'}:${query.sort ?? 'scanned_at'}:${query.order ?? 'desc'}:${query.q ?? ''}`
  }
})

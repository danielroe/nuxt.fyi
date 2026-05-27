import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

let cached: DatabaseSync | null = null
let loggedPath = false

function dbPath(): string {
  return join(resolve(useRuntimeConfig().dataDir), 'nuxt-fyi.db')
}

/**
 * Opens the daemon's SQLite database read-only. Cached for the process lifetime; safe
 * across concurrent Nitro request handlers because WAL mode lets readers proceed without
 * blocking each other or the writer.
 */
export function getDb(): DatabaseSync {
  if (cached) return cached
  const path = dbPath()
  if (!loggedPath) {
    console.log(`[dashboard] sqlite path: ${path}`)
    loggedPath = true
  }
  if (!existsSync(path)) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Service Unavailable',
      message: `daemon database not yet available at ${path}`,
    })
  }
  cached = new DatabaseSync(path, { readOnly: true })
  return cached
}

export interface ScanRow {
  domain: string
  scanned_at: number
  is_nuxt: number
  nuxt_version: string | null
  confidence: number
  signals: string
  final_url: string | null
  title: string | null
  screenshot_path: string | null
  og_image: string | null
  redirected_to: string | null
  error: string | null
}

export interface DomainRow {
  domain: string
  first_seen_at: number
  last_seen_at: number
  seen_count: number
}

export interface NotificationRow {
  domain: string
  channel: string
  posted_at: number
}

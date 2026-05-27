import { getDb } from './db'

/** All Nuxt versions published to npm, as written by the daemon's ingest-nuxt-versions script. */
export function getPublishedNuxtVersions(): Set<string> {
  const db = getDb()
  try {
    const rows = db.prepare('SELECT version FROM nuxt_versions').all() as unknown as Array<{ version: string }>
    return new Set(rows.map(r => r.version))
  }
  catch {
    return new Set()
  }
}

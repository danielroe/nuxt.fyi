#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DATA_DIR = resolve(process.env.DATA_DIR || '../../data')
const DB_PATH = join(DATA_DIR, 'nuxt-fyi.db')
const REGISTRY_URL = 'https://registry.npmjs.org/nuxt'

if (!existsSync(DB_PATH)) {
  console.error(`[nuxt-versions] no database at ${DB_PATH}`)
  process.exit(1)
}

const res = await fetch(REGISTRY_URL, {
  headers: { accept: 'application/vnd.npm.install-v1+json' },
})
if (!res.ok) {
  console.error(`[nuxt-versions] registry returned ${res.status}`)
  process.exit(2)
}
const data = await res.json()
const versions = Object.keys(data.versions ?? {})

const db = new DatabaseSync(DB_PATH)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 30000;
  CREATE TABLE IF NOT EXISTS nuxt_versions (
    version    TEXT PRIMARY KEY,
    updated_at INTEGER NOT NULL
  );
`)

const now = Date.now()
db.exec('BEGIN IMMEDIATE')
db.exec('DELETE FROM nuxt_versions')
const insert = db.prepare('INSERT INTO nuxt_versions (version, updated_at) VALUES (?, ?)')
for (const v of versions) insert.run(v, now)
db.exec('COMMIT')

console.log(`[nuxt-versions] inserted ${versions.length} published versions`)

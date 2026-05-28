#!/usr/bin/env node
// Downloads the Tranco daily top-1M list and writes one row per domain into the
// `tranco_rank` table. Tranco aggregates Cisco Umbrella + Majestic + Quantcast etc.
// into a single popularity ranking; we use it to surface "popular" Nuxt sites.
//
// Idempotent: the table is wiped and rewritten each run, transactionally. We only
// store the registrable domain (eTLD+1) since that's what we match against in scans.
//
// Run from cron (or a GitHub Action / Fly scheduled machine) once a day:
//   node scripts/ingest-tranco.mjs

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'

const TRANCO_URL = 'https://tranco-list.eu/top-1m.csv.zip'
const DATA_DIR = resolve(process.env.DATA_DIR || '../../data')
const LEGACY_DB = join(DATA_DIR, 'nuxt-eye.db')
const CURRENT_DB = join(DATA_DIR, 'nuxt-fyi.db')
const DB_PATH = existsSync(CURRENT_DB) ? CURRENT_DB : LEGACY_DB

if (!existsSync(DB_PATH)) {
  console.error(`[tranco] no database at ${DB_PATH}`)
  process.exit(1)
}

const work = join(tmpdir(), `nuxt-fyi-tranco-${Date.now()}`)
mkdirSync(work, { recursive: true })
const zipPath = join(work, 'top-1m.csv.zip')
const csvPath = join(work, 'top-1m.csv')

console.log(`[tranco] downloading ${TRANCO_URL}`)
execSync(`curl -fsSL "${TRANCO_URL}" -o "${zipPath}"`, { stdio: 'inherit' })
console.log(`[tranco] unpacking`)
execSync(`unzip -q -o "${zipPath}" -d "${work}"`, { stdio: 'inherit' })

console.log(`[tranco] opening ${DB_PATH}`)
const db = new DatabaseSync(DB_PATH)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 30000;
  CREATE TABLE IF NOT EXISTS tranco_rank (
    domain     TEXT PRIMARY KEY,
    rank       INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tranco_rank_rank_idx ON tranco_rank(rank);
`)

const csv = readFileSync(csvPath, 'utf8')
const now = Date.now()
let count = 0

const CHUNK = 10_000
const insert = db.prepare('INSERT INTO tranco_rank (domain, rank, updated_at) VALUES (?, ?, ?)')

db.exec('BEGIN IMMEDIATE')
db.exec('DELETE FROM tranco_rank')
db.exec('COMMIT')

let pos = 0
let inTx = false
let chunkRows = 0
function beginChunk() { db.exec('BEGIN IMMEDIATE'); inTx = true; chunkRows = 0 }
function commitChunk() { if (inTx) { db.exec('COMMIT'); inTx = false } }

beginChunk()
while (pos < csv.length) {
  const newline = csv.indexOf('\n', pos)
  const line = (newline === -1 ? csv.slice(pos) : csv.slice(pos, newline)).trim()
  pos = newline === -1 ? csv.length : newline + 1
  if (!line) continue
  const comma = line.indexOf(',')
  if (comma === -1) continue
  const rank = Number(line.slice(0, comma))
  const domain = line.slice(comma + 1).toLowerCase().trim()
  if (!Number.isFinite(rank) || !domain) continue
  insert.run(domain, rank, now)
  count++
  chunkRows++
  if (chunkRows >= CHUNK) {
    commitChunk()
    await new Promise(r => setImmediate(r))
    beginChunk()
  }
}
commitChunk()

rmSync(work, { recursive: true, force: true })

console.log(`[tranco] inserted ${count.toLocaleString()} domains`)

#!/usr/bin/env node
/**
 * Forces a TRUNCATE checkpoint against the daemon's SQLite database. The daemon already
 * runs a 60s checkpoint loop in `store.ts`, but a long-lived reader (the dashboard's
 * cached read-only connection) can block the checkpoint indefinitely and let the WAL
 * grow unbounded.
 *
 * Run this from `fly ssh console -a nuxt-fyi` when the `-wal` file has grown out of
 * proportion (more than a few MB) to fold its pages back into the main db file.
 *
 *   node scripts/wal-checkpoint.mjs
 *
 * Output is `[ { busy, log, checkpointed } ]`. `busy: 0` means it succeeded; `log`
 * and `checkpointed` are page counts (default page size is 4096 bytes). A non-zero
 * `busy` means a reader was blocking; retry, or restart the dashboard process and
 * retry. The script is read-mostly: it doesn't mutate any application data, just
 * shuffles bytes between the WAL and the main file.
 */
import { DatabaseSync } from 'node:sqlite'
import { resolve, join } from 'node:path'

const dataDir = resolve(process.env.NUXT_DATA_DIR || '../../data')
const dbPath = join(dataDir, 'nuxt-fyi.db')

const db = new DatabaseSync(dbPath)
const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
console.log(`[wal-checkpoint] ${dbPath}:`, result)
db.close()

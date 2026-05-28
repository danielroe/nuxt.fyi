import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'

mkdirSync(config.dataDir, { recursive: true })

export const DB_PATH = join(config.dataDir, 'nuxt-fyi.db')
export const db = new DatabaseSync(DB_PATH)

// Hard cap on the WAL file size
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024

// WAL lets readers and the single writer run concurrently; NORMAL synchronous is the
// recommended pairing (durable across process crashes, not across power loss).
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 30000;
  PRAGMA wal_autocheckpoint = 4000;
  PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};
`)

const WAL_PATH = `${DB_PATH}-wal`
/** Threshold above which the periodic checkpoint loop warns. Set well below the hard
 *  `journal_size_limit` cap so we get early warning before SQLite has to force a
 *  truncation. */
const WAL_WARN_BYTES = 32 * 1024 * 1024

const WAL_TRUNCATE_INTERVAL_MS = 60_000
function truncateWal(): void {
  let walBytes = 0
  try { walBytes = statSync(WAL_PATH).size } catch { /* WAL not created yet */ }
  if (walBytes > WAL_WARN_BYTES) {
    console.warn(`[store] WAL is ${Math.round(walBytes / 1024 / 1024)}MB before checkpoint; a long-lived reader may be blocking the checkpoint loop`)
  }
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  catch (err) {
    // Checkpoint failures are non-fatal: the WAL just stays large until the next attempt.
    console.warn('[store] wal_checkpoint failed:', (err as Error).message)
  }
}
truncateWal()
const walTimer = setInterval(truncateWal, WAL_TRUNCATE_INTERVAL_MS)
walTimer.unref()

db.exec(`
  CREATE TABLE IF NOT EXISTS domains (
    domain        TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    seen_count    INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS scans (
    domain          TEXT PRIMARY KEY,
    scanned_at      INTEGER NOT NULL,
    is_nuxt         INTEGER NOT NULL,
    nuxt_version    TEXT,
    confidence      INTEGER NOT NULL,
    signals         TEXT NOT NULL,
    final_url       TEXT,
    title           TEXT,
    screenshot_path TEXT,
    og_image        TEXT,
    redirected_to   TEXT,
    error           TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    domain     TEXT NOT NULL,
    channel    TEXT NOT NULL,
    posted_at  INTEGER NOT NULL,
    PRIMARY KEY (domain, channel)
  );
`)

// Idempotent forward migrations for columns added after the first release. SQLite has no
// ADD COLUMN IF NOT EXISTS, so we swallow the "duplicate column" error.
for (const ddl of [
  `ALTER TABLE scans ADD COLUMN og_image TEXT`,
  `ALTER TABLE scans ADD COLUMN redirected_to TEXT`,
  `ALTER TABLE scans ADD COLUMN screenshot_key TEXT`,
  `ALTER TABLE scans ADD COLUMN og_image_key TEXT`,
  `ALTER TABLE scans ADD COLUMN nsfw_label TEXT`,
  `ALTER TABLE scans ADD COLUMN nsfw_score REAL`,
  `ALTER TABLE scans ADD COLUMN nsfw_categories TEXT`,
  `ALTER TABLE scans ADD COLUMN nsfw_classified_at INTEGER`,
]) {
  try { db.exec(ddl) }
  catch (err) {
    if (!/duplicate column name/i.test((err as Error).message)) throw err
  }
}

const upsertDomainStmt = db.prepare(`
  INSERT INTO domains (domain, first_seen_at, last_seen_at, seen_count)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(domain) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    seen_count = seen_count + 1
`)

const getScanStmt = db.prepare(`SELECT * FROM scans WHERE domain = ?`)

const upsertScanStmt = db.prepare(`
  INSERT INTO scans (domain, scanned_at, is_nuxt, nuxt_version, confidence, signals, final_url, title, screenshot_path, og_image, redirected_to, error, screenshot_key, og_image_key, nsfw_label, nsfw_score, nsfw_categories, nsfw_classified_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(domain) DO UPDATE SET
    scanned_at = excluded.scanned_at,
    is_nuxt = excluded.is_nuxt,
    nuxt_version = excluded.nuxt_version,
    confidence = excluded.confidence,
    signals = excluded.signals,
    final_url = excluded.final_url,
    title = excluded.title,
    screenshot_path = excluded.screenshot_path,
    og_image = excluded.og_image,
    redirected_to = excluded.redirected_to,
    error = excluded.error,
    screenshot_key = excluded.screenshot_key,
    og_image_key = excluded.og_image_key,
    nsfw_label = excluded.nsfw_label,
    nsfw_score = excluded.nsfw_score,
    nsfw_categories = excluded.nsfw_categories,
    nsfw_classified_at = excluded.nsfw_classified_at
`)

const updateImageStmt = db.prepare(`
  UPDATE scans SET
    scanned_at = ?,
    final_url = ?,
    title = COALESCE(?, title),
    screenshot_path = ?,
    og_image = ?,
    screenshot_key = ?,
    og_image_key = ?,
    nsfw_label = COALESCE(?, nsfw_label),
    nsfw_score = COALESCE(?, nsfw_score),
    nsfw_categories = COALESCE(?, nsfw_categories),
    nsfw_classified_at = COALESCE(?, nsfw_classified_at),
    error = ?
  WHERE domain = ?
`)

const updateNsfwStmt = db.prepare(`
  UPDATE scans SET
    nsfw_label = ?,
    nsfw_score = ?,
    nsfw_categories = ?,
    nsfw_classified_at = ?
  WHERE domain = ?
`)

const hasNotifiedStmt = db.prepare(`SELECT 1 FROM notifications WHERE domain = ? AND channel = ?`)
const recordNotificationStmt = db.prepare(`
  INSERT OR REPLACE INTO notifications (domain, channel, posted_at) VALUES (?, ?, ?)
`)

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
  /** Set when the scan target redirected to a different registrable domain; the actual
   *  Nuxt detection was performed against that destination, not this row's domain. */
  redirected_to: string | null
  error: string | null
  /** ImageKit path (e.g. `/nuxt-fyi/screenshots/example.com.jpg`) for the screenshot
   *  uploaded at scan time. Null if upload failed or ImageKit isn't configured. */
  screenshot_key: string | null
  /** ImageKit path for the upstream og:image, re-uploaded so the dashboard can render
   *  it through the same provider as the screenshot. */
  og_image_key: string | null
  /** NSFW classification of the screenshot bytes. Null = unclassified (model unavailable,
   *  classification failed, or the row pre-dates classification). 'suggestive' renders
   *  normally on-site; 'nsfw' gets blurred with a click-to-reveal control. */
  nsfw_label: 'safe' | 'suggestive' | 'nsfw' | null
  /** Dominant-category score from nsfwjs, 0..1. Useful for tuning thresholds; not
   *  rendered. */
  nsfw_score: number | null
  /** JSON-stringified `{ Drawing, Hentai, Neutral, Porn, Sexy }` of raw nsfwjs scores,
   *  or `{ skipped: 'too-large', bytes: N }` when the image was too large to classify
   *  safely. */
  nsfw_categories: string | null
  /** When classification last ran (ms). */
  nsfw_classified_at: number | null
}

export function recordDomainSeen(domain: string): void {
  const now = Date.now()
  upsertDomainStmt.run(domain, now, now)
}

export function getScan(domain: string): ScanRow | undefined {
  return getScanStmt.get(domain) as ScanRow | undefined
}

/**
 * Partial update for the image columns only. Detection results (is_nuxt, nuxt_version,
 * confidence, signals) are deliberately left alone so a `--screenshot-only` rescan can't
 * accidentally flip a previously confirmed Nuxt hit because the site has since changed.
 * Title is updated only when the new fetch returned one; existing titles aren't blanked.
 */
export function recordRescanImage(input: {
  domain: string
  finalUrl: string
  title: string | null
  screenshotPath: string | null
  ogImage: string | null
  screenshotKey: string | null
  ogImageKey: string | null
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
  nsfwScore: number | null
  nsfwCategories: string | null
  nsfwClassifiedAt: number | null
  error: string | null
}): void {
  updateImageStmt.run(
    Date.now(),
    input.finalUrl,
    input.title,
    input.screenshotPath,
    input.ogImage,
    input.screenshotKey,
    input.ogImageKey,
    input.nsfwLabel,
    input.nsfwScore,
    input.nsfwCategories,
    input.nsfwClassifiedAt,
    input.error,
    input.domain,
  )
}

/**
 * Standalone NSFW classification update for the backfill script. Overwrites all four
 * NSFW columns unconditionally (unlike `recordRescanImage` which uses COALESCE) since
 * the caller has just computed fresh values.
 */
export function recordNsfwClassification(input: {
  domain: string
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
  nsfwScore: number | null
  nsfwCategories: string | null
}): void {
  updateNsfwStmt.run(
    input.nsfwLabel,
    input.nsfwScore,
    input.nsfwCategories,
    Date.now(),
    input.domain,
  )
}

export function recordScan(row: Omit<ScanRow, 'scanned_at'> & { scanned_at?: number }): void {
  upsertScanStmt.run(
    row.domain,
    row.scanned_at ?? Date.now(),
    row.is_nuxt,
    row.nuxt_version,
    row.confidence,
    row.signals,
    row.final_url,
    row.title,
    row.screenshot_path,
    row.og_image,
    row.redirected_to,
    row.error,
    row.screenshot_key,
    row.og_image_key,
    row.nsfw_label,
    row.nsfw_score,
    row.nsfw_categories,
    row.nsfw_classified_at,
  )
}

export function hasNotified(domain: string, channel: string): boolean {
  return !!hasNotifiedStmt.get(domain, channel)
}

export function recordNotification(domain: string, channel: string): void {
  recordNotificationStmt.run(domain, channel, Date.now())
}

const lastNotifiedStmt = db.prepare(
  `SELECT MAX(posted_at) AS at FROM notifications WHERE channel = ?`,
)
export function lastNotifiedAt(channel: string): number {
  const row = lastNotifiedStmt.get(channel) as { at: number | null } | undefined
  return row?.at ?? 0
}

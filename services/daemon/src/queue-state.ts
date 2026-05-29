import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { log } from './log.ts'

/**
 * Persists pending queue work across daemon restarts. Without this, every `fly deploy`
 * drops anything that's been queued from the Jetstream firehose but hasn't started
 * scanning yet — on a Nuxt-heavy traffic burst that can be hundreds of domains.
 *
 * The shape is intentionally minimal: just domain strings for detection, and the same
 * shape (plus the resolved final URL + candidate og:image) for capture. We re-run
 * detection on restart rather than trusting a stale saved result, but capture jobs
 * carry enough state to skip straight to the scanner+ImageKit work. All daemon writes
 * are idempotent so duplicate processing across a flaky save/load is harmless.
 *
 * State file lives on the Fly volume (next to the SQLite db) so it survives container
 * restarts. Atomic write via tmp + rename guards against partial files from kill -9.
 */

const STATE_VERSION = 1

// Resolved per-call so tests can vary NUXT_DATA_DIR across runs; in production the env
// var is set once at boot and never changes, so the extra resolve is free.
function statePath(): { path: string, tmp: string } {
  const dir = resolve(process.env.NUXT_DATA_DIR || process.env.DATA_DIR || '../../data')
  const path = join(dir, 'queue-state.json')
  return { path, tmp: `${path}.tmp` }
}

export interface CaptureJob {
  domain: string
  finalUrl: string
  candidateOgImage: string | null
}

export interface QueueState {
  version: number
  savedAt: number
  detection: string[]
  capture: CaptureJob[]
}

export function saveQueueState(state: { detection: string[], capture: CaptureJob[] }): void {
  const { path, tmp } = statePath()
  if (state.detection.length === 0 && state.capture.length === 0) {
    // Nothing to persist; remove any stale file so boot doesn't re-ingest old work.
    if (existsSync(path)) {
      try { unlinkSync(path) } catch { /* noop */ }
    }
    return
  }
  const payload: QueueState = {
    version: STATE_VERSION,
    savedAt: Date.now(),
    detection: state.detection,
    capture: state.capture,
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload))
    renameSync(tmp, path)
    log.info(`[queue-state] saved ${state.detection.length} detection + ${state.capture.length} capture jobs to ${path}`)
  }
  catch (err) {
    log.error(`[queue-state] save failed: ${(err as Error).message}`)
  }
}

/**
 * Reads the state file (if any), removes it, returns the snapshot. The file is removed
 * even on parse failure so a corrupted file can't loop the daemon into repeatedly
 * choking on it across restarts; the work it contained is lost but the daemon recovers.
 */
export function loadQueueState(): QueueState | null {
  const { path } = statePath()
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  }
  catch (err) {
    log.warn(`[queue-state] read failed: ${(err as Error).message}`)
    return null
  }
  try { unlinkSync(path) } catch { /* noop */ }
  try {
    const parsed = JSON.parse(raw) as QueueState
    if (parsed.version !== STATE_VERSION) {
      log.warn(`[queue-state] version mismatch (file=${parsed.version} expected=${STATE_VERSION}); discarding`)
      return null
    }
    return parsed
  }
  catch (err) {
    log.warn(`[queue-state] parse failed: ${(err as Error).message}; discarding`)
    return null
  }
}

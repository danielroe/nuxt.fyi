#!/usr/bin/env node
/**
 * Materialises the adoption curve and churn events from the observation log.
 *
 * Cheap and idempotent: it recomputes everything from `version_checks` and replaces the
 * derived tables, so it's safe to run on a timer and safe to re-run after changing the
 * derivation rules.
 *
 * On first run it seeds the log from the `scans` table, using each row's `scanned_at` as
 * the observation time. That gives the curve real history from day one instead of
 * starting flat, since those were real scans spread over the past.
 */
import { parseArgs } from 'node:util'
import { log } from '../log.ts'
import { DAY_MS, deriveHistory } from '../history.ts'
import { listBootstrapObservations, listObservations, recordVersionCheck, replaceDerivedHistory } from '../store.ts'

const USAGE = `usage: build-history [--interval-days N] [--no-bootstrap] [--dry-run]

Derives version_snapshots + domain_events from version_checks.

  --interval-days  snapshot spacing (default 7)
  --no-bootstrap   skip seeding the log from existing scans
  --dry-run        report what would be derived, write nothing`

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'interval-days': { type: 'string', default: '7' },
    'no-bootstrap': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (values.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

const intervalDays = Number(values['interval-days'])
if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
  process.stderr.write('--interval-days must be a positive number\n')
  process.exit(2)
}

let seeded = 0
if (!values['no-bootstrap']) {
  const pending = listBootstrapObservations()
  if (pending.length > 0 && !values['dry-run']) {
    for (const row of pending) {
      recordVersionCheck({
        domain: row.domain,
        isNuxt: row.is_nuxt === 1,
        nuxtVersion: row.nuxt_version,
        outcome: row.outcome === 'blocked' || row.outcome === 'error' ? row.outcome : 'ok',
        blockSignal: null,
        checkedAt: row.scanned_at,
      })
      seeded++
    }
  }
  else {
    seeded = pending.length
  }
  log.info(`[history] seeded ${seeded} observation(s) from existing scans${values['dry-run'] ? ' (dry-run, not written)' : ''}`)
}

const observations = listObservations()
const { snapshots, events } = deriveHistory(observations, intervalDays * DAY_MS)

if (!values['dry-run']) replaceDerivedHistory(snapshots, events)

const byKind = events.reduce<Record<string, number>>((acc, e) => {
  acc[e.kind] = (acc[e.kind] ?? 0) + 1
  return acc
}, {})
const snapshotTimes = [...new Set(snapshots.map(s => s.taken_at))]

process.stdout.write(`${JSON.stringify({
  observations: observations.length,
  seeded,
  snapshots: snapshotTimes.length,
  from: snapshotTimes[0] ? new Date(snapshotTimes[0]).toISOString() : null,
  to: snapshotTimes.at(-1) ? new Date(snapshotTimes.at(-1)!).toISOString() : null,
  events: events.length,
  ...byKind,
}, null, 2)}\n`)

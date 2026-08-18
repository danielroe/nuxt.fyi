import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, deriveHistory } from './history.ts'
import type { ObservationRow } from './store.ts'

const T0 = Date.UTC(2025, 0, 1)

function obs(domain: string, day: number, isNuxt: boolean, version: string | null, outcome = 'ok', observations = 1): ObservationRow {
  return { domain, checked_at: T0 + day * DAY_MS, is_nuxt: isNuxt ? 1 : 0, nuxt_version: version, outcome, observations }
}

const WEEK = 7 * DAY_MS

test('no observations derives nothing', () => {
  const r = deriveHistory([], WEEK)
  assert.deepEqual(r.snapshots, [])
  assert.deepEqual(r.events, [])
})

test('a first sighting is discovery, not adoption', () => {
  const r = deriveHistory([obs('a.com', 0, true, '4.0.0')], WEEK, T0 + DAY_MS)
  assert.deepEqual(r.events, [])
})

test('non-Nuxt then Nuxt records an adoption', () => {
  const r = deriveHistory([
    obs('a.com', 0, false, null),
    obs('a.com', 10, true, '4.0.0'),
  ], WEEK, T0 + 11 * DAY_MS)
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0]!.kind, 'adopted')
  assert.equal(r.events[0]!.to_version, '4.0.0')
})

test('a single non-Nuxt reading does not record a departure', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '4.0.0'),
    obs('a.com', 10, false, null),
  ], WEEK, T0 + 11 * DAY_MS)
  assert.deepEqual(r.events, [])
})

test('a corroborated non-Nuxt state records a departure', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '4.0.0'),
    obs('a.com', 10, false, null, 'ok', 2),
  ], WEEK, T0 + 21 * DAY_MS)
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0]!.kind, 'departed')
  assert.equal(r.events[0]!.from_version, '4.0.0')
})

test('a recovery between negatives resets the departure count', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '4.0.0'),
    obs('a.com', 10, false, null),
    obs('a.com', 20, true, '4.0.0'),
    obs('a.com', 30, false, null),
  ], WEEK, T0 + 31 * DAY_MS)
  assert.deepEqual(r.events, [])
})

test('blocked and errored observations never manufacture churn', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '4.0.0'),
    obs('a.com', 10, false, null, 'blocked', 5),
    obs('a.com', 20, false, null, 'error', 5),
  ], WEEK, T0 + 21 * DAY_MS)
  assert.deepEqual(r.events, [])
})

test('version changes are classified by direction', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '3.9.0'),
    obs('a.com', 10, true, '4.1.0'),
    obs('a.com', 20, true, '4.0.5'),
  ], WEEK, T0 + 21 * DAY_MS)
  assert.deepEqual(r.events.map(e => e.kind), ['upgraded', 'downgraded'])
  assert.equal(r.events[0]!.from_version, '3.9.0')
  assert.equal(r.events[0]!.to_version, '4.1.0')
})

test('a failed version re-detection is not treated as a version change', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '4.4.8'),
    obs('a.com', 10, true, null),
    obs('a.com', 20, true, '4.4.8'),
  ], WEEK, T0 + 21 * DAY_MS)
  assert.deepEqual(r.events, [])
})

test('snapshots carry the last known state forward across boundaries', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '4.0.0'),
    obs('b.com', 1, true, '3.9.0'),
    obs('a.com', 30, true, '4.1.0'),
  ], WEEK, T0 + 31 * DAY_MS)

  const at = (t: number) => r.snapshots.filter(s => s.taken_at === t)
  const times = [...new Set(r.snapshots.map(s => s.taken_at))].sort((x, y) => x - y)

  // Both sites present in an early snapshot, still both present later with a's version moved.
  const early = at(times[0]!)
  assert.deepEqual(early.map(s => s.label).sort(), ['3.9.0', '4.0.0'])
  const last = at(times.at(-1)!)
  assert.deepEqual(last.map(s => s.label).sort(), ['3.9.0', '4.1.0'])
})

test('departed sites drop out of later snapshots', () => {
  const r = deriveHistory([
    obs('a.com', 0, true, '4.0.0'),
    obs('a.com', 20, false, null, 'ok', 2),
  ], WEEK, T0 + 28 * DAY_MS)

  // Present while it was still a hit...
  assert.deepEqual(r.snapshots.filter(s => s.taken_at === T0 + 7 * DAY_MS).map(s => s.label), ['4.0.0'])
  // ...and gone from every snapshot after the departure was confirmed on day 20.
  assert.deepEqual(r.snapshots.filter(s => s.taken_at >= T0 + 21 * DAY_MS), [])
})

test('sites with no detected version bucket as unknown', () => {
  const r = deriveHistory([obs('a.com', 0, true, null), obs('b.com', 0, true, '4.0.0')], WEEK, T0 + 10 * DAY_MS)
  const first = r.snapshots.filter(s => s.taken_at === r.snapshots[0]!.taken_at)
  assert.deepEqual(first.map(s => s.label).sort(), ['4.0.0', 'unknown'])
})

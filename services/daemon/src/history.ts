/**
 * Derives the adoption curve and churn events from the raw observation log.
 *
 * Both outputs are pure functions of `version_checks`, recomputed and replaced on every
 * run, so the rules below can be retuned without migrating stored history.
 */
import type { DomainEventRow, ObservationRow, SnapshotRow } from './store.ts'

export const DAY_MS = 86_400_000

/** Times we must have observed the non-Nuxt state before believing a site left Nuxt.
 *  One is not enough: a soft wall, a failed deploy, or a momentary blank render all
 *  read as "no Nuxt markers" while the site is still very much a Nuxt site. Corroboration
 *  is counted per state interval (`observations`), not per row. */
const DEPARTURE_STRIKES = 2

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export interface DerivedHistory {
  snapshots: SnapshotRow[]
  events: DomainEventRow[]
}

interface DomainState {
  isNuxt: boolean
  version: string | null
}

/**
 * Single pass over chronologically ordered observations. Maintains the last known state
 * per domain (carry-forward), emitting a snapshot of the whole corpus at each interval
 * boundary and a churn event whenever a domain's state genuinely changes.
 *
 * Only `ok` observations participate: a blocked or errored check tells us nothing about
 * whether the site is still Nuxt, and letting those through would manufacture departures
 * every time a WAF got twitchy.
 */
export function deriveHistory(observations: ObservationRow[], intervalMs: number, now = Date.now()): DerivedHistory {
  const usable = observations.filter(o => o.outcome === 'ok')
  const snapshots: SnapshotRow[] = []
  const events: DomainEventRow[] = []
  if (usable.length === 0) return { snapshots, events }

  const state = new Map<string, DomainState>()

  // A label absent from a snapshot means zero sites on that version at that time. A
  // snapshot with no Nuxt sites at all therefore contributes no rows, so the timeline is
  // the set of times that had at least one hit.
  const snapshotAt = (takenAt: number): void => {
    const counts = new Map<string, number>()
    for (const s of state.values()) {
      if (!s.isNuxt) continue
      const label = s.version ?? 'unknown'
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    for (const [label, count] of counts) snapshots.push({ taken_at: takenAt, label, count })
  }

  let boundary = usable[0]!.checked_at + intervalMs

  for (const obs of usable) {
    while (obs.checked_at >= boundary) {
      snapshotAt(boundary)
      boundary += intervalMs
    }

    const previous = state.get(obs.domain)
    const isNuxt = obs.is_nuxt === 1

    if (!previous) {
      // First sighting is discovery, not churn: we've no idea what the site was before.
      state.set(obs.domain, { isNuxt, version: obs.nuxt_version })
      continue
    }

    if (isNuxt) {
      if (!previous.isNuxt) {
        events.push({ domain: obs.domain, at: obs.checked_at, kind: 'adopted', from_version: null, to_version: obs.nuxt_version })
      }
      else if (obs.nuxt_version && previous.version && obs.nuxt_version !== previous.version) {
        const direction = compareVersions(obs.nuxt_version, previous.version) > 0 ? 'upgraded' : 'downgraded'
        events.push({ domain: obs.domain, at: obs.checked_at, kind: direction, from_version: previous.version, to_version: obs.nuxt_version })
      }
      // A version we failed to re-detect must not erase the one we know.
      state.set(obs.domain, { isNuxt: true, version: obs.nuxt_version ?? previous.version })
      continue
    }

    if (!previous.isNuxt) {
      state.set(obs.domain, { isNuxt: false, version: null })
      continue
    }

    // Non-Nuxt after a confirmed hit: only believed once corroborated. An uncorroborated
    // negative leaves the site counted as Nuxt, matching what `scans` holds.
    if (obs.observations < DEPARTURE_STRIKES) continue

    events.push({ domain: obs.domain, at: obs.checked_at, kind: 'departed', from_version: previous.version, to_version: null })
    state.set(obs.domain, { isNuxt: false, version: null })
  }

  // Final boundary so the curve reaches the present rather than stopping at the last
  // interval that happened to contain an observation.
  while (boundary <= now) {
    snapshotAt(boundary)
    boundary += intervalMs
  }
  snapshotAt(now)

  return { snapshots, events }
}

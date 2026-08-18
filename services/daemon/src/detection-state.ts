/**
 * Rules for turning a fresh detection into what we actually store.
 *
 * A scan is one noisy observation, not the truth. Chunk fetches time out, bot walls
 * answer instead of the page, and a site can look non-Nuxt for a request or two while
 * being perfectly fine. Writing observations straight through degrades the corpus, so
 * every write goes through here and the raw observation is kept separately in
 * `version_checks` for history and churn derivation.
 */
import type { DetectionOutcome } from './scan/index.ts'
import type { ScanRow } from './store.ts'

export interface MergedDetection {
  isNuxt: boolean
  nuxtVersion: string | null
  confidence: number
  signals: string
  /** We kept a prior Nuxt hit despite this observation reading as non-Nuxt. */
  heldDowngrade: boolean
  /** We kept a prior version because this observation couldn't re-detect one. */
  heldVersion: boolean
}

export interface MergeOptions {
  /** Allow a confirmed hit to flip to non-Nuxt. Should only be true when a previous
   *  successful observation also said non-Nuxt, or when an admin has asked for it. */
  allowDowngrade?: boolean
}

export function mergeDetection(
  existing: Pick<ScanRow, 'is_nuxt' | 'nuxt_version' | 'confidence' | 'signals'> | undefined,
  fresh: DetectionOutcome,
  options: MergeOptions = {},
): MergedDetection {
  const freshSignals = JSON.stringify(fresh.detection.signals)

  if (!existing) {
    return {
      isNuxt: fresh.detection.isNuxt,
      nuxtVersion: fresh.detection.nuxtVersion,
      confidence: fresh.detection.confidence,
      signals: freshSignals,
      heldDowngrade: false,
      heldVersion: false,
    }
  }

  const keepExisting = (heldDowngrade: boolean): MergedDetection => ({
    isNuxt: existing.is_nuxt === 1,
    nuxtVersion: existing.nuxt_version,
    confidence: existing.confidence,
    signals: existing.signals,
    heldDowngrade,
    heldVersion: false,
  })

  // A wall or a network failure says nothing about the site; leave detection alone.
  if (fresh.outcome !== 'ok') return keepExisting(false)

  const wasNuxt = existing.is_nuxt === 1
  if (wasNuxt && !fresh.detection.isNuxt && !options.allowDowngrade) {
    return keepExisting(true)
  }

  const heldVersion = fresh.detection.isNuxt && !fresh.detection.nuxtVersion && !!existing.nuxt_version
  return {
    isNuxt: fresh.detection.isNuxt,
    nuxtVersion: fresh.detection.nuxtVersion ?? (fresh.detection.isNuxt ? existing.nuxt_version : null),
    confidence: fresh.detection.confidence,
    signals: freshSignals,
    heldDowngrade: false,
    heldVersion,
  }
}

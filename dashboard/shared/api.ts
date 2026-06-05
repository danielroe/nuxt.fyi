/**
 * Response shapes for the API endpoints served from `server/api/`
 */

import type { DynamicParam, Endpoint, TypedFetchInput, TypedFetchRequestInit, TypedFetchResponseBody } from 'fetchdts'

export type VersionBucket = 'published' | 'off-registry' | 'unknown'
export type NsfwLabel = 'safe' | 'suggestive' | 'nsfw'

export interface ImageSources {
  screenshotKey: string | null
  ogImageKey: string | null
  ogImageUrl: string | null
  nsfwLabel: NsfwLabel | null
}

export interface Signal {
  name: string
  weight: number
  detail?: string
}

export interface StatsResponse {
  stats: {
    domains: number
    scans: number
    nuxtHits: number
    errors: number
    notifications: number
    pendingScan: number
    // The handler's `as unknown as CountRow` cast already asserts non-null on this
    // (SQL `MAX` can return null on an empty table, but we accept that risk to keep
    // the template binding for `<NuxtTime :datetime>` simple).
    lastScanAt: number
  }
  versions: Array<{ version: string, count: number, bucket: VersionBucket }>
  signals: Array<{ name: string, count: number }>
  notificationChannels: Array<{ channel: string, count: number }>
}

export interface HitRow {
  domain: string
  // `hits` is gated by `is_nuxt = 1`, so `scans.scanned_at` is always set; the SQL
  // never produces null here.
  scannedAt: number
  version: string | null
  confidence: number
  signals: Signal[]
  finalUrl: string | null
  title: string | null
  image: ImageSources
  // `domains.seen_count` is set on insert, but the LEFT JOIN can theoretically miss
  // (no observed cases in practice). Keep nullable for safety.
  seenCount: number | null
  rank: number | null
}

export interface HitsResponse {
  total: number
  page: number
  pageSize: number
  pageCount: number
  sort: string
  order: string
  hits: HitRow[]
}

export interface HitDetailResponse {
  rank: number | null
  domain: string
  isNuxt: boolean
  // Detail endpoint returns 404 if `scans` is missing, so once we have data this is
  // always set.
  scannedAt: number
  version: string | null
  confidence: number
  signals: Signal[]
  finalUrl: string | null
  title: string | null
  error: string | null
  image: ImageSources
  redirectedTo: string | null
  firstSeenAt: number | null
  lastSeenAt: number | null
  seenCount: number | null
  notifications: Array<{ channel: string, postedAt: number }>
}

export interface RecentRow {
  domain: string
  // `domains` rows always carry both timestamps; left join doesn't drop them.
  firstSeenAt: number
  lastSeenAt: number
  seenCount: number
  scanned: boolean
  isNuxt: boolean
  version: string | null
  confidence: number | null
  scannedAt: number | null
  error: string | null
}

export interface RecentResponse {
  sort: string
  order: string
  filter: string
  rows: RecentRow[]
}

export interface SubmitBody { url?: string }

export interface SubmitResult {
  ok: true
  domain?: string
  status?: 'queued' | 'already-pending' | 'recently-scanned'
  isNuxt?: boolean
  scannedAt?: number
  /** Present only in `NUXT_FIXTURES=1` mode. */
  note?: string
}

export interface APISchema {
  '/api/stats': { [Endpoint]: { GET: { response: StatsResponse } } }
  '/api/hits': {
    [Endpoint]: { GET: { response: HitsResponse, query: { q?: string } } }
    [DynamicParam]: { [Endpoint]: { GET: { response: HitDetailResponse } } }
  }
  '/api/recent': { [Endpoint]: { GET: { response: RecentResponse } } }
  '/api/submit': {
    [Endpoint]: {
      POST: { body: SubmitBody, response: SubmitResult }
    }
  }
}

/** Response body for a given API path/method. */
export type APIResponse<
  Path extends string,
  Method extends 'GET' | 'POST' = 'GET',
> = TypedFetchResponseBody<APISchema, Path, Method>

/** Strongly-typed `$fetch` for the dashboard API. */
export const $apiFetch = <T extends TypedFetchInput<APISchema>>(
  input: T,
  init?: TypedFetchRequestInit<APISchema, T>,
): Promise<TypedFetchResponseBody<APISchema, T>> =>
  $fetch(input as string, init as object) as Promise<TypedFetchResponseBody<APISchema, T>>

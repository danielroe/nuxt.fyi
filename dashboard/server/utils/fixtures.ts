/**
 * Static fixture payloads served when `NUXT_FIXTURES=1` so the dashboard can be
 * previewed (and responsive-layout / SVG bugs reproduced) without a populated
 * SQLite database. Numbers are roughly shaped like production but otherwise made up.
 */

import type { StatsResponse, VersionBucket } from '#shared/api'

interface VersionRow { version: string, count: number, bucket: VersionBucket }

const now = Date.UTC(2025, 4, 28, 12, 0, 0)

const publishedVersions: Array<[string, number]> = [
  ['3.0.0', 18],
  ['3.4.3', 42],
  ['3.7.4', 96],
  ['3.8.2', 130],
  ['3.9.3', 184],
  ['3.10.3', 221],
  ['3.11.2', 268],
  ['3.12.4', 334],
  ['3.13.2', 412],
  ['3.14.1592', 580],
  ['3.15.4', 712],
  ['3.16.2', 901],
  ['3.17.7', 1183],
  ['4.0.0', 64],
  ['4.1.2', 138],
  ['2.17.3', 47],
  ['2.16.3', 31],
]

const offRegistryVersions: Array<[string, number]> = [
  ['3.99.0', 4],
  ['0.0.0-28934765.abcd', 2],
]

const unknownVersions: Array<[string, number]> = [
  ['unknown', 318],
]

const versions: VersionRow[] = [
  ...publishedVersions.map(([version, count]): VersionRow => ({ version, count, bucket: 'published' })),
  ...offRegistryVersions.map(([version, count]): VersionRow => ({ version, count, bucket: 'off-registry' })),
  ...unknownVersions.map(([version, count]): VersionRow => ({ version, count, bucket: 'unknown' })),
]

const nuxtHits = versions.reduce((sum, v) => sum + v.count, 0)

export const fixtureStats: StatsResponse = {
  stats: {
    domains: 184_320,
    scans: 162_104,
    nuxtHits,
    errors: 2_413,
    notifications: 8_927,
    pendingScan: 22_216,
    lastScanAt: now,
  },
  versions,
  signals: [
    { name: 'window.__NUXT__', count: 4_812 },
    { name: 'meta[name=generator]=Nuxt', count: 4_021 },
    { name: '/_nuxt/ asset prefix', count: 3_887 },
    { name: 'nuxt-data-hid', count: 2_944 },
    { name: 'x-powered-by: Nuxt', count: 1_603 },
    { name: 'nuxt-link', count: 1_287 },
    { name: '__NUXT_DATA__ script', count: 1_054 },
    { name: 'nuxt island marker', count: 612 },
  ],
  notificationChannels: [
    { channel: 'bluesky', count: 8_204 },
    { channel: 'mastodon', count: 723 },
  ],
}

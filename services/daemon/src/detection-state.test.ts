import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeDetection } from './detection-state.ts'
import type { DetectionOutcome } from './scan/index.ts'

function outcome(over: Partial<DetectionOutcome> & { isNuxt?: boolean, version?: string | null } = {}): DetectionOutcome {
  const { isNuxt = true, version = null, ...rest } = over
  return {
    domain: 'example.com',
    detection: { isNuxt, confidence: isNuxt ? 12 : 0, nuxtVersion: version, signals: [] },
    outcome: 'ok',
    blockSignal: null,
    httpStatus: 200,
    hostingPlatform: null,
    hostingCdn: null,
    finalUrl: 'https://example.com/',
    title: null,
    description: null,
    ogImage: null,
    redirectedTo: null,
    error: null,
    ...rest,
  }
}

const existingHit = { is_nuxt: 1, nuxt_version: '4.4.8', confidence: 15, signals: '[{"name":"old"}]' }

test('a first sighting is written as observed', () => {
  const r = mergeDetection(undefined, outcome({ version: '4.1.0' }))
  assert.equal(r.isNuxt, true)
  assert.equal(r.nuxtVersion, '4.1.0')
  assert.equal(r.heldVersion, false)
})

test('a version we failed to re-detect does not erase the known one', () => {
  const r = mergeDetection(existingHit, outcome({ version: null }))
  assert.equal(r.nuxtVersion, '4.4.8')
  assert.equal(r.heldVersion, true)
})

test('a newly detected version replaces the old one', () => {
  const r = mergeDetection(existingHit, outcome({ version: '4.5.0' }))
  assert.equal(r.nuxtVersion, '4.5.0')
  assert.equal(r.heldVersion, false)
})

test('a single non-Nuxt reading does not drop a confirmed hit', () => {
  const r = mergeDetection(existingHit, outcome({ isNuxt: false }))
  assert.equal(r.isNuxt, true)
  assert.equal(r.nuxtVersion, '4.4.8')
  assert.equal(r.heldDowngrade, true)
})

test('a corroborated non-Nuxt reading is allowed through', () => {
  const r = mergeDetection(existingHit, outcome({ isNuxt: false }), { allowDowngrade: true })
  assert.equal(r.isNuxt, false)
  assert.equal(r.nuxtVersion, null)
  assert.equal(r.heldDowngrade, false)
})

test('a blocked observation leaves the stored detection untouched', () => {
  const r = mergeDetection(existingHit, outcome({ isNuxt: false, outcome: 'blocked', blockSignal: 'datadome' }))
  assert.equal(r.isNuxt, true)
  assert.equal(r.nuxtVersion, '4.4.8')
  assert.equal(r.confidence, 15)
  assert.equal(r.signals, '[{"name":"old"}]')
})

test('an errored observation leaves the stored detection untouched', () => {
  const r = mergeDetection(existingHit, outcome({ isNuxt: false, outcome: 'error', error: 'timeout' }))
  assert.equal(r.isNuxt, true)
  assert.equal(r.nuxtVersion, '4.4.8')
})

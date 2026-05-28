import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalDomain, normaliseUrl, shouldSkipDomain } from './domains.ts'

test('normalises a basic https URL', () => {
  const r = normaliseUrl('https://www.nuxt.com/docs')
  assert.equal(r?.hostname, 'www.nuxt.com')
  assert.equal(r?.registrable, 'nuxt.com')
})

test('rejects non-http(s) schemes', () => {
  assert.equal(normaliseUrl('mailto:foo@bar.com'), null)
  assert.equal(normaliseUrl('ftp://example.com'), null)
})

test('rejects garbage', () => {
  assert.equal(normaliseUrl(''), null)
  assert.equal(normaliseUrl('   '), null)
  assert.equal(normaliseUrl('not a url'), null)
})

test('rejects bare IPs / private TLDs', () => {
  assert.equal(normaliseUrl('http://192.168.1.1'), null)
  assert.equal(normaliseUrl('http://something.local'), null)
})

test('canonicalDomain strips leading www.', () => {
  assert.equal(canonicalDomain('www.nuxt.com'), 'nuxt.com')
  assert.equal(canonicalDomain('WWW.NUXT.COM'), 'nuxt.com')
})

test('canonicalDomain leaves other subdomains alone', () => {
  assert.equal(canonicalDomain('support.zoom.us'), 'support.zoom.us')
  assert.equal(canonicalDomain('docs.nuxt.com'), 'docs.nuxt.com')
  assert.equal(canonicalDomain('tekno.tempo.co'), 'tekno.tempo.co')
})

test('canonicalDomain collapses Zoom regional endpoints', () => {
  assert.equal(canonicalDomain('us06web.zoom.us'), 'zoom.us')
  assert.equal(canonicalDomain('eu01web.zoom.us'), 'zoom.us')
  // but not non-regional subdomains
  assert.equal(canonicalDomain('marketplace.zoom.us'), 'marketplace.zoom.us')
})

test('canonicalDomain collapses Bluesky variants', () => {
  assert.equal(canonicalDomain('staging.bsky.app'), 'bsky.app')
  assert.equal(canonicalDomain('main.bsky.app'), 'bsky.app')
})

test('skip list catches obvious junk', () => {
  assert.equal(shouldSkipDomain('youtube.com'), true)
  assert.equal(shouldSkipDomain('www.youtube.com'), true)
  assert.equal(shouldSkipDomain('m.youtube.com'), true)
  assert.equal(shouldSkipDomain('nuxt.com'), false)
})

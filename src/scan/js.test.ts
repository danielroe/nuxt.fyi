import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickEntryChunks, scanJsText } from './js.ts'

test('picks /_nuxt/entry over /_nuxt/other chunks', () => {
  const html = `
    <script src="/_nuxt/other.abc.js"></script>
    <script src="/_nuxt/entry.def123.js"></script>
    <script src="/some/random.js"></script>
  `
  const picked = pickEntryChunks(html, 'https://example.com/')
  assert.equal(picked[0], 'https://example.com/_nuxt/entry.def123.js')
})

test('handles modulepreload entries', () => {
  const html = `<link rel="modulepreload" href="/_nuxt/entry.abc.js">`
  const picked = pickEntryChunks(html, 'https://example.com/page')
  assert.deepEqual(picked, ['https://example.com/_nuxt/entry.abc.js'])
})

test('falls back to entry-named generic /assets/ chunks', () => {
  const html = `<script src="/assets/index-deadbeef.js"></script>`
  const picked = pickEntryChunks(html, 'https://example.com/')
  assert.deepEqual(picked, ['https://example.com/assets/index-deadbeef.js'])
})

test('ignores scripts with no recognisable hint', () => {
  const html = `<script src="https://cdn.example.com/analytics.js"></script>`
  const picked = pickEntryChunks(html, 'https://example.com/')
  assert.deepEqual(picked, [])
})

test('caps at MAX_CHUNKS (3)', () => {
  const html = Array.from({ length: 8 }, (_, i) => `<script src="/_nuxt/entry-${i}.js"></script>`).join('')
  const picked = pickEntryChunks(html, 'https://example.com/')
  assert.equal(picked.length, 3)
})

test('scanJsText detects multiple Nuxt-runtime identifiers', () => {
  const text = `
    function useNuxtApp(){}
    const k="__NUXT_DATA__";
    fetch("/_nuxt/builds/meta/abc.json")
  `
  const r = scanJsText(text)
  const names = r.signals.map(s => s.name).sort()
  assert.ok(names.includes('js: useNuxtApp'))
  assert.ok(names.includes('js: __NUXT_DATA__'))
  assert.ok(names.includes('js: /_nuxt/builds/meta'))
})

test('scanJsText extracts a plausible version', () => {
  const r = scanJsText(`const NUXT_VERSION="3.13.2";`)
  assert.equal(r.nuxtVersion, '3.13.2')
})

test('scanJsText extracts the `get nuxt() return X` shape', () => {
  const r = scanJsText(`versions:{get nuxt(){return"4.4.6"},get vue(){return n.vueApp.version}}`)
  assert.equal(r.nuxtVersion, '4.4.6')
})

test('scanJsText accepts the Nuxt 3 pi-flavoured version', () => {
  // Some Nuxt 3 prereleases shipped with 3.14.159 as a humorous literal. It's real.
  const r = scanJsText(`versions:{get nuxt(){return"3.14.159"}}`)
  assert.equal(r.nuxtVersion, '3.14.159')
})

test('scanJsText does NOT pick up @nuxtjs/i18n module version', () => {
  // The actual bundle substring from any.run: this was attributing 10.2.3 to Nuxt core.
  const r = scanJsText(`Object.defineProperty(e.versions,"nuxtI18n",{get:()=>"10.2.3"})`)
  assert.equal(r.nuxtVersion, null)
})

test('scanJsText does NOT pick up other module versions on .versions.<name>', () => {
  const samples = [
    `Object.defineProperty(t.versions,"nuxtImage",{get:()=>"1.10.0"})`,
    `Object.defineProperty(t.versions,"nuxtIcon",{get:()=>"2.0.0"})`,
    `e.versions.nuxtSitemap = "7.5.1"`,
  ]
  for (const s of samples) {
    const r = scanJsText(s)
    assert.equal(r.nuxtVersion, null, `should not match: ${s}`)
  }
})

test('scanJsText rejects major < 2', () => {
  const r = scanJsText(`get nuxt(){return"1.10.0"}`)
  assert.equal(r.nuxtVersion, null)
})

test('scanJsText accepts hypothetical future majors (no upper bound)', () => {
  const r = scanJsText(`get nuxt(){return"5.0.0"}`)
  assert.equal(r.nuxtVersion, '5.0.0')
  const r6 = scanJsText(`get nuxt(){return"6.2.1"}`)
  assert.equal(r6.nuxtVersion, '6.2.1')
})

test('scanJsText does not false-positive on plain React/Next code', () => {
  const text = `function useState(){} const __NEXT_DATA__={}; "/_next/static/chunks/main.js"`
  const r = scanJsText(text)
  assert.deepEqual(r.signals, [])
})

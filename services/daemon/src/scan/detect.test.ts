import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFromHtml } from './detect.ts'

const empty = new Headers()

test('detects Nuxt 3 SSR shell', () => {
  const html = `
    <!doctype html><html><head>
      <meta name="generator" content="Nuxt 3.13.0">
      <title>example</title>
    </head><body>
      <div id="__nuxt"></div>
      <script id="__NUXT_DATA__" type="application/json">[]</script>
      <link rel="modulepreload" href="/_nuxt/entry.abc123.js">
    </body></html>
  `
  const r = detectFromHtml(html, empty)
  assert.equal(r.isNuxt, true)
  assert.equal(r.nuxtVersion, '3.13.0')
  assert.ok(r.confidence >= 15)
})

test('detects legacy Nuxt 2', () => {
  const html = `
    <div id="__nuxt"><div id="__layout"></div></div>
    <script>window.__NUXT__={state:{}}</script>
  `
  const r = detectFromHtml(html, empty)
  assert.equal(r.isNuxt, true)
})

test('does not flag Next.js as Nuxt', () => {
  const html = `
    <div id="__next"></div>
    <script id="__NEXT_DATA__" type="application/json">{}</script>
    <link href="/_next/static/chunks/main.js">
    <meta name="generator" content="Next.js">
  `
  const r = detectFromHtml(html, empty)
  assert.equal(r.isNuxt, false)
  assert.equal(r.signals.length, 0)
})

test('does not flag plain WordPress', () => {
  const html = `
    <meta name="generator" content="WordPress 6.4">
    <body class="home blog"></body>
  `
  const r = detectFromHtml(html, empty)
  assert.equal(r.isNuxt, false)
})

test('low-confidence weak signal alone does not trigger', () => {
  const html = `<nuxt-link to="/about">about</nuxt-link>`
  const r = detectFromHtml(html, empty)
  assert.equal(r.isNuxt, false)
})

test('x-powered-by Nuxt header registers', () => {
  const headers = new Headers({ 'x-powered-by': 'Nuxt' })
  const r = detectFromHtml('<html></html>', headers)
  assert.equal(r.signals.some(s => s.name === 'x-powered-by'), true)
})

test('data-n-head triggers as a Nuxt 2 medium signal', () => {
  const html = `<meta data-n-head="ssr" name="description" content="x">`
  const r = detectFromHtml(html, empty)
  assert.equal(r.signals.some(s => s.name === 'data-n-head (Nuxt 2)'), true)
  // Alone it shouldn't quite hit threshold.
  assert.equal(r.confidence, 4)
  assert.equal(r.isNuxt, false)
})

test('data-n-head plus a Nuxt 2 root crosses threshold', () => {
  const html = `
    <div id="__nuxt"></div>
    <meta data-n-head-ssr name="description" content="x">
  `
  const r = detectFromHtml(html, empty)
  assert.equal(r.isNuxt, true)
})

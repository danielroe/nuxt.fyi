import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { scanHtml } from './html.ts'
import { BROWSER_UA, POLITE_UA } from './fetch-profile.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

interface Call { ua: string }

/** Stubs global fetch, recording the user-agent of each call. */
function stubFetch(handler: (ua: string) => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const ua = new Headers(init?.headers).get('user-agent') ?? ''
    calls.push({ ua })
    return handler(ua)
  }) as typeof fetch
  return calls
}

const NUXT_PAGE = `<html><head><meta name="generator" content="Nuxt 3.15.0"></head>
  <body><div id="__nuxt"></div><script id="__NUXT_DATA__">[]</script></body></html>`

test('uses the polite profile and does not retry when the first pass is fine', async () => {
  const calls = stubFetch(() => new Response(NUXT_PAGE, { status: 200 }))
  const result = await scanHtml('https://example.com/')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.ua, POLITE_UA)
  assert.equal(result.profile, 'polite')
  assert.equal(result.detection.isNuxt, true)
})

test('retries as a browser when the polite pass is challenged', async () => {
  const calls = stubFetch(ua => ua === POLITE_UA
    ? new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge' } })
    : new Response(NUXT_PAGE, { status: 200 }))

  const result = await scanHtml('https://example.com/')
  assert.deepEqual(calls.map(c => c.ua), [POLITE_UA, BROWSER_UA])
  assert.equal(result.profile, 'browser')
  assert.equal(result.blockSignal, null)
  assert.equal(result.detection.isNuxt, true)
  assert.equal(result.detection.nuxtVersion, '3.15.0')
})

test('keeps the browser-pass block signal when both passes are refused', async () => {
  const calls = stubFetch(() => new Response('<title>Just a moment...</title>', {
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
  }))

  const result = await scanHtml('https://example.com/')
  assert.equal(calls.length, 2)
  assert.equal(result.profile, 'browser')
  assert.equal(result.blockSignal, 'cloudflare-challenge')
})

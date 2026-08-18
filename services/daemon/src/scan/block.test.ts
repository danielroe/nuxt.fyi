import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectBlock } from './block.ts'

const empty = new Headers()

test('clean 200 page is not a block', () => {
  assert.equal(detectBlock(200, empty, '<html><body>hello</body></html>'), null)
})

test('cloudflare challenge via cf-mitigated header', () => {
  const headers = new Headers({ 'cf-mitigated': 'challenge' })
  assert.equal(detectBlock(403, headers, ''), 'cloudflare-challenge')
})

test('cloudflare challenge via interstitial markup', () => {
  const html = `
    <title>Just a moment...</title>
    <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
  `
  assert.equal(detectBlock(403, empty, html), 'cloudflare-challenge')
})

test('cloudflare JS Detections script on a real 200 page is not a block', () => {
  const html = `
    <html><head><title>Real Site</title></head><body>
      <div id="__nuxt">content</div>
      <script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js"></script>
    </body></html>
  `
  assert.equal(detectBlock(200, empty, html), null)
})

test('cloudflare "Attention Required" IP block page', () => {
  assert.equal(detectBlock(403, empty, '<title>Attention Required! | Cloudflare</title>'), 'cloudflare-challenge')
})

test('datadome captcha wall', () => {
  const html = '<script src="https://geo.captcha-delivery.com/captcha/?initialCid=abc"></script>'
  assert.equal(detectBlock(403, empty, html), 'datadome')
})

test('akamai deny page', () => {
  const html = '<title>Access Denied</title><p>Reference #18.abc123</p>'
  assert.equal(detectBlock(403, empty, html), 'akamai')
})

test('akamai ghost 403 via server header', () => {
  const headers = new Headers({ server: 'AkamaiGHost' })
  assert.equal(detectBlock(403, headers, ''), 'akamai')
})

test('akamai server header on a 200 is not a block', () => {
  const headers = new Headers({ server: 'AkamaiGHost' })
  assert.equal(detectBlock(200, headers, '<html>real page</html>'), null)
})

test('perimeterx captcha', () => {
  assert.equal(detectBlock(403, empty, '<div id="px-captcha"></div>'), 'perimeterx')
})

test('imperva incapsula iframe', () => {
  assert.equal(detectBlock(200, empty, '<iframe src="/_Incapsula_Resource?SWJIYLWA=abc"></iframe>'), 'imperva')
})

test('bare 403 falls back to http-403', () => {
  assert.equal(detectBlock(403, empty, '<html>Forbidden</html>'), 'http-403')
})

test('bare 429 falls back to http-429', () => {
  assert.equal(detectBlock(429, empty, ''), 'http-429')
})

test('500 without vendor markers is not a block', () => {
  assert.equal(detectBlock(500, empty, 'Internal Server Error'), null)
})

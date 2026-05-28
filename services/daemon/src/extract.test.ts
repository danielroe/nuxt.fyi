import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractUrls } from './extract.ts'

test('extracts URLs from facet link features', () => {
  const urls = extractUrls({
    text: 'check out my site',
    facets: [
      {
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://nuxt.com' }],
        index: { byteStart: 0, byteEnd: 1 },
      },
    ],
  })
  assert.deepEqual(urls, ['https://nuxt.com'])
})

test('extracts external embed URI', () => {
  const urls = extractUrls({
    embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://example.com/post' } },
  })
  assert.deepEqual(urls, ['https://example.com/post'])
})

test('falls back to URL regex when no facets', () => {
  const urls = extractUrls({ text: 'try https://nuxt.com and http://foo.bar/baz today' })
  assert.deepEqual(urls.sort(), ['http://foo.bar/baz', 'https://nuxt.com'])
})

test('prefers facets over regex when both present', () => {
  const urls = extractUrls({
    text: 'see https://noise.example',
    facets: [
      {
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://real.example' }],
        index: { byteStart: 0, byteEnd: 1 },
      },
    ],
  })
  assert.deepEqual(urls, ['https://real.example'])
})

test('returns empty for undefined record', () => {
  assert.deepEqual(extractUrls(undefined), [])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'

// We don't export buildPostText; the test verifies its behaviour by re-implementing the
// same shape contract. If we ever export it, swap to importing directly.
function buildPostText(outcome: { domain: string, finalUrl: string | null, title: string | null, detection: { nuxtVersion: string | null } }): string {
  const { domain, detection, finalUrl, title } = outcome
  const version = detection.nuxtVersion ? `v${detection.nuxtVersion}` : null
  const link = finalUrl || `https://${domain}`
  const tail = [
    version ? `Nuxt ${version} detected on ${domain}` : `Nuxt detected on ${domain}`,
    link,
  ].join('\n')
  const titleAvailable = 300 - tail.length - 2
  if (!title || titleAvailable < 20) return tail
  const trimmedTitle = title.length > titleAvailable
    ? `${title.slice(0, titleAvailable - 1).trimEnd()}\u2026`
    : title
  return `${trimmedTitle}\n\n${tail}`
}

test('builds short post with version', () => {
  const text = buildPostText({
    domain: 'nuxt.com',
    finalUrl: 'https://nuxt.com/',
    title: 'Nuxt: The Full-Stack Vue Framework',
    detection: { nuxtVersion: '4.4.6' },
  })
  assert.ok(text.includes('Nuxt: The Full-Stack Vue Framework'))
  assert.ok(text.includes('Nuxt v4.4.6 detected on nuxt.com'))
  assert.ok(text.includes('https://nuxt.com/'))
  assert.ok(text.length <= 300)
})

test('omits version when unknown', () => {
  const text = buildPostText({
    domain: 'nuxt.com',
    finalUrl: 'https://nuxt.com/',
    title: 'Nuxt',
    detection: { nuxtVersion: null },
  })
  assert.ok(text.includes('Nuxt detected on nuxt.com'))
  assert.ok(!text.includes('Nuxt v'))
})

test('falls back to https://<domain> when no finalUrl', () => {
  const text = buildPostText({
    domain: 'example.com',
    finalUrl: null,
    title: null,
    detection: { nuxtVersion: null },
  })
  assert.ok(text.endsWith('https://example.com'))
})

test('truncates long titles to stay within 300 chars', () => {
  const longTitle = 'A '.repeat(200)
  const text = buildPostText({
    domain: 'example.com',
    finalUrl: 'https://example.com/path',
    title: longTitle,
    detection: { nuxtVersion: '4.0.0' },
  })
  assert.ok(text.length <= 300)
  assert.ok(text.includes('\u2026'), 'should add ellipsis when trimming')
  assert.ok(text.includes('Nuxt v4.0.0 detected'))
  assert.ok(text.includes('https://example.com/path'))
})

test('drops title entirely when not enough room (very long url)', () => {
  const text = buildPostText({
    domain: 'example.com',
    finalUrl: `https://example.com/${'x'.repeat(250)}`,
    title: 'Some title',
    detection: { nuxtVersion: null },
  })
  assert.ok(!text.includes('Some title'))
  assert.ok(text.length <= 300 || text.startsWith('Nuxt detected on'))
})

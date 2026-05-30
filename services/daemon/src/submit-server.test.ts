import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processSubmit, type SubmitDeps } from './submit-server.ts'
import type { ScanRow } from './store.ts'

function makeDeps(overrides: Partial<SubmitDeps> = {}): { deps: SubmitDeps, enqueued: string[], seen: string[] } {
  const enqueued: string[] = []
  const seen: string[] = []
  const deps: SubmitDeps = {
    enqueueDetection: overrides.enqueueDetection ?? ((domain) => {
      if (enqueued.includes(domain)) return false
      enqueued.push(domain)
      return true
    }),
    getScan: overrides.getScan ?? (() => undefined),
    recordDomainSeen: overrides.recordDomainSeen ?? ((domain) => { seen.push(domain) }),
  }
  return { deps, enqueued, seen }
}

test('rejects missing url', () => {
  const { deps, enqueued, seen } = makeDeps()
  const r = processSubmit(undefined, deps)
  assert.equal(r.status, 400)
  assert.deepEqual(r.body, { ok: false, error: 'missing url' })
  assert.deepEqual(enqueued, [])
  assert.deepEqual(seen, [])
})

test('rejects non-string url', () => {
  const { deps } = makeDeps()
  const r = processSubmit(42, deps)
  assert.equal(r.status, 400)
})

test('rejects oversized url', () => {
  const { deps } = makeDeps()
  const r = processSubmit('a'.repeat(600), deps)
  assert.equal(r.status, 400)
  assert.match((r.body as { error: string }).error, /too long/)
})

test('rejects invalid url', () => {
  const { deps, enqueued } = makeDeps()
  const r = processSubmit('not a url at all', deps)
  assert.equal(r.status, 400)
  assert.match((r.body as { error: string }).error, /invalid/)
  assert.deepEqual(enqueued, [])
})

test('rejects non-http(s) schemes', () => {
  const { deps } = makeDeps()
  const r = processSubmit('mailto:hi@example.com', deps)
  assert.equal(r.status, 400)
})

test('rejects domains on the global skip list', () => {
  const { deps, enqueued } = makeDeps()
  const r = processSubmit('https://github.com/danielroe', deps)
  assert.equal(r.status, 400)
  assert.match((r.body as { error: string }).error, /skip list/)
  assert.deepEqual(enqueued, [])
})

test('enqueues a fresh domain and returns queued', () => {
  const { deps, enqueued, seen } = makeDeps()
  const r = processSubmit('https://nuxt.com', deps)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, domain: 'nuxt.com', status: 'queued' })
  assert.deepEqual(enqueued, ['nuxt.com'])
  assert.deepEqual(seen, ['nuxt.com'])
})

test('accepts bare hostnames (auto-prefixes https://)', () => {
  const { deps, enqueued } = makeDeps()
  const r = processSubmit('nuxt.com', deps)
  assert.equal(r.status, 200)
  assert.deepEqual(enqueued, ['nuxt.com'])
})

test('canonicalises www. before queueing', () => {
  const { deps, enqueued } = makeDeps()
  const r = processSubmit('https://www.vuejs.org', deps)
  assert.equal(r.status, 200)
  assert.equal((r.body as { domain: string }).domain, 'vuejs.org')
  assert.deepEqual(enqueued, ['vuejs.org'])
})

test('returns already-pending when the enqueue is a no-op', () => {
  const { deps } = makeDeps({ enqueueDetection: () => false })
  const r = processSubmit('https://nitro.build', deps)
  assert.equal(r.status, 200)
  assert.equal((r.body as { status: string }).status, 'already-pending')
})

test('returns recently-scanned for domains scanned within RESCAN_AFTER_MS', () => {
  const scan: ScanRow = {
    domain: 'roe.dev',
    scanned_at: Date.now(),
    is_nuxt: 1,
    nuxt_version: '3.99.0',
    confidence: 100,
    signals: '[]',
    final_url: 'https://roe.dev',
    title: null,
    screenshot_path: null,
    og_image: null,
    screenshot_key: null,
    og_image_key: null,
    nsfw_label: null,
    nsfw_score: null,
    nsfw_categories: null,
    nsfw_classified_at: null,
    redirected_to: null,
    error: null,
  }
  const { deps, enqueued } = makeDeps({ getScan: (d) => d === 'roe.dev' ? scan : undefined })
  const r = processSubmit('https://roe.dev', deps)
  assert.equal(r.status, 200)
  assert.equal((r.body as { status: string }).status, 'recently-scanned')
  assert.equal((r.body as { isNuxt: boolean }).isNuxt, true)
  assert.deepEqual(enqueued, [])
})

test('treats an old scan as not-recent and re-queues', () => {
  const ancient: ScanRow = {
    domain: 'example.com',
    scanned_at: 1000, // unix epoch + 1s; far older than any plausible RESCAN_AFTER_MS
    is_nuxt: 0,
    nuxt_version: null,
    confidence: 0,
    signals: '[]',
    final_url: null,
    title: null,
    screenshot_path: null,
    og_image: null,
    screenshot_key: null,
    og_image_key: null,
    nsfw_label: null,
    nsfw_score: null,
    nsfw_categories: null,
    nsfw_classified_at: null,
    redirected_to: null,
    error: null,
  }
  const { deps, enqueued } = makeDeps({ getScan: () => ancient })
  const r = processSubmit('https://example.com', deps)
  assert.equal(r.status, 200)
  assert.equal((r.body as { status: string }).status, 'queued')
  assert.deepEqual(enqueued, ['example.com'])
})

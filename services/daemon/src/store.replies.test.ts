import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `store.ts` opens the SQLite db at module-load against `NUXT_DATA_DIR`, so we point it
 * at a fresh temp dir _before_ importing it. The DB then sticks around for the duration
 * of the test file; each test below picks a unique `(post_uri, domain)` pair so the
 * shared DB doesn't cause cross-test interference.
 */
const tempDir = mkdtempSync(join(tmpdir(), 'store-replies-'))
const previousDataDir = process.env.NUXT_DATA_DIR
process.env.NUXT_DATA_DIR = tempDir

const store = await import('./store.ts')

before(() => { /* tempDir already set; ensure block exists for symmetry */ })

after(() => {
  if (previousDataDir === undefined) delete process.env.NUXT_DATA_DIR
  else process.env.NUXT_DATA_DIR = previousDataDir
  rmSync(tempDir, { recursive: true, force: true })
})

function makePost(suffix: string) {
  const uri = `at://did:plc:user/app.bsky.feed.post/${suffix}`
  return {
    postUri: uri,
    postCid: `bafy-${suffix}`,
    rootUri: uri,
    rootCid: `bafy-${suffix}`,
    authorDid: 'did:plc:user',
  }
}

test('recordReplyRequest is idempotent on (post_uri, domain)', () => {
  const post = makePost('idem')
  const domain = 'idem.example'
  store.recordReplyRequest({ ...post, domain })
  store.recordReplyRequest({ ...post, domain })
  const pending = store.pendingRepliesForDomain(domain)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.post_uri, post.postUri)
  assert.equal(pending[0]!.replied_at, null)
})

test('pendingRepliesForDomain only returns un-replied rows; markReplySent flips it', () => {
  const post = makePost('mark')
  const domain = 'mark.example'
  store.recordReplyRequest({ ...post, domain })
  assert.equal(store.pendingRepliesForDomain(domain).length, 1)
  store.markReplySent(post.postUri, domain)
  assert.equal(store.pendingRepliesForDomain(domain).length, 0)
  assert.equal(store.hasReplied(post.postUri, domain), true)
})

test('hasReplied is scoped per (post_uri, domain) pair', () => {
  const post = makePost('scope')
  store.recordReplyRequest({ ...post, domain: 'scope-a.example' })
  store.recordReplyRequest({ ...post, domain: 'scope-b.example' })
  store.markReplySent(post.postUri, 'scope-a.example')
  assert.equal(store.hasReplied(post.postUri, 'scope-a.example'), true)
  assert.equal(store.hasReplied(post.postUri, 'scope-b.example'), false)
  assert.equal(store.pendingRepliesForDomain('scope-b.example').length, 1)
})

test('different posts requesting the same domain stay independent', () => {
  const a = makePost('multi-a')
  const b = makePost('multi-b')
  const domain = 'multi.example'
  store.recordReplyRequest({ ...a, domain })
  store.recordReplyRequest({ ...b, domain })
  const pending = store.pendingRepliesForDomain(domain)
  assert.equal(pending.length, 2)
})

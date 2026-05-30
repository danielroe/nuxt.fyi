import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMentionDids, extractTrigger, type JetstreamEvent } from './extract.ts'

const SELF_DID = 'did:plc:nuxtfyibot'
const OTHER_DID = 'did:plc:someuser'

function makeEvent(record: object, opts: { authorDid?: string, rkey?: string, cid?: string } = {}): JetstreamEvent {
  return {
    did: opts.authorDid ?? OTHER_DID,
    kind: 'commit',
    commit: {
      operation: 'create',
      collection: 'app.bsky.feed.post',
      rkey: opts.rkey ?? '3kabcd',
      cid: opts.cid ?? 'bafyabc',
      record: record as never,
    },
  }
}

test('extractMentionDids returns deduped DIDs from mention facets', () => {
  const dids = extractMentionDids({
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: OTHER_DID }] },
    ],
  })
  assert.deepEqual(dids, [SELF_DID, OTHER_DID])
})

test('extractMentionDids returns [] for a record with no facets', () => {
  assert.deepEqual(extractMentionDids({ text: 'hello' }), [])
  assert.deepEqual(extractMentionDids(undefined), [])
})

test('extractTrigger matches when the post mentions selfDid and carries a URL', () => {
  const event = makeEvent({
    text: '@nuxt.fyi what about this',
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/foo' }] },
    ],
  })
  const trigger = extractTrigger(event, SELF_DID)
  assert.ok(trigger)
  assert.equal(trigger.post.authorDid, OTHER_DID)
  assert.equal(trigger.post.uri, `at://${OTHER_DID}/app.bsky.feed.post/3kabcd`)
  assert.equal(trigger.post.cid, 'bafyabc')
  assert.equal(trigger.post.rootUri, trigger.post.uri)
  assert.equal(trigger.post.rootCid, trigger.post.cid)
  assert.deepEqual(trigger.urls, ['https://example.com/foo'])
})

test('extractTrigger returns null when the bot is not mentioned', () => {
  const event = makeEvent({
    text: 'check out example.com',
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
    ],
  })
  assert.equal(extractTrigger(event, SELF_DID), null)
})

test('extractTrigger ignores plain-text "nuxt.fyi" mentions (only #mention facets count)', () => {
  const event = makeEvent({
    text: 'hey nuxt.fyi look at https://example.com',
  })
  assert.equal(extractTrigger(event, SELF_DID), null)
})

test('extractTrigger ignores link facets pointing at nuxt.fyi (only #mention facets count)', () => {
  const event = makeEvent({
    text: 'see nuxt.fyi',
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://nuxt.fyi' }] },
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
    ],
  })
  assert.equal(extractTrigger(event, SELF_DID), null)
})

test('extractTrigger returns null for posts the bot itself authored', () => {
  const event = makeEvent({
    text: 'a Nuxt site',
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
    ],
  }, { authorDid: SELF_DID })
  assert.equal(extractTrigger(event, SELF_DID), null)
})

test('extractTrigger returns null when no URL is in the post', () => {
  const event = makeEvent({
    text: 'hello @nuxt.fyi',
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
    ],
  })
  assert.equal(extractTrigger(event, SELF_DID), null)
})

test('extractTrigger returns null when selfDid is null (no creds configured)', () => {
  const event = makeEvent({
    text: 'a Nuxt site',
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
    ],
  })
  assert.equal(extractTrigger(event, null), null)
})

test('extractTrigger threads root refs through when the trigger post is itself a reply', () => {
  const parentUri = `at://${OTHER_DID}/app.bsky.feed.post/parent`
  const rootUri = `at://${OTHER_DID}/app.bsky.feed.post/root`
  const event = makeEvent({
    text: '@nuxt.fyi see example.com',
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
    ],
    reply: {
      root: { uri: rootUri, cid: 'bafy-root' },
      parent: { uri: parentUri, cid: 'bafy-parent' },
    },
  })
  const trigger = extractTrigger(event, SELF_DID)
  assert.ok(trigger)
  // parent ref of the reply we send = this post itself; root ref = the conversation root.
  assert.equal(trigger.post.uri, `at://${OTHER_DID}/app.bsky.feed.post/3kabcd`)
  assert.equal(trigger.post.rootUri, rootUri)
  assert.equal(trigger.post.rootCid, 'bafy-root')
})

test('extractTrigger needs both rkey and cid on the commit', () => {
  const event = makeEvent({
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: SELF_DID }] },
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] },
    ],
  })
  // Strip cid; commit becomes ineligible.
  delete event.commit!.cid
  assert.equal(extractTrigger(event, SELF_DID), null)
})

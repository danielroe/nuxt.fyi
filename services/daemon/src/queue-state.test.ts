import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadQueueState, saveQueueState } from './queue-state.ts'

function withTempDataDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'qstate-'))
  const previous = process.env.NUXT_DATA_DIR
  process.env.NUXT_DATA_DIR = dir
  try {
    return fn(dir)
  }
  finally {
    if (previous === undefined) delete process.env.NUXT_DATA_DIR
    else process.env.NUXT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

test('saveQueueState round-trips through loadQueueState', () => {
  withTempDataDir((dir) => {
    saveQueueState({
      detection: ['a.com', 'b.com'],
      capture: [{ domain: 'c.com', finalUrl: 'https://c.com/', candidateOgImage: 'https://c.com/og.jpg' }],
    })
    assert.ok(existsSync(join(dir, 'queue-state.json')))

    const loaded = loadQueueState()
    assert.ok(loaded)
    assert.equal(loaded.version, 1)
    assert.deepEqual(loaded.detection, ['a.com', 'b.com'])
    assert.equal(loaded.capture.length, 1)
    assert.equal(loaded.capture[0]!.domain, 'c.com')
    // loadQueueState deletes the file so a corrupt or already-processed snapshot can't
    // loop the daemon into re-ingesting the same work across crash loops.
    assert.equal(existsSync(join(dir, 'queue-state.json')), false)
  })
})

test('saveQueueState with empty queues removes any existing file', () => {
  withTempDataDir((dir) => {
    saveQueueState({ detection: ['stale.com'], capture: [] })
    assert.ok(existsSync(join(dir, 'queue-state.json')))

    saveQueueState({ detection: [], capture: [] })
    assert.equal(existsSync(join(dir, 'queue-state.json')), false)
  })
})

test('loadQueueState returns null when file is missing', () => {
  withTempDataDir(() => {
    assert.equal(loadQueueState(), null)
  })
})

test('loadQueueState discards file with wrong version', () => {
  withTempDataDir((dir) => {
    writeFileSync(join(dir, 'queue-state.json'), JSON.stringify({ version: 999, detection: ['x.com'], capture: [] }))
    assert.equal(loadQueueState(), null)
    // Removed even on version mismatch so a stale-version file doesn't keep failing on
    // every boot.
    assert.equal(existsSync(join(dir, 'queue-state.json')), false)
  })
})

test('loadQueueState discards malformed JSON', () => {
  withTempDataDir((dir) => {
    writeFileSync(join(dir, 'queue-state.json'), '{ this is not valid json')
    assert.equal(loadQueueState(), null)
    assert.equal(existsSync(join(dir, 'queue-state.json')), false)
  })
})

test('saveQueueState writes atomically (no half-files on crash mid-write)', () => {
  withTempDataDir((dir) => {
    saveQueueState({
      detection: ['a.com', 'b.com'],
      capture: [{ domain: 'c.com', finalUrl: 'https://c.com/', candidateOgImage: null }],
    })
    // No `.tmp` file should remain; rename moves it into place.
    assert.equal(existsSync(join(dir, 'queue-state.json.tmp')), false)
    const raw = readFileSync(join(dir, 'queue-state.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 1)
    assert.ok(typeof parsed.savedAt === 'number')
  })
})

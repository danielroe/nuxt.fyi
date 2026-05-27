import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Queue } from './queue.ts'

const defer = <T>(): { promise: Promise<T>, resolve: (v: T) => void } => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

test('processes items up to concurrency in parallel', async () => {
  const gates = [defer<void>(), defer<void>(), defer<void>()]
  let started = 0
  const queue = new Queue<number>(
    {
      concurrency: 2,
      worker: async (i) => {
        started++
        await gates[i]!.promise
      },
    },
    i => String(i),
  )

  queue.enqueue(0)
  queue.enqueue(1)
  queue.enqueue(2)

  await new Promise(r => setImmediate(r))
  assert.equal(started, 2, 'only 2 should start under concurrency=2')

  gates[0]!.resolve()
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.equal(started, 3)

  gates[1]!.resolve()
  gates[2]!.resolve()
})

test('drainAndClose waits for in-flight work and drops pending', async () => {
  const slow = defer<void>()
  const queue = new Queue<string>(
    {
      concurrency: 1,
      worker: async () => { await slow.promise },
    },
    s => s,
  )

  queue.enqueue('a')
  queue.enqueue('b')
  queue.enqueue('c')

  const closePromise = queue.drainAndClose(500)
  // a is in-flight, b/c pending. Let drain run; b/c should be dropped immediately.
  await new Promise(r => setImmediate(r))
  assert.equal(queue.size, 0, 'pending should be cleared')

  // Releasing the in-flight worker should let drain resolve.
  slow.resolve()
  const result = await closePromise
  assert.equal(result.drained, true)
  assert.equal(result.droppedPending, 2)
})

test('drainAndClose times out if work runs too long', async () => {
  const stuck = defer<void>()
  const queue = new Queue<string>(
    { concurrency: 1, worker: async () => { await stuck.promise } },
    s => s,
  )
  queue.enqueue('a')
  const result = await queue.drainAndClose(50)
  assert.equal(result.drained, false)
  stuck.resolve()
})

test('enqueue rejects after close', async () => {
  const queue = new Queue<string>(
    { concurrency: 1, worker: async () => { /* noop */ } },
    s => s,
  )
  await queue.drainAndClose(10)
  assert.equal(queue.enqueue('x'), false)
})

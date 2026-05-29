import { log } from './log.ts'

export interface QueueOptions<T> {
  concurrency: number
  worker: (item: T) => Promise<void>
  onError?: (item: T, err: unknown) => void
}

export class Queue<T> {
  private readonly pending: T[] = []
  private readonly inFlight = new Set<Promise<void>>()
  private readonly seen = new Set<string>()
  private readonly key: (item: T) => string
  private readonly opts: QueueOptions<T>
  private closed = false

  constructor(opts: QueueOptions<T>, key: (item: T) => string) {
    this.opts = opts
    this.key = key
  }

  enqueue(item: T): boolean {
    if (this.closed) return false
    const k = this.key(item)
    if (this.seen.has(k)) return false
    this.seen.add(k)
    this.pending.push(item)
    this.drain()
    return true
  }

  /** Stop accepting new work and resolve once everything in-flight has settled. Pending work is dropped. */
  async drainAndClose(timeoutMs: number): Promise<{ drained: boolean, droppedPending: number }> {
    this.closed = true
    const droppedPending = this.pending.length
    this.pending.length = 0
    if (this.inFlight.size === 0) return { drained: true, droppedPending }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const settled = Promise.allSettled([...this.inFlight]).then(() => 'done' as const)
    const result = await Promise.race([settled, timeout])
    if (timer) clearTimeout(timer)
    return { drained: result === 'done', droppedPending }
  }

  forget(item: T): void {
    this.seen.delete(this.key(item))
  }

  get size(): number {
    return this.pending.length
  }

  get active(): number {
    return this.inFlight.size
  }

  /**
   * Snapshot of currently-pending items, in FIFO order. Returns copies of the references
   * so callers can serialise without worrying about concurrent mutation. Used by the
   * shutdown hook to persist queue state to disk so deploys don't drop pending work.
   */
  snapshotPending(): T[] {
    return [...this.pending]
  }

  private drain(): void {
    if (this.closed) return
    while (this.inFlight.size < this.opts.concurrency && this.pending.length > 0) {
      const item = this.pending.shift()!
      const task = this.opts.worker(item)
        .catch((err) => {
          if (this.opts.onError) this.opts.onError(item, err)
          else log.error('[queue] worker error', err)
        })
        .finally(() => {
          this.inFlight.delete(task)
          this.drain()
        })
      this.inFlight.add(task)
    }
  }
}

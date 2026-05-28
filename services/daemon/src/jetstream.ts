import { config } from './config.ts'
import { log } from './log.ts'
import type { JetstreamEvent } from './extract.ts'

export interface JetstreamOptions {
  onEvent: (event: JetstreamEvent) => void
  signal?: AbortSignal
}

const POST_COLLECTION = 'app.bsky.feed.post'

export function startJetstream({ onEvent, signal }: JetstreamOptions): void {
  let backoff = 1000
  let stopped = false

  signal?.addEventListener('abort', () => { stopped = true })

  const connect = () => {
    if (stopped) return
    const url = new URL(config.jetstreamUrl)
    url.searchParams.set('wantedCollections', POST_COLLECTION)
    log.info(`[jetstream] connecting to ${url}`)

    const ws = new WebSocket(url)

    ws.addEventListener('open', () => {
      log.success('[jetstream] connected')
      backoff = 1000
    })

    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : null
      if (!data) return
      let parsed: JetstreamEvent
      try {
        parsed = JSON.parse(data) as JetstreamEvent
      } catch {
        return
      }
      if (parsed.kind !== 'commit') return
      if (parsed.commit?.operation !== 'create') return
      if (parsed.commit.collection !== POST_COLLECTION) return
      try {
        onEvent(parsed)
      } catch (err) {
        log.error('[jetstream] onEvent threw', err)
      }
    })

    ws.addEventListener('close', (event) => {
      if (stopped) return
      log.warn(`[jetstream] closed (${event.code}); reconnecting in ${backoff}ms`)
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    })

    ws.addEventListener('error', (err) => {
      log.error('[jetstream] socket error', (err as ErrorEvent).message || err)
    })

    signal?.addEventListener('abort', () => {
      try { ws.close() } catch { /* noop */ }
    }, { once: true })
  }

  connect()
}

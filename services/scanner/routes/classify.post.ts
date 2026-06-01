import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { consola } from 'consola'
import { classify, type NsfwLabel } from '../src/nsfw.ts'

const log = consola.withTag('classify')

interface ClassifyBody {
  /** Public URL to fetch and classify. The backfill script feeds ImageKit URLs here, but
   *  any reachable image URL works. */
  url: string
}

interface ClassifyResponse {
  nsfw: {
    label: NsfwLabel
    score: number | null
    categories: Record<string, unknown>
  } | null
  bytes: number
  error: string | null
}

const SCANNER_TOKEN = process.env.SCANNER_TOKEN || ''
const FETCH_TIMEOUT_MS = 15_000
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/**
 * Backfill endpoint. Pulls an image from `url`, classifies it, returns the result. The
 * caller is responsible for persisting the classification; this route is stateless.
 */
export default defineHandler(async (event): Promise<ClassifyResponse> => {
  const auth = event.req.headers.get('authorization') || ''
  if (!SCANNER_TOKEN || auth !== `Bearer ${SCANNER_TOKEN}`) {
    event.res.status = 401
    return { nsfw: null, bytes: 0, error: 'unauthorised' }
  }

  let body: ClassifyBody | undefined
  try {
    body = await readBody<ClassifyBody>(event)
  }
  catch {
    event.res.status = 400
    return { nsfw: null, bytes: 0, error: 'invalid json body' }
  }
  if (!body || typeof body.url !== 'string') {
    event.res.status = 400
    return { nsfw: null, bytes: 0, error: 'missing url' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(body.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NuxtFyi-Classifier/0.1; +https://nuxt.fyi)' },
    })
    if (!res.ok) {
      log.warn(`${body.url} returned ${res.status}`)
      event.res.status = 502
      return { nsfw: null, bytes: 0, error: `fetch returned ${res.status}` }
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      log.warn(`${body.url} too large (${buf.byteLength} bytes)`)
      return { nsfw: null, bytes: buf.byteLength, error: 'image too large' }
    }
    const nsfw = await classify(buf)
    return {
      nsfw: nsfw
        ? { label: nsfw.label, score: nsfw.score, categories: { ...nsfw.categories } }
        : null,
      bytes: buf.byteLength,
      error: nsfw ? null : 'classifier unavailable',
    }
  }
  catch (err) {
    const message = (err as Error).message
    log.warn(`${body.url} classify failed: ${message}`)
    event.res.status = 500
    return { nsfw: null, bytes: 0, error: message }
  }
  finally {
    clearTimeout(timer)
  }
})

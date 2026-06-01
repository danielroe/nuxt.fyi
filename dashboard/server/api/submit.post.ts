import { defineHandler, getRequestIP, HTTPError, readBody } from 'nitro/h3'
import type { SubmitResult } from '#shared/api'
import { rateLimit, sweep } from '../utils/rate-limit'

// The daemon's wire shape mirrors `SubmitResult` but `ok` is genuinely boolean (we
// branch on `ok === false` below) and an `error` field is carried for the 4xx/5xx
// fan-out.
interface DaemonResponse extends Omit<SubmitResult, 'ok'> {
  ok: boolean
  error?: string
}

interface SubmitBody { url?: unknown }

const DAEMON_URL = process.env.DAEMON_SUBMIT_URL || `http://127.0.0.1:${process.env.DAEMON_SUBMIT_PORT || '3010'}`
const DAEMON_TOKEN = process.env.DAEMON_SUBMIT_TOKEN || ''
const RATE_LIMIT = Number(process.env.SUBMIT_RATE_LIMIT || 5)
const RATE_WINDOW_MS = Number(process.env.SUBMIT_RATE_WINDOW_MS || 60_000)
// NUXT_UI_ONLY mode proxies every /api/** to the deployed dashboard via route rules,
// so this handler isn't even reached in that mode. NUXT_FIXTURES stops short of the
// daemon to keep offline UI work side-effect-free.
const FIXTURES = !!process.env.NUXT_FIXTURES

const buckets = new Map<string, { count: number, resetAt: number }>()

export default defineHandler(async (event): Promise<SubmitResult> => {
  if (FIXTURES) {
    return {
      ok: true,
      domain: 'example.com',
      status: 'queued' as const,
      note: 'fixtures mode: no real submission made',
    }
  }

  sweep(buckets)
  // `fly-client-ip` is the trusted source on Fly. Fall back to standard headers for
  // local dev where the request comes straight off the loopback interface.
  const ip = event.req.headers.get('fly-client-ip')
    ?? event.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? getRequestIP(event, { xForwardedFor: true })
    ?? 'unknown'

  const gate = rateLimit(buckets, ip, RATE_LIMIT, RATE_WINDOW_MS)
  event.res.headers.set('x-ratelimit-limit', String(RATE_LIMIT))
  event.res.headers.set('x-ratelimit-remaining', String(gate.remaining))
  event.res.headers.set('x-ratelimit-reset', String(Math.ceil(gate.resetAt / 1000)))
  if (!gate.ok) {
    event.res.headers.set('retry-after', String(Math.ceil((gate.resetAt - Date.now()) / 1000)))
    throw new HTTPError({ statusCode: 429, statusMessage: 'Too Many Requests', message: 'too many submissions; try again shortly' })
  }

  const body = await readBody<SubmitBody>(event).catch(() => null)
  const url = body && typeof body.url === 'string' ? body.url.trim() : ''
  if (!url) throw new HTTPError({ statusCode: 400, statusMessage: 'Bad Request', message: 'missing url' })
  if (url.length > 512) throw new HTTPError({ statusCode: 400, statusMessage: 'Bad Request', message: 'url too long' })

  // Cheap pre-check so we can fail fast without paying the daemon round-trip on
  // obviously-bad input. The daemon re-runs the full canonical/skip logic via tldts.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
  let parsed: URL
  try { parsed = new URL(candidate) }
  catch { throw new HTTPError({ statusCode: 400, statusMessage: 'Bad Request', message: 'invalid url' }) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Bad Request', message: 'only http(s) urls are supported' })
  }

  if (!DAEMON_TOKEN) {
    throw new HTTPError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'submit endpoint is not configured' })
  }

  let daemonRes: Response
  try {
    daemonRes = await fetch(`${DAEMON_URL}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${DAEMON_TOKEN}`,
      },
      body: JSON.stringify({ url: candidate }),
      // Daemon is local; if it's not responsive within 5s something's wrong and we want
      // to surface that rather than hang the user's request.
      signal: AbortSignal.timeout(5_000),
    })
  }
  catch (err) {
    console.error('[submit] daemon unreachable', err)
    throw new HTTPError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'daemon unreachable' })
  }

  // Read the body once as text so we can log the raw response on failure. Parse it
  // ourselves; the daemon always emits JSON, but if the body isn't JSON we want the raw
  // text in the server log rather than silently swallowing it.
  const rawBody = await daemonRes.text().catch(() => '')
  let payload: DaemonResponse | null = null
  try { payload = JSON.parse(rawBody) as DaemonResponse } catch { /* non-JSON */ }
  if (!daemonRes.ok || !payload || !payload.ok) {
    if (!daemonRes.ok || !payload) {
      console.error('[submit] daemon error', {
        url: `${DAEMON_URL}/submit`,
        status: daemonRes.status,
        statusText: daemonRes.statusText,
        contentType: daemonRes.headers.get('content-type'),
        body: rawBody.slice(0, 500),
      })
    }
    const message = payload?.error || `daemon returned ${daemonRes.status}`
    throw new HTTPError({ statusCode: daemonRes.status >= 500 ? 502 : 400, statusMessage: 'Submit Failed', message })
  }

  return {
    ok: true as const,
    domain: payload.domain,
    status: payload.status,
    isNuxt: payload.isNuxt,
    scannedAt: payload.scannedAt,
  }
})

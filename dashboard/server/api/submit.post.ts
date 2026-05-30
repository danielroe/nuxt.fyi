import { rateLimit, sweep } from '../utils/rate-limit'

interface DaemonResponse {
  ok: boolean
  domain?: string
  status?: 'queued' | 'already-pending' | 'recently-scanned'
  isNuxt?: boolean
  scannedAt?: number
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

export default defineEventHandler(async (event) => {
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
  const ip = getRequestHeader(event, 'fly-client-ip')
    ?? getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    ?? getRequestIP(event, { xForwardedFor: true })
    ?? 'unknown'

  const gate = rateLimit(buckets, ip, RATE_LIMIT, RATE_WINDOW_MS)
  setResponseHeader(event, 'x-ratelimit-limit', String(RATE_LIMIT))
  setResponseHeader(event, 'x-ratelimit-remaining', String(gate.remaining))
  setResponseHeader(event, 'x-ratelimit-reset', String(Math.ceil(gate.resetAt / 1000)))
  if (!gate.ok) {
    setResponseHeader(event, 'retry-after', Math.ceil((gate.resetAt - Date.now()) / 1000))
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests', message: 'too many submissions; try again shortly' })
  }

  const body = await readBody<SubmitBody>(event).catch(() => null)
  const url = body && typeof body.url === 'string' ? body.url.trim() : ''
  if (!url) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'missing url' })
  if (url.length > 512) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'url too long' })

  // Cheap pre-check so we can fail fast without paying the daemon round-trip on
  // obviously-bad input. The daemon re-runs the full canonical/skip logic via tldts.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
  let parsed: URL
  try { parsed = new URL(candidate) }
  catch { throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'invalid url' }) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'only http(s) urls are supported' })
  }

  if (!DAEMON_TOKEN) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'submit endpoint is not configured' })
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
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'daemon unreachable' })
  }

  const payload = await daemonRes.json().catch(() => null) as DaemonResponse | null
  if (!daemonRes.ok || !payload || !payload.ok) {
    const message = payload?.error || `daemon returned ${daemonRes.status}`
    throw createError({ statusCode: daemonRes.status >= 500 ? 502 : 400, statusMessage: 'Submit Failed', message })
  }

  return {
    ok: true as const,
    domain: payload.domain,
    status: payload.status,
    isNuxt: payload.isNuxt,
    scannedAt: payload.scannedAt,
  }
})

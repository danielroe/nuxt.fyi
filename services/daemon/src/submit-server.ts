import { createServer, type Server } from 'node:http'
import { canonicalDomain, normaliseUrl, shouldSkipDomain } from './domains.ts'
import { log } from './log.ts'
import { config } from './config.ts'
import type { ScanRow } from './store.ts'

export interface SubmitDeps {
  /** Push a domain onto the detection queue. Returns true if accepted (i.e. wasn't
   *  already pending under the same key). The daemon's existing queue dedupes, so a
   *  resubmit while the first attempt is in-flight is a no-op. */
  enqueueDetection: (domain: string) => boolean
  /** Look up an existing scan so the handler can short-circuit recently-scanned
   *  domains rather than re-queueing them. */
  getScan: (domain: string) => ScanRow | undefined
  /** Track the submission in the `domains` table so it shows up on /recent. */
  recordDomainSeen: (domain: string) => void
}

export interface SubmitOk {
  ok: true
  domain: string
  /** What we did with this submission: queued for the first time, already queued, or
   *  found a recent enough scan that we skipped re-queueing. */
  status: 'queued' | 'already-pending' | 'recently-scanned'
  isNuxt?: boolean
  scannedAt?: number
}

export interface SubmitErr {
  ok: false
  error: string
}

export type SubmitResponse = SubmitOk | SubmitErr

export interface SubmitDecision {
  status: number
  body: SubmitResponse
}

/**
 * Pure decision function: given an input URL and the daemon's store/queue accessors,
 * returns the HTTP status and JSON body the submit endpoint should reply with. Split
 * out from the HTTP shell so it can be exercised without spinning up a real server.
 */
export function processSubmit(input: unknown, deps: SubmitDeps): SubmitDecision {
  if (typeof input !== 'string' || input.length === 0) {
    return { status: 400, body: { ok: false, error: 'missing url' } }
  }
  if (input.length > 512) {
    return { status: 400, body: { ok: false, error: 'url too long' } }
  }
  const normalised = normaliseUrl(input)
  if (!normalised) {
    return { status: 400, body: { ok: false, error: 'invalid url' } }
  }
  const domain = canonicalDomain(normalised.hostname)
  if (shouldSkipDomain(domain) || shouldSkipDomain(normalised.registrable)) {
    return { status: 400, body: { ok: false, error: 'domain is on the global skip list' } }
  }

  deps.recordDomainSeen(domain)

  const existing = deps.getScan(domain)
  if (existing && Date.now() - existing.scanned_at < config.rescanAfterMs) {
    return {
      status: 200,
      body: {
        ok: true,
        domain,
        status: 'recently-scanned',
        isNuxt: existing.is_nuxt === 1,
        scannedAt: existing.scanned_at,
      },
    }
  }

  const accepted = deps.enqueueDetection(domain)
  return {
    status: 200,
    body: {
      ok: true,
      domain,
      status: accepted ? 'queued' : 'already-pending',
    },
  }
}

function send(res: import('node:http').ServerResponse, status: number, body: SubmitResponse): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readJson(req: import('node:http').IncomingMessage, limit = 4096): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8') || '{}'
      try { resolve(JSON.parse(raw)) }
      catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}

/**
 * Boots the daemon's submit endpoint. Listens on 127.0.0.1 only; in production the
 * dashboard process in the same Fly container reaches it over localhost, and in dev the
 * dashboard's `/api/submit` route does the same against the locally-running daemon. The
 * shared `DAEMON_SUBMIT_TOKEN` keeps random processes on the box from queueing scans.
 */
export function startSubmitServer(deps: SubmitDeps): Server | null {
  const port = config.submit.port
  const token = config.submit.token
  if (!config.submit.enabled) {
    log.info('[submit] DAEMON_SUBMIT_ENABLED=0; submit endpoint disabled')
    return null
  }
  if (!token) {
    log.warn('[submit] DAEMON_SUBMIT_TOKEN is empty; submit endpoint will refuse every request')
  }

  const server = createServer((req, res) => {
    void handle(req, res, deps, token).catch((err) => {
      log.error('[submit] handler crashed', err)
      try { send(res, 500, { ok: false, error: 'internal error' }) } catch { /* response already sent */ }
    })
  })
  server.listen(port, '127.0.0.1', () => {
    const address = server.address()
    const bound = typeof address === 'object' && address ? address.port : port
    log.info(`[submit] listening on 127.0.0.1:${bound}`)
  })
  return server
}

async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  deps: SubmitDeps,
  token: string,
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/submit') {
    send(res, 404, { ok: false, error: 'not found' })
    return
  }

  const auth = req.headers.authorization || ''
  if (!token || auth !== `Bearer ${token}`) {
    send(res, 401, { ok: false, error: 'unauthorised' })
    return
  }

  let body: unknown
  try { body = await readJson(req) }
  catch (err) {
    send(res, 400, { ok: false, error: (err as Error).message })
    return
  }

  const input = (body && typeof body === 'object' && 'url' in body ? (body as { url: unknown }).url : null)
  const decision = processSubmit(input, deps)
  send(res, decision.status, decision.body)
}

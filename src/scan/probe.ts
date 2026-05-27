import type { DetectionSignal } from './detect.ts'

const USER_AGENT = 'Mozilla/5.0 (compatible; NuxtFyi/0.1; +https://nuxt.fyi)'
const FETCH_TIMEOUT_MS = 6_000
const MAX_BYTES = 64 * 1024

export interface ProbeResult {
  signals: DetectionSignal[]
  nuxtVersion: string | null
  buildId: string | null
}

async function tryJson(url: string): Promise<{ status: number, body: string } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, 'accept': 'application/json,*/*' },
    })
    if (!res.body) return { status: res.status, body: '' }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    let received = 0
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      body += decoder.decode(value, { stream: true })
    }
    try { await reader.cancel() } catch { /* noop */ }
    return { status: res.status, body }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function looksLikeJson(body: string): unknown | null {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export async function probeNuxtEndpoints(finalUrl: string): Promise<ProbeResult> {
  let origin: string
  try {
    origin = new URL(finalUrl).origin
  } catch {
    return { signals: [], nuxtVersion: null, buildId: null }
  }

  const signals: DetectionSignal[] = []
  let nuxtVersion: string | null = null
  let buildId: string | null = null

  const [latestRes, payloadRes] = await Promise.all([
    tryJson(`${origin}/_nuxt/builds/latest.json`),
    tryJson(new URL('_payload.json', finalUrl.endsWith('/') ? finalUrl : `${finalUrl}/`).toString()),
  ])

  // Nuxt 3 ships `{ id: "<hash>", timestamp: <number> }`. Requiring both fields filters out
  // any other 200 JSON response at this path that might exist on unrelated sites.
  if (latestRes && latestRes.status === 200) {
    const parsed = looksLikeJson(latestRes.body) as { id?: string, timestamp?: number } | null
    if (parsed && typeof parsed.id === 'string' && typeof parsed.timestamp === 'number') {
      signals.push({ name: 'probe: /_nuxt/builds/latest.json', weight: 6, detail: parsed.id })
      buildId = parsed.id
    }
  }

  // Nuxt 3's _payload.json starts with the devalue prefix `[[` or `{"data":` / contains `"_errors":`.
  if (payloadRes && payloadRes.status === 200) {
    const trimmed = payloadRes.body.trim()
    if (trimmed.startsWith('[[') || /^\{"data"\s*:/.test(trimmed) || /"_errors"\s*:/.test(trimmed)) {
      signals.push({ name: 'probe: _payload.json', weight: 5 })
    }
  }

  return { signals, nuxtVersion, buildId }
}

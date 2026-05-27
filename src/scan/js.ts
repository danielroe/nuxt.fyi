import type { DetectionSignal } from './detect.ts'

const USER_AGENT = 'Mozilla/5.0 (compatible; NuxtFyi/0.1; +https://nuxt.fyi)'
const FETCH_TIMEOUT_MS = 10_000
const MAX_BYTES_PER_CHUNK = 1.5 * 1024 * 1024
const MAX_CHUNKS = 3

const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi
const MODULEPRELOAD_RE = /<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/gi

const ENTRY_HINTS = [
  { re: /\/_nuxt\/entry/i, score: 100 },
  { re: /\/_nuxt\/.*\.js/i, score: 60 },
  { re: /\b(entry|main|app|index)[.-][a-z0-9]+\.m?js(?:$|\?)/i, score: 40 },
  { re: /\b(entry|main|app|index)\.m?js(?:$|\?)/i, score: 30 },
  { re: /\/assets\/.*\.m?js/i, score: 20 },
]

/** Identifiers Nuxt's macros and runtime leave in compiled output even after minification. */
const JS_SIGNALS: Array<{ name: string, re: RegExp, weight: number }> = [
  { name: 'js: useNuxtApp', re: /\buseNuxtApp\b/, weight: 4 },
  { name: 'js: __NUXT__ key', re: /["']__NUXT__["']|window\.__NUXT__/, weight: 4 },
  { name: 'js: __NUXT_DATA__', re: /["']__NUXT_DATA__["']/, weight: 4 },
  { name: 'js: /_nuxt/builds/meta', re: /\/_nuxt\/builds\/meta\//, weight: 5 },
  { name: 'js: /_nuxt/builds/latest', re: /\/_nuxt\/builds\/latest\.json/, weight: 5 },
  { name: 'js: defineNuxtPlugin', re: /\bdefineNuxtPlugin\b/, weight: 4 },
  { name: 'js: defineNuxtRouteMiddleware', re: /\bdefineNuxtRouteMiddleware\b/, weight: 4 },
  { name: 'js: NuxtLink component', re: /["']NuxtLink["']|\bcreateNuxtLink\b/, weight: 3 },
  { name: 'js: nuxt-app context', re: /["']nuxt-app["']/, weight: 4 },
]

interface ScriptCandidate {
  url: string
  score: number
}

/**
 * Quick shape check used by the detector. Restricts to major >= 2 so we don't accidentally
 * attribute Nuxt-module versions (`@nuxtjs/i18n` 1.x etc.) to Nuxt core. Authoritative
 * "is this a real published version" classification happens at display time against the
 * `nuxt_versions` table populated from the npm registry.
 */
function isPlausibleNuxtVersion(version: string): boolean {
  const major = Number(version.split('.')[0])
  return Number.isFinite(major) && major >= 2
}

export interface JsScanResult {
  signals: DetectionSignal[]
  fetched: number
  nuxtVersion: string | null
}

function scoreScript(src: string): number {
  let score = 0
  for (const hint of ENTRY_HINTS) {
    if (hint.re.test(src)) score = Math.max(score, hint.score)
  }
  return score
}

export function pickEntryChunks(html: string, pageUrl: string, limit = MAX_CHUNKS): string[] {
  const candidates = new Map<string, ScriptCandidate>()

  const visit = (raw: string) => {
    let absolute: string
    try {
      absolute = new URL(raw, pageUrl).toString()
    } catch {
      return
    }
    if (!/^https?:/.test(absolute)) return
    const score = scoreScript(absolute)
    if (score === 0) return
    const existing = candidates.get(absolute)
    if (!existing || existing.score < score) {
      candidates.set(absolute, { url: absolute, score })
    }
  }

  for (const m of html.matchAll(SCRIPT_SRC_RE)) visit(m[1]!)
  for (const m of html.matchAll(MODULEPRELOAD_RE)) visit(m[1]!)

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(c => c.url)
}

async function fetchChunk(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, 'accept': '*/*' },
    })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let received = 0
    while (received < MAX_BYTES_PER_CHUNK) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    try { await reader.cancel() } catch { /* noop */ }
    return text
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function scanJsText(text: string): { signals: DetectionSignal[], nuxtVersion: string | null } {
  const signals: DetectionSignal[] = []
  for (const sig of JS_SIGNALS) {
    if (sig.re.test(text)) {
      signals.push({ name: sig.name, weight: sig.weight })
    }
  }
  // Match Nuxt's own version, anchored so we don't also match `nuxtI18n` / `nuxtImage` /
  // other modules that register themselves on `nuxt.versions.<name>` in the same bundle.
  const Q = `["'\`]`
  const candidates = [
    new RegExp(String.raw`\bget\s+nuxt\s*\([^)]*\)\s*\{[^}]*?return\s*${Q}v?(\d+\.\d+\.\d+)`, 'i'),
    new RegExp(String.raw`(?:^|[\s,{;])(?:_{0,2}NUXT_VERSION_{0,2})\s*[:=]\s*${Q}v?(\d+\.\d+\.\d+)`, 'i'),
    new RegExp(String.raw`${Q}nuxt${Q}\s*:\s*${Q}v?(\d+\.\d+\.\d+)`, 'i'),
    new RegExp(String.raw`\bversions\s*:\s*\{[^}]*?\bnuxt\s*:\s*${Q}v?(\d+\.\d+\.\d+)`, 'i'),
  ]
  let nuxtVersion: string | null = null
  for (const re of candidates) {
    const m = text.match(re)
    if (m && isPlausibleNuxtVersion(m[1]!)) {
      nuxtVersion = m[1]!
      break
    }
  }
  return { signals, nuxtVersion }
}

export interface ScanJsOptions {
  /** Maximum number of entry chunks to fetch (default 3). */
  limit?: number
}

export async function scanReferencedJs(html: string, pageUrl: string, options: ScanJsOptions = {}): Promise<JsScanResult> {
  const chunkUrls = pickEntryChunks(html, pageUrl, options.limit ?? MAX_CHUNKS)
  if (chunkUrls.length === 0) return { signals: [], fetched: 0, nuxtVersion: null }

  const results = await Promise.all(chunkUrls.map(fetchChunk))
  const allSignalNames = new Set<string>()
  const signals: DetectionSignal[] = []
  let nuxtVersion: string | null = null
  let fetched = 0

  for (let i = 0; i < results.length; i++) {
    const text = results[i]
    if (!text) continue
    fetched++
    const local = scanJsText(text)
    for (const s of local.signals) {
      if (allSignalNames.has(s.name)) continue
      allSignalNames.add(s.name)
      signals.push({ ...s, detail: chunkUrls[i] })
    }
    if (!nuxtVersion && local.nuxtVersion) nuxtVersion = local.nuxtVersion
  }

  return { signals, fetched, nuxtVersion }
}

export interface DetectionSignal {
  name: string
  weight: number
  detail?: string | undefined
}

export interface DetectionResult {
  isNuxt: boolean
  confidence: number
  nuxtVersion: string | null
  signals: DetectionSignal[]
}

// Strict semver capture only - avoids matching `"nuxt": "^4.0.0"` or `"nuxt": "next"`.
const NUXT_VERSION_FROM_BUILD = /"nuxt"\s*:\s*"v?(\d+\.\d+\.\d+)"/

function plausibleMajor(version: string): boolean {
  const major = Number(version.split('.')[0])
  return Number.isFinite(major) && major >= 2
}

export function detectFromHtml(html: string, headers: Headers): DetectionResult {
  const signals: DetectionSignal[] = []
  let nuxtVersion: string | null = null

  if (/<div[^>]+id=["']__nuxt["']/i.test(html)) {
    signals.push({ name: 'div#__nuxt', weight: 5 })
  }
  if (/<div[^>]+id=["']__nuxt-loading["']/i.test(html)) {
    signals.push({ name: 'div#__nuxt-loading', weight: 3 })
  }

  const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)
  if (genMatch && /nuxt/i.test(genMatch[1]!)) {
    signals.push({ name: 'meta[generator]', weight: 5, detail: genMatch[1] })
    const vMatch = genMatch[1]!.match(/nuxt[^\d]*(\d+(?:\.\d+){0,2})/i)
    if (vMatch && plausibleMajor(vMatch[1]!)) nuxtVersion = vMatch[1]!
  }

  if (/<script[^>]+id=["']__NUXT_DATA__["']/i.test(html)) {
    signals.push({ name: 'script#__NUXT_DATA__', weight: 5 })
  }
  if (/window\.__NUXT__\s*=/.test(html)) {
    signals.push({ name: 'window.__NUXT__', weight: 5 })
  }
  if (/\/_nuxt\//.test(html)) {
    signals.push({ name: '/_nuxt/ assets', weight: 4 })
  }
  if (/\/_payload\.js/.test(html) || /\/_payload\.json/.test(html)) {
    signals.push({ name: 'nuxt payload', weight: 3 })
  }
  if (/<(nuxt-link|nuxt-img|NuxtLink|NuxtImg)\b/.test(html)) {
    signals.push({ name: 'nuxt component tag', weight: 2 })
  }
  // vue-meta marker shipped by Nuxt 2's @nuxtjs/head; also emitted by vanilla Vue + vue-meta,
  // so kept sub-threshold so it can't trigger detection on its own.
  if (/\sdata-n-head(?:-ssr)?\s*=/.test(html)) {
    signals.push({ name: 'data-n-head (Nuxt 2)', weight: 4 })
  }

  const xPowered = headers.get('x-powered-by')
  if (xPowered && /nuxt/i.test(xPowered)) {
    signals.push({ name: 'x-powered-by', weight: 3, detail: xPowered })
  }

  if (!nuxtVersion) {
    const m = html.match(NUXT_VERSION_FROM_BUILD)
    if (m && plausibleMajor(m[1]!)) nuxtVersion = m[1]!
  }

  const confidence = signals.reduce((sum, s) => sum + s.weight, 0)
  return {
    isNuxt: confidence >= 5,
    confidence,
    nuxtVersion,
    signals,
  }
}

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright'
import { consola } from 'consola'

const log = consola.withTag('headless')

// In production the bundled Nitro output lives at `.output/server/` with the extension
// copied separately into the image; the env var lets the Dockerfile point at the
// absolute install location. In dev `import.meta.url` resolves to this file's location
// and `../vendor/isdcac` (relative to `src/`) is the dev tree.
const EXTENSION_DIR = process.env.EXTENSION_DIR
  || fileURLToPath(new URL('../vendor/isdcac', import.meta.url))
const EXTENSION_STAMP = join(EXTENSION_DIR, '.nuxt-fyi-stamp.json')
const EXTENSION_MANIFEST = join(EXTENSION_DIR, 'manifest.json')
const EXTENSION_AVAILABLE = existsSync(EXTENSION_MANIFEST) && existsSync(EXTENSION_STAMP)

if (!EXTENSION_AVAILABLE) {
  // The stamp file is only written after sha256 verification in scripts/fetch-extension.mjs;
  // refuse to load an extension dir without one.
  const msg = existsSync(EXTENSION_MANIFEST)
    ? `extension at ${EXTENSION_DIR} has no integrity stamp; refusing to load. Run \`pnpm install-extension\` to refetch.`
    : `extension not found at ${EXTENSION_DIR}. Run \`pnpm install-extension\` to fetch it.`
  if (process.env.NODE_ENV === 'production') throw new Error(msg)
  log.warn(msg)
}
else {
  try {
    const stamp = JSON.parse(readFileSync(EXTENSION_STAMP, 'utf8')) as { version: string, sha256: string }
    log.info(`loaded I-Still-Dont-Care-About-Cookies v${stamp.version} (sha256 ${stamp.sha256.slice(0, 12)}…)`)
  }
  catch { /* noop */ }
}

let contextPromise: Promise<BrowserContext> | null = null
let profileDir: string | null = null
let contextAlive = false

async function launchContext(): Promise<BrowserContext> {
  profileDir = mkdtempSync(join(tmpdir(), 'nuxt-fyi-chromium-'))
  const args: string[] = []
  if (EXTENSION_AVAILABLE) {
    args.push(
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    )
  }
  // launchPersistentContext is required because Chromium only loads unpacked extensions
  // when given a user-data-dir. The profile is torn down on close.
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: 'chromium',
    args,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (compatible; NuxtFyi/0.1; +https://nuxt.fyi)',
  })
  contextAlive = true
  ctx.on('close', () => {
    contextAlive = false
    log.warn('browser context closed unexpectedly; next scan will rebuild')
  })
  return ctx
}

async function getContext(): Promise<BrowserContext> {
  if (contextPromise) {
    try {
      const ctx = await contextPromise
      if (contextAlive) return ctx
    }
    catch (err) {
      log.warn(`cached context rejected: ${(err as Error).message}; rebuilding`)
    }
    // Cached promise resolved to a dead context, or rejected outright. Tear down whatever
    // state remains and re-launch on this call.
    await closeBrowser()
  }
  contextPromise = launchContext()
  return contextPromise
}

export async function closeBrowser(): Promise<void> {
  contextAlive = false
  if (!contextPromise) return
  try { (await contextPromise).close() } catch { /* noop */ }
  contextPromise = null
  if (profileDir) {
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* noop */ }
    profileDir = null
  }
}

const GTM_CONSENT_COOKIE = {
  name: 'gtm_cookie_consent',
  value: 'functional:1|analytics:1|customization:1|advertising:1',
}

const CONSENT_HIDE_CSS = `
  [id*="cookie" i],
  [class*="cookie-banner" i],
  [class*="cookie-consent" i],
  [class*="cookieConsent" i],
  [id^="onetrust-" i],
  [class^="onetrust-" i],
  #CybotCookiebotDialog,
  #CookiebotWidget,
  .didomi-notice,
  #didomi-host,
  [aria-label*="consent" i],
  [aria-label*="cookie" i],
  [data-testid*="cookie" i],
  [data-cy*="cookie" i],
  div.fc-consent-root,
  div.qc-cmp2-container,
  .truste_overlay,
  .truste_box_overlay {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  html, body { overflow: auto !important; }
`

export interface ScreenshotResult {
  bytes: Buffer
  width: number
  height: number
}

/**
 * Captures a JPEG screenshot of `url` and returns the bytes in memory along with the
 * viewport dimensions. The scanner streams the bytes straight to ImageKit; nothing is
 * written to disk. The `budgetMs` ceiling caps how long any single capture can hold a
 * browser page open regardless of which inner step hangs (goto, banner sweep, capture).
 */
export async function screenshot(url: string, domain: string, budgetMs: number): Promise<ScreenshotResult> {
  return await Promise.race([
    captureScreenshot(url, domain),
    new Promise<ScreenshotResult>((_, reject) => {
      setTimeout(
        () => reject(new Error(`screenshot budget of ${budgetMs}ms exceeded`)),
        budgetMs,
      ).unref()
    }),
  ])
}

const VIEWPORT_WIDTH = 1280
const VIEWPORT_HEIGHT = 800

async function captureScreenshot(url: string, domain: string): Promise<ScreenshotResult> {
  const context = await getContext()

  let parsedDomain = domain
  try { parsedDomain = new URL(url).hostname } catch { /* noop */ }

  await context.addCookies([
    { ...GTM_CONSENT_COOKIE, domain: parsedDomain, path: '/' },
    { ...GTM_CONSENT_COOKIE, domain: `.${parsedDomain.replace(/^www\./, '')}`, path: '/' },
  ]).catch(() => { /* invalid domain */ })

  const page = await context.newPage()
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cookieconsent_status', 'allow')
      localStorage.setItem('cookie-consent', 'accepted')
      localStorage.setItem('OptanonAlertBoxClosed', new Date().toISOString())
    } catch { /* noop */ }
  })

  page.setDefaultTimeout(10_000)
  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 12_000 })
    }
    catch {
      // Many news sites fire perpetual analytics beacons and never reach networkidle;
      // settle for DOM-ready, and if even that times out screenshot whatever's painted.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8_000 }).catch(() => { /* noop */ })
    }

    await page.waitForTimeout(800)
    await page.addStyleTag({ content: CONSENT_HIDE_CSS }).catch(() => { /* noop */ })
    await hideViewportOverlays(page).catch(() => { /* noop */ })
    await page.waitForTimeout(200)

    const bytes = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      fullPage: false,
      timeout: 30_000,
    })
    return { bytes, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }
  } finally {
    await page.close().catch(() => { /* noop */ })
  }
}

/**
 * Hides fixed/absolute high-z-index overlays that cover most of the viewport. Catches
 * subscription paywalls, newsletter modals, and "sign up" interstitials that the cookie-banner
 * extension ignores. The text-length cap prevents hiding real content that happens to be
 * position:fixed.
 */
async function hideViewportOverlays(page: import('playwright').Page): Promise<number> {
  return page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const viewportArea = vw * vh
    let hidden = 0
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      if (parseFloat(cs.opacity) < 0.1) continue
      const z = parseInt(cs.zIndex, 10) || 0
      if (z < 100) continue
      const r = el.getBoundingClientRect()
      if (r.width < 200 || r.height < 200) continue
      const overlapW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))
      const overlapH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
      if ((overlapW * overlapH) / viewportArea < 0.25) continue
      const text = (el.textContent || '').trim()
      if (text.length > 2000) continue
      el.style.setProperty('display', 'none', 'important')
      hidden++
    }
    return hidden
  })
}

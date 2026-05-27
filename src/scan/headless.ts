import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright'
import { config } from '../config.ts'
import { log } from '../log.ts'

mkdirSync(config.screenshotDir, { recursive: true })

const EXTENSION_DIR = fileURLToPath(new URL('../../vendor/isdcac', import.meta.url))
const EXTENSION_STAMP = join(EXTENSION_DIR, '.nuxt-fyi-stamp.json')
const EXTENSION_MANIFEST = join(EXTENSION_DIR, 'manifest.json')
const EXTENSION_AVAILABLE = existsSync(EXTENSION_MANIFEST) && existsSync(EXTENSION_STAMP)

if (!EXTENSION_AVAILABLE) {
  // The stamp file is only written after sha256 verification in scripts/fetch-extension.mjs;
  // refuse to load an extension dir without one.
  const msg = existsSync(EXTENSION_MANIFEST)
    ? `[headless] extension at ${EXTENSION_DIR} has no integrity stamp; refusing to load. Run \`pnpm install-extension\` to refetch.`
    : `[headless] extension not found at ${EXTENSION_DIR}. Run \`pnpm install-extension\` to fetch it.`
  if (process.env.NODE_ENV === 'production') throw new Error(msg)
  log.warn(msg)
}
else {
  try {
    const stamp = JSON.parse(readFileSync(EXTENSION_STAMP, 'utf8')) as { version: string, sha256: string }
    log.info(`[headless] loaded I-Still-Dont-Care-About-Cookies v${stamp.version} (sha256 ${stamp.sha256.slice(0, 12)}…)`)
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
    log.warn('[headless] browser context closed unexpectedly; next scan will rebuild')
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
      log.warn(`[headless] cached context rejected: ${(err as Error).message}; rebuilding`)
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

/**
 * Overall budget for one screenshot pipeline (cookies, goto, banner sweep, capture).
 * Inner steps have their own shorter timeouts; this is the safety net that ensures we
 * never spend more than this on a single domain regardless of which step hangs.
 */
const SCREENSHOT_TOTAL_BUDGET_MS = 60_000

export async function screenshot(url: string, domain: string): Promise<string> {
  return await Promise.race([
    captureScreenshot(url, domain),
    new Promise<string>((_, reject) => {
      setTimeout(
        () => reject(new Error(`screenshot budget of ${SCREENSHOT_TOTAL_BUDGET_MS}ms exceeded`)),
        SCREENSHOT_TOTAL_BUDGET_MS,
      ).unref()
    }),
  ])
}

async function captureScreenshot(url: string, domain: string): Promise<string> {
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

    const screenshotPath = join(config.screenshotDir, `${safeName(domain)}.jpg`)
    await page.screenshot({
      path: screenshotPath,
      type: 'jpeg',
      quality: 80,
      fullPage: false,
      timeout: 30_000,
    })
    return screenshotPath
  } finally {
    await page.close().catch(() => { /* noop */ })
  }
}

function safeName(domain: string): string {
  return domain.replace(/[^a-z0-9.-]/gi, '_')
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

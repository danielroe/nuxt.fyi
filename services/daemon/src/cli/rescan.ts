#!/usr/bin/env node
/**
 * Admin CLI for re-scanning one or more domains. Designed to be invoked over `fly ssh
 * console` against the running daemon machine: it shares the same SQLite database
 * (WAL-safe alongside the daemon writer) and the same screenshot directory, but launches
 * its own Chromium context rather than reusing the daemon's. That means a cold-start
 * penalty (~2s for the first domain) and no respect for the daemon's concurrency cap; in
 * exchange the CLI works even if the daemon process is wedged, and you get synchronous
 * stdout output instead of "queued, check the logs in a bit".
 *
 * Always forces (i.e. ignores `RESCAN_AFTER_MS`), because an admin invoking this
 * deliberately doesn't want it silently skipping work as "too recent".
 */
import { parseArgs } from 'node:util'
import { log } from '../log.ts'
import { recaptureImage, scanDomain } from '../scan/index.ts'
import { dispatchNotifications, persistOutcome } from '../pipeline.ts'
import { getScan, recordRescanImage } from '../store.ts'

const USAGE = `usage: rescan [--no-notify] [--screenshot-only] [--verbose] <domain>...

Re-runs a scan for one or more domains, writing to the same SQLite database the daemon
uses. Pass --screenshot-only to skip detection and only refresh the og:image + screenshot
on an existing Nuxt hit. Pass --no-notify to suppress Discord + Bluesky posts.`

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'no-notify': { type: 'boolean', default: false },
    'screenshot-only': { type: 'boolean', default: false },
    'verbose': { type: 'boolean', short: 'v', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
})

if (values.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

if (positionals.length === 0) fail(USAGE)

if (values.verbose) process.env.VERBOSE = '1'

function normalise(input: string): string {
  return input.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
}

const domains = positionals.map(normalise)

interface Result {
  domain: string
  ok: boolean
  mode: 'full' | 'screenshot-only'
  isNuxt?: boolean
  nuxtVersion?: string | null
  confidence?: number
  finalUrl?: string | null
  ogImage?: string | null
  screenshotPath?: string | null
  screenshotKey?: string | null
  ogImageKey?: string | null
  notified?: boolean
  error?: string | null
}

const results: Result[] = []

for (const domain of domains) {
  if (values['screenshot-only']) {
    const existing = getScan(domain)
    if (!existing || !existing.is_nuxt) {
      log.error(`[rescan] ${domain} has no confirmed Nuxt hit; run without --screenshot-only first`)
      results.push({
        domain,
        ok: false,
        mode: 'screenshot-only',
        error: 'no confirmed Nuxt hit for this domain',
      })
      continue
    }
    try {
      const out = await recaptureImage(domain)
      recordRescanImage({
        domain,
        finalUrl: out.finalUrl,
        title: out.title,
        screenshotPath: out.screenshotPath,
        ogImage: out.ogImage,
        screenshotKey: out.screenshotKey,
        ogImageKey: out.ogImageKey,
        nsfwLabel: out.nsfwLabel,
        nsfwScore: out.nsfwScore,
        nsfwCategories: out.nsfwCategories,
        nsfwClassifiedAt: out.nsfwClassifiedAt,
        error: out.error,
      })
      log.success(`[rescan] ${domain} image refreshed (og:${out.ogImage ? 'yes' : 'no'} shot:${out.screenshotPath ? 'yes' : 'no'} ik-shot:${out.screenshotKey ? 'yes' : 'no'} ik-og:${out.ogImageKey ? 'yes' : 'no'} nsfw:${out.nsfwLabel ?? 'unknown'})`)
      results.push({
        domain,
        ok: !out.error,
        mode: 'screenshot-only',
        finalUrl: out.finalUrl,
        ogImage: out.ogImage,
        screenshotPath: out.screenshotPath,
        error: out.error,
      })
    }
    catch (err) {
      const message = (err as Error).message
      log.error(`[rescan] ${domain} failed: ${message}`)
      results.push({ domain, ok: false, mode: 'screenshot-only', error: message })
    }
    continue
  }

  try {
    const outcome = await scanDomain(domain)
    persistOutcome(outcome)
    let notified = false
    if (outcome.detection.isNuxt && !values['no-notify']) {
      await dispatchNotifications(outcome)
      notified = true
    }
    log.info(`[rescan] ${domain} done (nuxt=${outcome.detection.isNuxt} confidence=${outcome.detection.confidence} ik-shot:${outcome.screenshotKey ? 'yes' : 'no'} ik-og:${outcome.ogImageKey ? 'yes' : 'no'})`)
    results.push({
      domain,
      ok: !outcome.error,
      mode: 'full',
      isNuxt: outcome.detection.isNuxt,
      nuxtVersion: outcome.detection.nuxtVersion,
      confidence: outcome.detection.confidence,
      finalUrl: outcome.finalUrl,
      ogImage: outcome.ogImage,
      screenshotPath: outcome.screenshotPath,
      screenshotKey: outcome.screenshotKey,
      ogImageKey: outcome.ogImageKey,
      notified,
      error: outcome.error,
    })
  }
  catch (err) {
    const message = (err as Error).message
    log.error(`[rescan] ${domain} failed: ${message}`)
    results.push({ domain, ok: false, mode: 'full', error: message })
  }
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)

const anyFailed = results.some(r => !r.ok)
process.exit(anyFailed ? 1 : 0)

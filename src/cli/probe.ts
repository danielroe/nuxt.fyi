#!/usr/bin/env node
import { scanDomain } from '../scan/index.ts'
import { closeBrowser } from '../scan/headless.ts'

const target = process.argv[2]
if (!target) {
  console.error('usage: probe <domain-or-url>')
  process.exit(2)
}

const domain = target.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const outcome = await scanDomain(domain)
console.log(JSON.stringify({
  domain: outcome.domain,
  isNuxt: outcome.detection.isNuxt,
  confidence: outcome.detection.confidence,
  nuxtVersion: outcome.detection.nuxtVersion,
  signals: outcome.detection.signals,
  finalUrl: outcome.finalUrl,
  title: outcome.title,
  screenshotPath: outcome.screenshotPath,
  error: outcome.error,
}, null, 2))
await closeBrowser()

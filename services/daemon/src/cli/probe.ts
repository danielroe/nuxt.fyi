#!/usr/bin/env node
import { scanDomain } from '../scan/index.ts'

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
  screenshotKey: outcome.screenshotKey,
  ogImageKey: outcome.ogImageKey,
  error: outcome.error,
}, null, 2))


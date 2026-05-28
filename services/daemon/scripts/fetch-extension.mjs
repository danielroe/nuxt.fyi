#!/usr/bin/env node
// Downloads the I-Still-Dont-Care-About-Cookies Chrome extension as an unpacked directory
// at vendor/isdcac/. Idempotent: if the manifest already exists and matches the pinned
// version, exits with no work.
//
// We pin the SHA-256 of the release artefact (not just the tag) so a tag-re-release attack
// or a network-level swap is caught at install time. Update VERSION + SHA256 together; the
// GitHub release API exposes the hash at:
//   https://api.github.com/repos/OhMyGuus/I-Still-Dont-Care-About-Cookies/releases/tags/<tag>
// (look at assets[].digest)

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const VERSION = '1.1.9'
const SHA256 = '8f70ab947cb2d274f4022a970f5dd3cecd8ec02b060e05187bef9ee3cb18bbcb'
const ASSET = `https://github.com/OhMyGuus/I-Still-Dont-Care-About-Cookies/releases/download/v${VERSION}/ISDCAC-chrome-source.zip`

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const target = join(root, 'vendor', 'isdcac')
const manifestPath = join(target, 'manifest.json')
const stampPath = join(target, '.nuxt-fyi-stamp.json')

if (existsSync(manifestPath) && existsSync(stampPath)) {
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    if (stamp.version === VERSION && stamp.sha256 === SHA256) {
      console.log(`[fetch-extension] isdcac v${VERSION} already present and verified`)
      process.exit(0)
    }
    console.log(`[fetch-extension] stamp mismatch (have v${stamp.version} sha=${stamp.sha256?.slice(0, 8)}, want v${VERSION} sha=${SHA256.slice(0, 8)}); replacing`)
  } catch {
    /* fall through to redownload */
  }
  rmSync(target, { recursive: true, force: true })
}

mkdirSync(target, { recursive: true })
const zipPath = join(root, 'vendor', `isdcac-${VERSION}.zip`)

console.log(`[fetch-extension] downloading ${ASSET}`)
execSync(`curl -fsSL "${ASSET}" -o "${zipPath}"`, { stdio: 'inherit' })

// Verify SHA-256 before we unpack anything from the archive. A mismatch means the artefact
// at that URL is not what we audited; we refuse to unpack and exit non-zero so CI fails loudly.
const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
if (actual !== SHA256) {
  rmSync(zipPath)
  rmSync(target, { recursive: true, force: true })
  console.error(`[fetch-extension] FATAL: sha256 mismatch`)
  console.error(`  expected: ${SHA256}`)
  console.error(`  actual:   ${actual}`)
  console.error(`  url:      ${ASSET}`)
  console.error(`  Refusing to load an unverified extension. If you have intentionally bumped`)
  console.error(`  the version, update both VERSION and SHA256 in scripts/fetch-extension.mjs.`)
  process.exit(1)
}

console.log(`[fetch-extension] sha256 verified (${actual.slice(0, 16)}...)`)
console.log(`[fetch-extension] unpacking to ${target}`)
execSync(`unzip -q -o "${zipPath}" -d "${target}"`, { stdio: 'inherit' })
rmSync(zipPath)

writeFileSync(stampPath, JSON.stringify({ version: VERSION, sha256: SHA256, installedAt: new Date().toISOString() }, null, 2))

console.log(`[fetch-extension] done`)

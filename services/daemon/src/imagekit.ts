import ImageKit, { toFile } from '@imagekit/nodejs'
import { config } from './config.ts'
import { log } from './log.ts'

/**
 * Thin wrapper around @imagekit/nodejs for the daemon's og:image uploads. The screenshot
 * half of this lives on the scanner service (which has the JPEG bytes in memory already);
 * the daemon only owns og:image uploads because it already has the URL from `scanHtml`.
 * All failures are best-effort: returning null lets the caller render whichever source
 * is still available.
 */

let client: ImageKit | null = null
let warnedDisabled = false

function getClient(): ImageKit | null {
  if (client) return client
  if (!config.imagekit.privateKey || !config.imagekit.urlEndpoint) {
    if (!warnedDisabled) {
      warnedDisabled = true
      const missing = [
        !config.imagekit.urlEndpoint && 'IMAGEKIT_URL_ENDPOINT',
        !config.imagekit.privateKey && 'IMAGEKIT_PRIVATE_KEY',
      ].filter(Boolean).join(', ')
      log.warn(`[imagekit] uploads disabled: missing ${missing}`)
    }
    return null
  }
  client = new ImageKit({ privateKey: config.imagekit.privateKey })
  log.info(`[imagekit] uploads enabled (endpoint=${config.imagekit.urlEndpoint} folder=${config.imagekit.rootFolder})`)
  return client
}

export function imagekitEnabled(): boolean {
  return getClient() !== null
}

/**
 * Strips a domain to filesystem-safe characters. Mirrors the scanner's naming convention
 * so the og:image and screenshot paths can be derived from a domain alone.
 */
function safeName(domain: string): string {
  return domain.replace(/[^a-z0-9.-]/gi, '_')
}

/**
 * Extension from a content-type header, defaulting to `.jpg`. ImageKit infers content
 * type from extension on delivery, so getting this right matters for non-JPEG og:images.
 */
function extensionFromMime(type: string | null | undefined): string {
  if (!type) return 'jpg'
  const main = type.split(';')[0]!.trim().toLowerCase()
  switch (main) {
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/avif': return 'avif'
    case 'image/svg+xml': return 'svg'
    default: return 'jpg'
  }
}

interface UploadOk {
  /** Path inside the bucket, e.g. `/nuxt-fyi/screenshots/example.com.jpg`. This is what
   *  @nuxt/image uses as `src`; it's appended to the URL endpoint at render time. */
  filePath: string
  /** Absolute delivery URL. Stored for completeness / Bluesky use; the dashboard prefers
   *  the relative `filePath` so it can pick its own transforms. */
  url: string
}

type UploadFile = Parameters<NonNullable<ReturnType<typeof getClient>>['files']['upload']>[0]['file']

async function doUpload(
  file: UploadFile,
  fileName: string,
  folder: string,
): Promise<UploadOk | null> {
  const c = getClient()
  if (!c) return null
  try {
    const response = await c.files.upload({
      file,
      fileName,
      folder,
      useUniqueFileName: false,
      overwriteFile: true,
    })
    if (!response.filePath || !response.url) {
      log.warn(`[imagekit] upload returned no filePath/url for ${folder}/${fileName}`)
      return null
    }
    return { filePath: response.filePath, url: response.url }
  }
  catch (err) {
    log.warn(`[imagekit] upload failed for ${folder}/${fileName}: ${(err as Error).message}`)
    return null
  }
}

/**
 * Fetches an upstream og:image URL, then uploads the bytes to ImageKit. The fetch is
 * bounded to prevent a slow CDN from blocking the scan pipeline; oversized images (>10MB)
 * are rejected so we don't burn ImageKit storage on assets that wouldn't render well
 * anyway. Returns the bucket-relative path on success, null otherwise.
 */
const OG_FETCH_TIMEOUT_MS = 10_000
const OG_MAX_BYTES = 10 * 1024 * 1024

export async function uploadOgImage(domain: string, ogImageUrl: string): Promise<UploadOk | null> {
  if (!imagekitEnabled()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(ogImageUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NuxtFyi/0.1; +https://nuxt.fyi)' },
    })
    if (!res.ok) {
      log.warn(`[imagekit] og:image ${ogImageUrl} returned ${res.status}`)
      return null
    }
    const type = res.headers.get('content-type')
    if (!type || !/^image\//i.test(type)) {
      log.warn(`[imagekit] og:image ${ogImageUrl} has non-image content-type ${type}`)
      return null
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > OG_MAX_BYTES) {
      log.warn(`[imagekit] og:image ${ogImageUrl} is ${buf.byteLength} bytes; skipping`)
      return null
    }
    const ext = extensionFromMime(type)
    const file = await toFile(buf, `${safeName(domain)}.${ext}`)
    return doUpload(file, `${safeName(domain)}.${ext}`, `${config.imagekit.rootFolder}/og-images`)
  }
  catch (err) {
    log.warn(`[imagekit] og:image fetch/upload failed for ${domain}: ${(err as Error).message}`)
    return null
  }
  finally {
    clearTimeout(timer)
  }
}

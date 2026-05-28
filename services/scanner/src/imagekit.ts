import ImageKit, { toFile } from '@imagekit/nodejs'
import { consola } from 'consola'

const log = consola.withTag('imagekit')

let client: ImageKit | null = null
let warnedDisabled = false

interface ImagekitConfig {
  urlEndpoint: string
  privateKey: string
  rootFolder: string
}

function getClient(cfg: ImagekitConfig): ImageKit | null {
  if (client) return client
  if (!cfg.privateKey || !cfg.urlEndpoint) {
    if (!warnedDisabled) {
      warnedDisabled = true
      const missing = [
        !cfg.urlEndpoint && 'IMAGEKIT_URL_ENDPOINT',
        !cfg.privateKey && 'IMAGEKIT_PRIVATE_KEY',
      ].filter(Boolean).join(', ')
      log.warn(`uploads disabled: missing ${missing}`)
    }
    return null
  }
  client = new ImageKit({ privateKey: cfg.privateKey })
  log.info(`uploads enabled (endpoint=${cfg.urlEndpoint} folder=${cfg.rootFolder})`)
  return client
}

function safeName(domain: string): string {
  return domain.replace(/[^a-z0-9.-]/gi, '_')
}

export interface UploadOk {
  filePath: string
  url: string
}

/**
 * ImageKit free tier caps single files at 25MB. Our 1280x800 quality-80 JPEGs are ~80-
 * 150KB so this is purely defence-in-depth (a future viewport bump or fullPage=true
 * change could blow past it).
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/**
 * Uploads a screenshot JPEG buffer to ImageKit at `<rootFolder>/screenshots/<domain>.jpg`.
 * Same path scheme the daemon used before the scanner was extracted, so existing dashboard
 * URLs and backfill rows keep resolving. Returns null on any failure or when the SDK is
 * not configured.
 */
export async function uploadScreenshot(
  domain: string,
  bytes: Buffer,
  cfg: ImagekitConfig,
): Promise<UploadOk | null> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    log.warn(`screenshot for ${domain} is ${bytes.byteLength} bytes; skipping upload`)
    return null
  }
  const c = getClient(cfg)
  if (!c) return null
  try {
    const file = await toFile(new Uint8Array(bytes), `${safeName(domain)}.jpg`)
    const response = await c.files.upload({
      file,
      fileName: `${safeName(domain)}.jpg`,
      folder: `${cfg.rootFolder}/screenshots`,
      useUniqueFileName: false,
      overwriteFile: true,
    })
    if (!response.filePath || !response.url) {
      log.warn(`upload returned no filePath/url for ${domain}`)
      return null
    }
    return { filePath: response.filePath, url: response.url }
  }
  catch (err) {
    log.warn(`upload failed for ${domain}: ${(err as Error).message}`)
    return null
  }
}

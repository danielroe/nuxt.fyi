import { defineHandler } from 'nitro'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { readBody } from 'h3'
import { consola } from 'consola'
import { screenshot } from '../src/headless.ts'
import { uploadScreenshot } from '../src/imagekit.ts'

const log = consola.withTag('capture')

interface CaptureBody {
  url: string
  domain: string
}

interface CaptureResponse {
  imageKey: string | null
  imageUrl: string | null
  width: number
  height: number
  bytes: number
  capturedAt: number
  error: string | null
}

/**
 * Captures a screenshot of `url`, uploads it to ImageKit, and returns the bucket path.
 * Both fields can come back null when their step failed independently — the daemon
 * decides whether that's acceptable (e.g. a missing screenshot still leaves the og:image
 * as a fallback). Auth is a static bearer token shared between daemon and scanner via
 * the `SCANNER_TOKEN` env var on both apps.
 */
export default defineHandler(async (event): Promise<CaptureResponse> => {
  const config = useRuntimeConfig()

  const auth = event.req.headers.get('authorization') || ''
  const expected = `Bearer ${config.scannerToken}`
  if (!config.scannerToken || auth !== expected) {
    event.res.status = 401
    return errorResponse('unauthorised')
  }

  let body: CaptureBody | undefined
  try {
    body = await readBody<CaptureBody>(event)
  }
  catch {
    event.res.status = 400
    return errorResponse('invalid json body')
  }
  if (!body || typeof body.url !== 'string' || typeof body.domain !== 'string') {
    event.res.status = 400
    return errorResponse('missing url or domain')
  }

  const startedAt = Date.now()
  try {
    const shot = await screenshot(body.url, body.domain, config.screenshotBudgetMs)
    const uploaded = await uploadScreenshot(body.domain, shot.bytes, {
      urlEndpoint: config.imagekitUrlEndpoint,
      privateKey: config.imagekitPrivateKey,
      rootFolder: config.imagekitRootFolder,
    })
    log.info(`${body.domain} captured (${shot.bytes.byteLength} bytes, ${Date.now() - startedAt}ms) ik=${uploaded ? 'yes' : 'no'}`)
    return {
      imageKey: uploaded?.filePath ?? null,
      imageUrl: uploaded?.url ?? null,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes.byteLength,
      capturedAt: Date.now(),
      error: uploaded ? null : 'imagekit upload failed',
    }
  }
  catch (err) {
    const message = (err as Error).message
    log.warn(`${body.domain} screenshot failed: ${message}`)
    event.res.status = 500
    return {
      imageKey: null,
      imageUrl: null,
      width: 0,
      height: 0,
      bytes: 0,
      capturedAt: Date.now(),
      error: `screenshot: ${message}`,
    }
  }
})

function errorResponse(message: string): CaptureResponse {
  return {
    imageKey: null,
    imageUrl: null,
    width: 0,
    height: 0,
    bytes: 0,
    capturedAt: Date.now(),
    error: message,
  }
}

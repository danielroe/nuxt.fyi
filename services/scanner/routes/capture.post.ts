import { defineHandler } from 'nitro'
import { readBody } from 'h3'
import { consola } from 'consola'
import { screenshot } from '../src/headless.ts'
import { uploadScreenshot } from '../src/imagekit.ts'
import { classify, type NsfwLabel } from '../src/nsfw.ts'

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
  nsfw: {
    label: NsfwLabel
    score: number | null
    categories: Record<string, unknown>
  } | null
  error: string | null
}

function widen(cats: object): Record<string, unknown> {
  return { ...cats } as Record<string, unknown>
}

const SCANNER_TOKEN = process.env.SCANNER_TOKEN || ''
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT || ''
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY || ''
const IMAGEKIT_ROOT_FOLDER = process.env.IMAGEKIT_ROOT_FOLDER || '/nuxt-fyi'
const SCREENSHOT_BUDGET_MS = Number(process.env.SCREENSHOT_BUDGET_MS) || 60_000

if (!SCANNER_TOKEN) {
  log.warn('SCANNER_TOKEN is empty; every /capture request will 401')
}

/**
 * Captures a screenshot of `url`, classifies the bytes via nsfwjs, then uploads to
 * ImageKit. NSFW classification doesn't gate the upload: the dashboard wants the bytes
 * available regardless of label so it can render a blurred placeholder. All three steps
 * are independently fallible; partial failures still return the parts that succeeded.
 * Auth is a static bearer token shared between daemon and scanner via the
 * `SCANNER_TOKEN` env var on both apps.
 */
export default defineHandler(async (event): Promise<CaptureResponse> => {
  const auth = event.req.headers.get('authorization') || ''
  const expected = `Bearer ${SCANNER_TOKEN}`
  if (!SCANNER_TOKEN || auth !== expected) {
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
    const shot = await screenshot(body.url, body.domain, SCREENSHOT_BUDGET_MS)
    // Classify and upload in parallel: independent operations on the same buffer.
    const [nsfw, uploaded] = await Promise.all([
      classify(shot.bytes),
      uploadScreenshot(body.domain, shot.bytes, {
        urlEndpoint: IMAGEKIT_URL_ENDPOINT,
        privateKey: IMAGEKIT_PRIVATE_KEY,
        rootFolder: IMAGEKIT_ROOT_FOLDER,
      }),
    ])
    log.info(`${body.domain} captured (${shot.bytes.byteLength} bytes, ${Date.now() - startedAt}ms) ik=${uploaded ? 'yes' : 'no'} nsfw=${nsfw?.label ?? 'unknown'}`)
    return {
      imageKey: uploaded?.filePath ?? null,
      imageUrl: uploaded?.url ?? null,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes.byteLength,
      capturedAt: Date.now(),
      nsfw: nsfw ? { label: nsfw.label, score: nsfw.score, categories: widen(nsfw.categories) } : null,
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
      nsfw: null,
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
    nsfw: null,
    error: message,
  }
}

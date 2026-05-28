// MUST be the first import in this file: patches `util.isNullOrUndefined` (removed in
// Node 22, still called by tfjs-node 4.x) before tfjs-node's module graph captures the
// missing reference. See polyfill-util.ts for the upstream issue.
import './polyfill-util.ts'
import * as tf from '@tensorflow/tfjs-node'
import * as nsfwjs from 'nsfwjs'
import { consola } from 'consola'

const log = consola.withTag('nsfw')

/**
 * nsfwjs returns probabilities for these five categories. We collapse them into a
 * three-level dashboard label via `classify()` below.
 */
export interface NsfwCategories {
  Drawing: number
  Hentai: number
  Neutral: number
  Porn: number
  Sexy: number
}

export type NsfwLabel = 'safe' | 'suggestive' | 'nsfw'

export interface NsfwResult {
  label: NsfwLabel
  score: number
  categories: NsfwCategories
}

export interface NsfwSkipped {
  label: 'safe'
  score: null
  categories: { skipped: 'too-large', bytes: number }
}

/**
 * Maximum image size we'll feed into the decoder. A 20MB PNG decodes to ~500MB of raw
 * RGBA, which can OOM the shared-cpu-2x scanner. Above this threshold we skip
 * classification and treat the image as `safe` with a skipped flag in the categories
 * blob so it's distinguishable from a confident `safe`.
 */
const MAX_CLASSIFY_BYTES = 5 * 1024 * 1024

/**
 * `Porn`/`Hentai` above this fires the `nsfw` label. Tunable per-deploy via env vars so
 * we don't have to redeploy to retune; defaults below are starting points.
 */
const PORN_THRESHOLD = parseFloat(process.env.NSFW_PORN_THRESHOLD || '0.5')
const SEXY_THRESHOLD = parseFloat(process.env.NSFW_SEXY_THRESHOLD || '0.6')

let modelPromise: Promise<nsfwjs.NSFWJS> | null = null

/**
 * Loads the bundled nsfwjs model once and caches the promise for the process lifetime.
 * Called eagerly at boot from `routes/_init.ts` so the first classify request doesn't
 * pay the ~200-500ms load cost.
 */
export function loadModel(): Promise<nsfwjs.NSFWJS> {
  if (modelPromise) return modelPromise
  modelPromise = (async () => {
    const start = Date.now()
    const model = await nsfwjs.load()
    log.info(`model loaded in ${Date.now() - start}ms`)
    return model
  })()
  modelPromise.catch((err) => {
    log.error(`model load failed: ${(err as Error).message}`)
    modelPromise = null
  })
  return modelPromise
}

function categoriesToLabel(cats: NsfwCategories): { label: NsfwLabel, score: number } {
  const nsfwScore = Math.max(cats.Porn, cats.Hentai)
  if (nsfwScore >= PORN_THRESHOLD) return { label: 'nsfw', score: nsfwScore }
  if (cats.Sexy >= SEXY_THRESHOLD) return { label: 'suggestive', score: cats.Sexy }
  const safeScore = Math.max(cats.Neutral, cats.Drawing)
  return { label: 'safe', score: safeScore }
}

/**
 * Classifies a JPEG/PNG image buffer. Returns null when the classifier isn't available
 * (model load failed at boot); returns a result with `categories: { skipped: ... }` when
 * the input exceeds the safe decode budget.
 */
export async function classify(bytes: Buffer | Uint8Array): Promise<NsfwResult | NsfwSkipped | null> {
  if (bytes.byteLength > MAX_CLASSIFY_BYTES) {
    log.debug(`skipping ${bytes.byteLength} byte image (>${MAX_CLASSIFY_BYTES})`)
    return {
      label: 'safe',
      score: null,
      categories: { skipped: 'too-large', bytes: bytes.byteLength },
    }
  }
  let model: nsfwjs.NSFWJS
  try {
    model = await loadModel()
  }
  catch {
    return null
  }
  let image: tf.Tensor3D | null = null
  try {
    image = tf.node.decodeImage(bytes instanceof Buffer ? bytes : Buffer.from(bytes), 3) as tf.Tensor3D
    const predictions = await model.classify(image)
    const categories: NsfwCategories = {
      Drawing: 0, Hentai: 0, Neutral: 0, Porn: 0, Sexy: 0,
    }
    for (const p of predictions) {
      if (p.className in categories) {
        categories[p.className as keyof NsfwCategories] = p.probability
      }
    }
    const { label, score } = categoriesToLabel(categories)
    return { label, score, categories }
  }
  catch (err) {
    log.warn(`classify failed: ${(err as Error).message}`)
    return null
  }
  finally {
    if (image) image.dispose()
  }
}

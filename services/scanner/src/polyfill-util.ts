import { createRequire } from 'node:module'

/**
 * `util.isNullOrUndefined` was removed from Node in v22; @tensorflow/tfjs-node 4.x still
 * calls it from its CJS kernel backend (`dist/nodejs_kernel_backend.js`) and TopK kernel.
 *
 * Upstream: https://github.com/tensorflow/tfjs/issues/8311. Remove this file once tfjs
 * ships a Node 22+ compatible release.
 */
const util = createRequire(import.meta.url)('util') as Record<string, unknown>
if (typeof util.isNullOrUndefined !== 'function') {
  util.isNullOrUndefined = (value: unknown): boolean => value === null || value === undefined
}

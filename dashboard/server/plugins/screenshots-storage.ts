import { resolve } from 'node:path'
import fsDriver from 'unstorage/drivers/fs-lite'

export default defineNitroPlugin(() => {
  const dir = resolve(useRuntimeConfig().screenshotDir)
  useStorage().mount('screenshots', fsDriver({ base: dir, readOnly: true }))
  console.log(`[dashboard] screenshots storage mounted at ${dir}`)
})

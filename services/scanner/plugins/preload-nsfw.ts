import { definePlugin } from 'nitro'
import { loadModel } from '../src/nsfw.ts'

/**
 * Triggers the nsfwjs model load at boot. The model is ~5MB and takes 200-500ms to
 * initialise; doing it eagerly here means the first `/capture` request after a cold
 * start doesn't pay that cost. We deliberately don't `await` — the route awaits
 * `loadModel()` itself, so if boot races with the first request it'll still resolve
 * correctly.
 */
export default definePlugin(() => {
  void loadModel()
})

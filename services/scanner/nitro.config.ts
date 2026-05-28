import { defineConfig } from 'nitro'

export default defineConfig({
  serverDir: '.',
  // Defaults are filled at runtime from the env vars listed below in `envMap`. Empty
  // strings here are placeholders so the type system stays happy; the actual values are
  // resolved per-request from `useRuntimeConfig()`.
  runtimeConfig: {
    scannerToken: process.env.SCANNER_TOKEN || '',
    imagekitUrlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || '',
    imagekitPrivateKey: process.env.IMAGEKIT_PRIVATE_KEY || '',
    imagekitRootFolder: process.env.IMAGEKIT_ROOT_FOLDER || '/nuxt-fyi',
    // Per-capture wall clock budget; the page handler also has internal step timeouts.
    screenshotBudgetMs: Number(process.env.SCREENSHOT_BUDGET_MS) || 60_000,
  },
})

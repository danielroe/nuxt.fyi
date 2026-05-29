// `NUXT_UI_ONLY=1 nuxt dev` proxies every `/api/**` request to the deployed dashboard
// (override the target with `NUXT_UI_ONLY_TARGET`) so UI work doesn't need a populated
// local SQLite database. The flag is read once at config-eval time, so it only takes
// effect for the dev session it started.
const uiOnly = !!process.env.NUXT_UI_ONLY
const uiOnlyTarget = process.env.NUXT_UI_ONLY_TARGET || 'https://nuxt.fyi'

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  modules: ['@nuxt/image'],
  runtimeConfig: {
    dataDir: '../data',
  },
  image: {
    imagekit: {
      // The endpoint is a public identifier (visible in every delivered image URL), so
      // there's nothing to hide behind an env var. Hardcoding it here means it gets baked
      // into the build output without any Docker-arg plumbing.
      baseURL: 'https://ik.imagekit.io/roe',
    },
  },
  experimental: {
    typedPages: true,
    defaults: {
      nuxtLink: {
        prefetchOn: { interaction: true },
      },
    },
  },
  routeRules: {
    '/': { swr: 1 },
    '/hits': { swr: 1 },
    '/hits/scanned_at/**': { swr: 1 },
    '/hits/rank/**': { swr: 1 },
    '/hits/seen_count/**': { swr: 1 },
    '/hits/confidence/**': { swr: 1 },
    // Domain detail pages change rarely (per scan), so a longer SWR is safe.
    '/hits/**': { swr: 300 },
    '/recent': { swr: 1 },
    '/recent/**': { swr: 1 },
    ...(uiOnly
      ? {
          // Wildcard alone wins because we omit the more-specific local-cache rules
          // below; otherwise Nitro's radix matcher prefers them and the local handler
          // still runs.
          '/api/**': { proxy: `${uiOnlyTarget}/api/**`, swr: false },
        }
      : {
          '/api/stats': { swr: 1 },
          '/api/hits/**': { swr: 300 },
        }),
  },
  app: {
    head: {
      title: 'nuxt.fyi',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Nuxt sites detected on the Bluesky firehose' },
        { name: 'theme-color', content: '#0a0a0a' },
        { property: 'og:title', content: 'nuxt.fyi' },
        { property: 'og:description', content: 'Nuxt sites detected on the Bluesky firehose' },
        { property: 'og:type', content: 'website' },
        { name: 'twitter:card', content: 'summary' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
})

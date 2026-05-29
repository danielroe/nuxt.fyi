// `NUXT_UI_ONLY=1 nuxt dev` proxies every `/api/**` request to the deployed dashboard
// (override the target with `NUXT_UI_ONLY_TARGET`) so UI work doesn't need a populated
// local SQLite database. The flag is read once at config-eval time, so it only takes
// effect for the dev session it started.
//
// `NUXT_FIXTURES=1 nuxt dev` serves static dummy data from `server/utils/fixtures.ts`
// instead of hitting SQLite or the deployed dashboard. Use it for offline UI work and
// for reproducing rendering bugs (eg. the home-page SVG overflow) without prod data.
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
  ...(uiOnly
    ? {
        routeRules: {
          '/api/**': { proxy: `${uiOnlyTarget}/api/**`, swr: false },
        },
      }
    : {}),
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

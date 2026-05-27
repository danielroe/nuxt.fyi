export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  runtimeConfig: {
    dataDir: '../data',
    screenshotDir: '../screenshots',
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
    '/': { swr: true },
    '/hits': { swr: true },
    '/hits/scanned_at/**': { swr: true },
    '/hits/rank/**': { swr: true },
    '/hits/seen_count/**': { swr: true },
    '/hits/confidence/**': { swr: true },
    // Domain detail pages change rarely (per scan), so a longer SWR is safe.
    '/hits/**': { swr: 300 },
    '/recent': { swr: true },
    '/recent/**': { swr: true },
    '/api/stats': { swr: true },
    '/api/hits/**': { swr: 300 },
    '/api/screenshots/**': { headers: { 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' } },
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

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

const home: RouteLocationRaw = { name: 'index' }
const hitsList: RouteLocationRaw = { name: 'hits-list', params: {} }
const recent: RouteLocationRaw = { name: 'recent', params: {} }

// Apply the user's image preference as an `image-mode-*` class on <html> before any
// other JS runs.
onPrehydrate(() => {
  try {
    const stored = localStorage.getItem('nuxt-fyi:image-mode')
    if (stored === 'screenshot' || stored === 'og') {
      document.documentElement.classList.add('image-mode-' + stored)
    }
  }
  catch { /* localStorage unavailable: leave default (auto) */ }
})

const mainRef = ref<HTMLElement | null>(null)
const router = useRouter()

router.afterEach((to, from) => {
  if (to.path === from.path) return
  nextTick(() => {
    const el = mainRef.value
    if (!el) return
    el.focus({ preventScroll: false })
  })
})
</script>

<template>
  <div class="layout">
    <a href="#main" class="skip-link">Skip to main content</a>
    <header class="site-header">
      <NuxtLink :to="home" class="site-title">nuxt.fyi</NuxtLink>
      <nav aria-label="Primary">
        <NuxtLink :to="home">overview</NuxtLink>
        <NuxtLink :to="hitsList">nuxt sites</NuxtLink>
        <NuxtLink :to="recent">recent domains</NuxtLink>
      </nav>
      <ImageModePicker />
      <a class="external header-external" href="https://github.com/danielroe/nuxt.fyi" target="_blank" rel="noopener">
        github<span class="sr-only"> (opens in a new tab)</span>
      </a>
    </header>
    <main id="main" ref="mainRef" tabindex="-1">
      <NuxtPage />
    </main>
    <footer>
      <span class="tagline">watches the bluesky firehose for sites built in nuxt.</span>
      <span class="credit">
        made with <span aria-label="love" role="img">❤️</span> by
        <a href="https://roe.dev" target="_blank" rel="noopener">daniel roe<span class="sr-only"> (opens in a new tab)</span></a>
      </span>
      <a class="external footer-external" href="https://github.com/danielroe/nuxt.fyi" target="_blank" rel="noopener">
        github<span class="sr-only"> (opens in a new tab)</span>
      </a>
    </footer>
  </div>
</template>

<style>
:root {
  --bg: #0a0a0a;
  --fg: #e5e5e5;
  /* #b3b3b3 on #0a0a0a is ~9.7:1, comfortably above the 4.5:1 floor when used for
     small text (0.8rem-0.85rem) in cards, tags, and footer credits. */
  --muted: #b3b3b3;
  /* #444 on #0a0a0a is ~3.1:1, meeting the 3:1 UI-element rule for pill borders,
     card outlines, and table dividers. */
  --border: #444;
  --accent: #00dc82;
  --accent-dim: rgba(0, 220, 130, 0.18);
  --link: #7cdfff;
  --focus-ring: #ffd54d;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
.layout { max-width: 1100px; margin: 0 auto; padding: 1rem; min-height: 100vh; display: flex; flex-direction: column; }
.skip-link { position: absolute; top: -100px; left: 0.5rem; background: var(--bg); color: var(--fg); border: 2px solid var(--accent); padding: 0.5rem 0.75rem; z-index: 100; text-decoration: none; border-radius: 3px; }
.skip-link:focus { top: 0.5rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.site-header { display: flex; align-items: baseline; gap: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); margin-bottom: 2rem; flex-wrap: wrap; }
.site-title { color: var(--accent); font-weight: 700; font-size: 1.25rem; text-decoration: none; }
.site-header nav { display: flex; gap: 1rem; flex-grow: 1; flex-wrap: wrap; }
.site-header a { color: var(--fg); text-decoration: none; padding: 0.25rem 0; white-space: nowrap; }
.site-header a.router-link-active { color: var(--accent); border-bottom: 2px solid var(--accent); }
.site-header .external { color: var(--muted); }
footer .footer-external { color: var(--muted); text-decoration: none; }
footer .footer-external:hover { color: var(--accent); }
.footer-external { display: none; }
@media (max-width: 640px) {
  .site-header { gap: 0.75rem 1rem; }
  .site-header nav { gap: 0.75rem 1rem; }
  .header-external { display: none; }
  .footer-external { display: inline; }
}
main { flex-grow: 1; }
main:focus { outline: none; }
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
footer .credit a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 2px; }
footer .credit a:hover { color: var(--accent); text-decoration-color: var(--accent); }
a { color: var(--link); }
h1, h2, h3 { font-weight: 600; }
h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; color: var(--fg); }
.tag { display: inline-block; padding: 0.1rem 0.4rem; background: var(--accent-dim); color: var(--accent); border-radius: 3px; font-size: 0.8rem; }
.muted { color: var(--muted); }

:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 2px;
}
</style>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

const home: RouteLocationRaw = { name: 'index' }
const hitsList: RouteLocationRaw = { name: 'hits-list', params: {} }
const recent: RouteLocationRaw = { name: 'recent', params: {} }
</script>

<template>
  <div class="layout">
    <header class="site-header">
      <NuxtLink :to="home" class="site-title">nuxt.fyi</NuxtLink>
      <nav>
        <NuxtLink :to="home">overview</NuxtLink>
        <NuxtLink :to="hitsList">nuxt sites</NuxtLink>
        <NuxtLink :to="recent">recent domains</NuxtLink>
      </nav>
      <a class="external" href="https://github.com/danielroe/nuxt.fyi" target="_blank" rel="noopener">github</a>
    </header>
    <main>
      <NuxtPage />
    </main>
    <footer>
      <span class="tagline">watches the bluesky firehose for sites built in nuxt.</span>
      <span class="credit">made with ❤️ by <a href="https://roe.dev" target="_blank" rel="noopener">daniel roe</a></span>
    </footer>
  </div>
</template>

<style>
:root {
  --bg: #0a0a0a;
  --fg: #e5e5e5;
  --muted: #888;
  --border: #222;
  --accent: #00dc82;
  --accent-dim: rgba(0, 220, 130, 0.15);
  --link: #61dafb;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
.layout { max-width: 1100px; margin: 0 auto; padding: 1rem; min-height: 100vh; display: flex; flex-direction: column; }
.site-header { display: flex; align-items: baseline; gap: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); margin-bottom: 2rem; flex-wrap: wrap; }
.site-title { color: var(--accent); font-weight: 700; font-size: 1.25rem; text-decoration: none; }
.site-header nav { display: flex; gap: 1rem; flex-grow: 1; flex-wrap: wrap; }
.site-header a { color: var(--fg); text-decoration: none; padding: 0.25rem 0; white-space: nowrap; }
.site-header a.router-link-active { color: var(--accent); border-bottom: 1px solid var(--accent); }
.site-header .external { color: var(--muted); }
@media (max-width: 640px) {
  .site-header { gap: 0.75rem 1rem; }
  .site-header nav { gap: 0.75rem 1rem; }
}
main { flex-grow: 1; }
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
footer .credit a { color: var(--muted); text-decoration: none; border-bottom: 1px solid var(--border); }
footer .credit a:hover { color: var(--accent); border-bottom-color: var(--accent); }
a { color: var(--link); }
h1, h2, h3 { font-weight: 600; }
h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; color: var(--muted); }
.tag { display: inline-block; padding: 0.1rem 0.4rem; background: var(--accent-dim); color: var(--accent); border-radius: 3px; font-size: 0.8rem; }
.muted { color: var(--muted); }
</style>

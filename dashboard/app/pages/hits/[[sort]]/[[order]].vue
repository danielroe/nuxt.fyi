<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

const SORTS = ['scanned_at', 'rank', 'seen_count', 'confidence'] as const
const ORDERS = ['asc', 'desc'] as const

definePageMeta({
  name: 'hits-list',
  path: `/hits/:sort(${SORTS.join('|')})?/:order(${ORDERS.join('|')})?`,
})

type Sort = typeof SORTS[number]
type Order = typeof ORDERS[number]

const SORT_OPTIONS: ReadonlyArray<{ key: Sort, label: string, defaultOrder: Order }> = [
  { key: 'scanned_at', label: 'newest', defaultOrder: 'desc' },
  { key: 'rank', label: 'most popular', defaultOrder: 'asc' },
  { key: 'seen_count', label: 'most-shared on Bluesky', defaultOrder: 'desc' },
  { key: 'confidence', label: 'highest confidence', defaultOrder: 'desc' },
]

const route = useRoute('hits-list')
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const version = computed(() => typeof route.query.version === 'string' ? route.query.version : null)
const sort = computed<Sort>(() => (route.params.sort || 'scanned_at') as Sort)
const order = computed<Order>(() => (route.params.order || 'desc') as Order)

useHead({
  title: () => {
    const opt = SORT_OPTIONS.find(o => o.key === sort.value)
    const label = opt?.label ?? 'newest'
    const p = page.value > 1 ? ` — page ${page.value}` : ''
    return `Nuxt sites (${label})${p} — nuxt.fyi`
  },
})

const { data, pending } = await useFetch('/api/hits', {
  query: computed(() => ({ page: page.value, version: version.value, sort: sort.value, order: order.value })),
})

/** Sort pill: navigates to /hits/<sort>/<order>, dropping the page param since order changes. */
function sortPath(opt: typeof SORT_OPTIONS[number]): RouteLocationRaw {
  const { page: _omit, ...rest } = route.query
  return { name: 'hits-list', params: { sort: opt.key, order: opt.defaultOrder }, query: rest }
}

function pagePath(p: number): RouteLocationRaw {
  return {
    name: 'hits-list',
    params: { sort: sort.value, order: order.value },
    query: { ...route.query, page: String(p) },
  }
}

/** Detail link: encode the current sort/order in the query so the detail page's back-link
 * can reconstruct the list URL. */
function detailPath(domain: string): RouteLocationRaw {
  return {
    name: 'hits-detail',
    params: { domain },
    query: { ...route.query, sort: sort.value, order: order.value },
  }
}
</script>

<template>
  <div>
    <h1>
      nuxt sites
      <span v-if="data" class="muted small">({{ data.total }})</span>
    </h1>

    <nav class="controls" aria-label="Sort sites">
      <span id="sort-label" class="control-label">sort:</span>
      <NuxtLink
        v-for="opt in SORT_OPTIONS"
        :key="opt.key"
        :to="sortPath(opt)"
        :class="['sort-link', { active: sort === opt.key }]"
        :aria-current="sort === opt.key ? 'true' : undefined"
      >{{ opt.label }}</NuxtLink>
    </nav>

    <div v-if="pending && !data" role="status" aria-live="polite" class="muted">loading…</div>

    <ul v-if="data" class="grid" role="list">
      <li v-for="(hit, index) in data.hits" :key="hit.domain">
        <NuxtLink :to="detailPath(hit.domain)" class="hit">
          <div class="thumb">
            <img
              v-if="hit.imageUrl"
              :src="hit.imageUrl"
              :alt="`Homepage screenshot of ${hit.domain}`"
              width="1280"
              height="800"
              :loading="index < 2 ? 'eager' : 'lazy'"
              :fetchpriority="index === 0 ? 'high' : 'auto'"
              decoding="async"
              referrerpolicy="no-referrer"
            >
            <div v-else class="no-shot" aria-hidden="true">no image</div>
          </div>
          <div class="meta">
            <div class="domain"><DomainText :domain="hit.domain" /></div>
            <div v-if="hit.title" class="title" :title="hit.title">{{ hit.title }}</div>
            <div class="tags">
              <span class="tag">{{ hit.version ? `v${hit.version}` : 'version ?' }}</span>
              <span v-if="hit.rank" class="rank" :title="`Tranco rank ${hit.rank}`">
                <span class="sr-only">Tranco rank </span>#{{ hit.rank.toLocaleString() }}
              </span>
              <span class="muted"><span class="sr-only">confidence </span>conf {{ hit.confidence }}</span>
              <span class="muted"><span class="sr-only">scanned </span><NuxtTime :datetime="hit.scannedAt" relative /></span>
            </div>
          </div>
        </NuxtLink>
      </li>
    </ul>

    <nav v-if="data && data.pageCount > 1" class="pagination" aria-label="Pagination">
      <NuxtLink
        v-if="page > 1"
        :to="pagePath(page - 1)"
        class="page-link"
        rel="prev"
      ><span aria-hidden="true">&larr; </span>prev<span class="sr-only"> page</span></NuxtLink>
      <span v-else class="page-link disabled" aria-hidden="true"><span aria-hidden="true">&larr; </span>prev</span>
      <span aria-live="polite" aria-atomic="true">
        <span class="sr-only">page </span>{{ page }}<span class="sr-only"> of </span><span aria-hidden="true"> / </span>{{ data.pageCount }}
      </span>
      <NuxtLink
        v-if="page < data.pageCount"
        :to="pagePath(page + 1)"
        class="page-link"
        rel="next"
      >next<span class="sr-only"> page</span><span aria-hidden="true"> &rarr;</span></NuxtLink>
      <span v-else class="page-link disabled" aria-hidden="true">next <span aria-hidden="true">&rarr;</span></span>
    </nav>
  </div>
</template>

<style scoped>
.controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; align-items: baseline; }
.control-label { color: var(--muted); font-size: 0.85rem; }
.sort-link { display: inline-block; background: transparent; border: 1px solid var(--border); color: var(--fg); padding: 0.25rem 0.75rem; font-family: inherit; font-size: 0.85rem; border-radius: 3px; text-decoration: none; }
.sort-link:hover { border-color: var(--accent); }
.sort-link.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; list-style: none; padding: 0; margin: 0; }
.grid > li { display: contents; }
.hit { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 4px; text-decoration: none; color: inherit; overflow: hidden; transition: border-color 0.15s; }
.hit:hover, .hit:focus-visible { border-color: var(--accent); }
.thumb { aspect-ratio: 1280/800; background: #111; overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.no-shot { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--muted); font-size: 0.85rem; }
.meta { padding: 0.75rem; }
.domain { color: var(--accent); font-weight: 600; }
.title { color: var(--muted); font-size: 0.85rem; margin: 0.25rem 0 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tags { display: flex; gap: 0.5rem; font-size: 0.8rem; flex-wrap: wrap; align-items: baseline; }
.tags .muted { color: var(--muted); }
.rank { color: #b9d; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.pagination { margin-top: 2rem; display: flex; align-items: center; gap: 1rem; justify-content: center; }
.page-link { display: inline-block; background: transparent; border: 1px solid var(--border); color: var(--fg); padding: 0.25rem 0.75rem; font-family: inherit; text-decoration: none; }
.page-link:hover { border-color: var(--accent); }
.page-link.disabled { opacity: 0.4; pointer-events: none; }
.small { font-size: 0.85rem; }
</style>

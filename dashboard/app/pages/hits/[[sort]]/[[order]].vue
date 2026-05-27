<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { fmtAge } from '~/composables/format'

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

    <nav class="controls" aria-label="Sort">
      <span class="control-label">sort:</span>
      <NuxtLink
        v-for="opt in SORT_OPTIONS"
        :key="opt.key"
        :to="sortPath(opt)"
        :class="['sort-link', { active: sort === opt.key }]"
      >{{ opt.label }}</NuxtLink>
    </nav>

    <div v-if="pending && !data" class="muted">loading\u2026</div>

    <div v-if="data" class="grid">
      <NuxtLink
        v-for="hit in data.hits"
        :key="hit.domain"
        :to="detailPath(hit.domain)"
        class="hit"
      >
        <div class="thumb">
          <img
            v-if="hit.imageUrl"
            :src="hit.imageUrl"
            :alt="`${hit.domain} preview`"
            loading="lazy"
            referrerpolicy="no-referrer"
          >
          <div v-else class="no-shot">no image</div>
        </div>
        <div class="meta">
          <div class="domain"><DomainText :domain="hit.domain" /></div>
          <div class="title" v-if="hit.title">{{ hit.title }}</div>
          <div class="tags">
            <span class="tag">{{ hit.version ? `v${hit.version}` : 'version ?' }}</span>
            <span v-if="hit.rank" class="rank" :title="`Tranco rank ${hit.rank}`">#{{ hit.rank.toLocaleString() }}</span>
            <span class="muted">conf {{ hit.confidence }}</span>
            <span class="muted">{{ fmtAge(hit.scannedAt) }}</span>
          </div>
        </div>
      </NuxtLink>
    </div>

    <nav v-if="data && data.pageCount > 1" class="pagination" aria-label="Pagination">
      <NuxtLink
        v-if="page > 1"
        :to="pagePath(page - 1)"
        class="page-link"
        rel="prev"
      >&larr; prev</NuxtLink>
      <span v-else class="page-link disabled">&larr; prev</span>
      <span>{{ page }} / {{ data.pageCount }}</span>
      <NuxtLink
        v-if="page < data.pageCount"
        :to="pagePath(page + 1)"
        class="page-link"
        rel="next"
      >next &rarr;</NuxtLink>
      <span v-else class="page-link disabled">next &rarr;</span>
    </nav>
  </div>
</template>

<style scoped>
.controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; align-items: baseline; }
.control-label { color: var(--muted); font-size: 0.85rem; }
.sort-link { display: inline-block; background: transparent; border: 1px solid var(--border); color: var(--fg); padding: 0.25rem 0.75rem; font-family: inherit; font-size: 0.85rem; border-radius: 3px; text-decoration: none; }
.sort-link:hover { border-color: var(--accent); }
.sort-link.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.hit { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 4px; text-decoration: none; color: inherit; overflow: hidden; transition: border-color 0.15s; }
.hit:hover { border-color: var(--accent); }
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

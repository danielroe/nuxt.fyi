<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import type { APIResponse } from '#shared/api'
import { sanitizeSearchTerm } from '#shared/utils/search-term'

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

const search = ref(typeof route.query.q === 'string' ? route.query.q : '')
const searchTerm = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const inputEl = ref<HTMLInputElement | null>(null)
const router = useRouter()

let inputDebounceTimer: ReturnType<typeof setTimeout> | null = null

useHead({
  title: () => {
    const opt = SORT_OPTIONS.find(o => o.key === sort.value)
    const label = opt?.label ?? 'newest'
    const p = page.value > 1 ? ` — page ${page.value}` : ''
    return `Nuxt sites (${label})${p} — nuxt.fyi`
  },
})

const { data, pending } = await useFetch<APIResponse<'/api/hits'>>('/api/hits', {
  query: computed(() => ({ page: page.value, version: version.value, sort: sort.value, order: order.value, q: searchTerm.value })),
})

watch(data, value => {
  if (!value) return
  if (page.value > 1 && value.hits.length === 0) {
    const { page: _omit, ...rest } = route.query
    router.replace({ name: 'hits-list', params: { sort: sort.value, order: order.value }, query: rest })
  }
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

/** Deep-equal for the subset of LocationQuery we care about (flat string|null|undefined). */
function queryEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a).filter(k => a[k] !== undefined)
  const bKeys = Object.keys(b).filter(k => b[k] !== undefined)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (String(a[k]) !== String(b[k])) return false
  }
  return true
}

function buildNextQuery(trimmed: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(route.query)) {
    if (k === 'q' || k === 'page') continue
    if (typeof v === 'string') next[k] = v
  }
  if (trimmed) next.q = trimmed
  return next
}

function commit(rawTerm: string) {
  const term = sanitizeSearchTerm(rawTerm)
  const next = buildNextQuery(term)
  if (queryEqual(next, route.query as Record<string, unknown>)) return
  router.replace({ name: 'hits-list', params: { sort: sort.value, order: order.value }, query: next })
}

function scheduleUpdate() {
  if (inputDebounceTimer) clearTimeout(inputDebounceTimer)
  inputDebounceTimer = setTimeout(() => commit(search.value), 300)
}

function commitNow() {
  if (inputDebounceTimer) { clearTimeout(inputDebounceTimer); inputDebounceTimer = null }
  commit(search.value)
}

function clearSearch() {
  if (inputDebounceTimer) { clearTimeout(inputDebounceTimer); inputDebounceTimer = null }
  search.value = ''
  commit('')
  nextTick(() => inputEl.value?.focus())
}

onUnmounted(() => { if (inputDebounceTimer) clearTimeout(inputDebounceTimer) })
</script>

<template>
  <div>
    <h1>
      nuxt sites
      <span v-if="data" class="muted small">({{ data.total }})</span>
    </h1>

    <nav class="controls" aria-label="Sort and search sites">
      <span id="sort-label" class="control-label">sort:</span>
      <NuxtLink
        v-for="opt in SORT_OPTIONS"
        :key="opt.key"
        :to="sortPath(opt)"
        :class="['sort-link', { active: sort === opt.key }]"
        :aria-current="sort === opt.key ? 'true' : undefined"
      >{{ opt.label }}</NuxtLink>
      <span class="search-control">
        <label for="hits-search" class="control-label">search:</label>
        <input
          id="hits-search"
          ref="inputEl"
          v-model="search"
          type="search"
          placeholder="filter sites…"
          autocomplete="off"
          spellcheck="false"
          aria-label="Filter sites by domain or title"
          @input="scheduleUpdate"
          @keydown.enter.prevent="commitNow"
        >
      </span>
    </nav>

    <div v-if="pending && !data" role="status" aria-live="polite" class="muted">loading…</div>

    <ul v-if="data && data.hits.length > 0" class="grid" role="list">
      <li v-for="(hit, index) in data.hits" :key="hit.domain">
        <NuxtLink :to="detailPath(hit.domain)" class="hit">
          <div class="thumb">
            <HitImage
              :image="hit.image"
              :alt="`Homepage screenshot of ${hit.domain}`"
              :loading="index < 2 ? 'eager' : 'lazy'"
              :fetchpriority="index === 0 ? 'high' : 'auto'"
            />
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

    <p v-else-if="data" class="muted empty" role="status">
      no sites match this filter
      <button
        v-if="searchTerm"
        type="button"
        class="empty-clear"
        @click="clearSearch"
      >clear search</button>
    </p>

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
.controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; align-items: center; }
.search-control { margin-left: auto; display: inline-flex; align-items: center; gap: 0.4rem; }
.search-control input { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 0.25rem 0.6rem; font: inherit; font-size: 0.85rem; min-width: 12rem; }
.search-control input:focus-visible { border-color: var(--accent); outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.search-control input::-webkit-search-cancel-button { cursor: pointer; }
.empty { margin: 2rem 0; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.empty-clear { background: transparent; border: 1px solid var(--border); color: var(--accent); padding: 0.2rem 0.6rem; font-family: inherit; font-size: 0.85rem; border-radius: 3px; cursor: pointer; }
.empty-clear:hover { border-color: var(--accent); }
.empty-clear:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
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

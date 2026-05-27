<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { fmtAge } from '~/composables/format'

const FILTERS = ['nuxt-only', 'not-nuxt', 'errored', 'pending'] as const
const SORTS = ['seen_count', 'first_seen', 'last_seen'] as const
const ORDERS = ['asc', 'desc'] as const

definePageMeta({
  name: 'recent',
  path: `/recent/:filter(${FILTERS.join('|')})?/:sort(${SORTS.join('|')})?/:order(${ORDERS.join('|')})?`,
})

type FilterSlug = typeof FILTERS[number] | ''
type Sort = typeof SORTS[number]
type Order = typeof ORDERS[number]

interface FilterOption {
  slug: FilterSlug
  /** value sent to /api/recent */
  value: string
  label: string
}

const FILTER_OPTIONS: readonly FilterOption[] = [
  { slug: '',          value: 'all',      label: 'all' },
  { slug: 'nuxt-only', value: 'nuxt',     label: 'Nuxt only' },
  { slug: 'not-nuxt',  value: 'not-nuxt', label: 'not Nuxt' },
  { slug: 'errored',   value: 'error',    label: 'errored' },
  { slug: 'pending',   value: 'pending',  label: 'pending' },
]

const SORT_LABELS: Record<Sort, string> = {
  seen_count: 'mentions',
  first_seen: 'first seen',
  last_seen: 'last seen',
}

const route = useRoute('recent')
const filterSlug = computed<FilterSlug>(() => (route.params.filter || '') as FilterSlug)
const activeFilter = computed(
  () => FILTER_OPTIONS.find(o => o.slug === filterSlug.value) ?? FILTER_OPTIONS[0]!,
)
const sort = computed<Sort>(() => (route.params.sort || 'last_seen') as Sort)
const order = computed<Order>(() => (route.params.order || 'desc') as Order)

const { data, pending } = await useFetch('/api/recent', {
  query: computed(() => ({
    sort: sort.value,
    order: order.value,
    filter: activeFilter.value.value,
    limit: 100,
  })),
})

useHead({
  title: () => {
    const f = activeFilter.value.label
    const scope = f === 'all' ? '' : ` (${f})`
    return `Recent domains${scope} — nuxt.fyi`
  },
})

function recentPath(filter: FilterSlug, s: Sort, o: Order): RouteLocationRaw {
  return { name: 'recent', params: { filter, sort: s, order: o } }
}

function filterPath(slug: FilterSlug): RouteLocationRaw {
  return recentPath(slug, sort.value, order.value)
}

function sortPath(key: Sort): RouteLocationRaw {
  const nextOrder: Order = sort.value === key && order.value === 'desc' ? 'asc' : 'desc'
  return recentPath(filterSlug.value, key, nextOrder)
}

function detailPath(domain: string): RouteLocationRaw {
  return { name: 'hits-detail', params: { domain } }
}

function sortIndicator(key: Sort): string {
  if (sort.value !== key) return ''
  return order.value === 'desc' ? ' \u2193' : ' \u2191'
}

/** Maps the current sort key + direction to the value of `aria-sort` on the matching
 *  column header, per the WAI ARIA grid pattern. Inactive columns get `none`. */
function ariaSortValue(key: Sort): 'ascending' | 'descending' | 'none' {
  if (sort.value !== key) return 'none'
  return order.value === 'asc' ? 'ascending' : 'descending'
}
</script>

<template>
  <div>
    <h1>recent domains</h1>
    <p class="muted small">
      every domain we've seen on Bluesky.
    </p>

    <nav class="filters" aria-label="Filter domains">
      <span class="filter-label">show:</span>
      <NuxtLink
        v-for="opt in FILTER_OPTIONS"
        :key="opt.value"
        :to="filterPath(opt.slug)"
        :class="['filter-link', { active: activeFilter.value === opt.value }]"
        :aria-current="activeFilter.value === opt.value ? 'true' : undefined"
      >{{ opt.label }}</NuxtLink>
    </nav>

    <div v-if="pending && !data" role="status" aria-live="polite" class="muted">loading…</div>

    <table v-if="data" class="rows">
      <caption class="sr-only">Recent domains observed on Bluesky, filtered by {{ activeFilter.label }}</caption>
      <thead>
        <tr>
          <th scope="col" class="domain">domain</th>
          <th scope="col" class="status">status</th>
          <th
            v-for="key in SORTS"
            :key="key"
            scope="col"
            class="num"
            :aria-sort="ariaSortValue(key)"
          >
            <NuxtLink :to="sortPath(key)" class="sort-link">
              {{ SORT_LABELS[key] }}<span class="sort-indicator" aria-hidden="true">{{ sortIndicator(key) }}</span>
            </NuxtLink>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in data.rows" :key="row.domain" :class="{ nuxt: row.isNuxt }">
          <td class="domain">
            <NuxtLink v-if="row.isNuxt" :to="detailPath(row.domain)">
              <DomainText :domain="row.domain" />
            </NuxtLink>
            <DomainText v-else :domain="row.domain" />
          </td>
          <td class="status">
            <span v-if="row.isNuxt" class="tag">
              <span aria-hidden="true">✔</span> Nuxt{{ row.version ? ` v${row.version}` : '' }}
            </span>
            <span v-else-if="row.error" class="muted error" :title="row.error">
              <span aria-hidden="true">⚠</span> error
            </span>
            <span v-else-if="row.scanned" class="muted">not Nuxt</span>
            <span v-else class="muted">pending</span>
          </td>
          <td class="num muted">{{ row.seenCount }}</td>
          <td class="num muted">{{ fmtAge(row.firstSeenAt) }}</td>
          <td class="num muted">{{ fmtAge(row.lastSeenAt) }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="data && data.rows.length === 0" role="status" class="muted">no rows match this filter</p>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; align-items: baseline; }
.filter-label { color: var(--muted); font-size: 0.85rem; }
.filter-link {
  display: inline-block;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.25rem 0.75rem;
  font-family: inherit;
  font-size: 0.85rem;
  border-radius: 3px;
  text-decoration: none;
}
.filter-link:hover { border-color: var(--accent); }
.filter-link.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
.rows { width: 100%; border-collapse: collapse; }
.rows th { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: normal; font-size: 0.85rem; }
.rows th .sort-link { color: inherit; text-decoration: none; display: inline-block; cursor: pointer; }
.rows th .sort-link:hover { color: var(--accent); }
.rows th.num, .rows td.num { text-align: right; white-space: nowrap; }
.rows td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
.rows .nuxt { background: rgba(0, 220, 130, 0.04); }
.rows .domain { color: var(--fg); }
.rows .domain a { color: var(--accent); text-decoration: none; }
.rows .domain a:hover { text-decoration: underline; }
.rows .status { white-space: nowrap; }
.error { color: #b85; }
.small { font-size: 0.85rem; }
.sort-indicator { display: inline-block; width: 0.6em; color: var(--accent); }
</style>

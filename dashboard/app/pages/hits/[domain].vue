<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { fmtNumber } from '~/composables/format'

definePageMeta({ name: 'hits-detail' })

const route = useRoute('hits-detail')
const domain = computed(() => route.params.domain)

const { data, error } = await useFetch(() => `/api/hits/${encodeURIComponent(domain.value)}`)

useHead({
  title: () => {
    if (error.value) return `Not found — nuxt.fyi`
    const v = data.value?.version ? ` (v${data.value.version})` : ''
    return `${domain.value}${v} — nuxt.fyi`
  },
})

const CHANNEL_ORDER: Record<string, number> = { discord: 0, bluesky: 1 }
const CHANNEL_LABELS: Record<string, string> = { discord: 'Discord', bluesky: 'Bluesky' }
function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel
}
const sortedNotifications = computed(() => {
  const list = data.value?.notifications ?? []
  return [...list].sort((a, b) => (CHANNEL_ORDER[a.channel] ?? 99) - (CHANNEL_ORDER[b.channel] ?? 99))
})

/** Reconstruct the list path from `?sort=&order=` attached by the list page's card link.
 * Other params (page, version) pass through; deep links with no ?sort fall back to /hits. */
const backTo = computed<RouteLocationRaw>(() => {
  const { sort, order, ...rest } = route.query
  if (typeof sort === 'string' && typeof order === 'string') {
    return { name: 'hits-list', params: { sort, order }, query: rest }
  }
  return { name: 'hits-list', params: {}, query: rest }
})
</script>

<template>
  <div>
    <NuxtLink :to="backTo" class="back"><span aria-hidden="true">&larr; </span>all sites</NuxtLink>

    <div v-if="error" role="alert" class="muted">not found</div>

    <div v-else-if="data">
      <h1>
        <DomainText :domain="data.domain" />
        <span class="tag">{{ data.version ? `v${data.version}` : 'version ?' }}</span>
        <span v-if="data.rank" class="rank" :title="`Tranco popularity rank`">#{{ data.rank.toLocaleString() }}</span>
      </h1>
      <p v-if="data.title" class="muted">{{ data.title }}</p>
      <p>
        <a :href="data.finalUrl || `https://${data.domain}`" target="_blank" rel="noopener">
          {{ data.finalUrl || `https://${data.domain}` }}<span class="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
      <p v-if="data.redirectedTo" class="redirect-note">
        redirects to
        <NuxtLink :to="{ name: 'hits-detail', params: { domain: data.redirectedTo } }">
          {{ data.redirectedTo }}
        </NuxtLink>
      </p>

      <div v-if="data.imageUrl" class="screenshot">
        <img
          :src="data.imageUrl"
          :alt="`Homepage screenshot of ${data.domain}`"
          width="1280"
          height="800"
          fetchpriority="high"
          decoding="async"
          referrerpolicy="no-referrer"
        >
      </div>

      <h2>Detection</h2>
      <p class="muted small">
        confidence {{ data.confidence }} &middot; scanned <NuxtTime :datetime="data.scannedAt" relative />
      </p>
      <ul class="signals">
        <li v-for="sig in data.signals" :key="sig.name">
          <span class="sig-name">{{ sig.name }}</span>
          <span class="sig-weight">+{{ sig.weight }}</span>
          <span v-if="sig.detail" class="sig-detail">{{ sig.detail }}</span>
        </li>
      </ul>

      <h2>Activity</h2>
      <p class="muted small">
        first seen on Bluesky <NuxtTime :datetime="data.firstSeenAt" relative /> &middot;
        last seen <NuxtTime :datetime="data.lastSeenAt" relative /> &middot;
        mentioned {{ fmtNumber(data.seenCount) }} time<span v-if="data.seenCount !== 1">s</span>
      </p>
      <ul v-if="data.notifications.length" class="notifications">
        <li v-for="n in sortedNotifications" :key="n.channel">
          posted to <strong :class="`channel-${n.channel}`">{{ channelLabel(n.channel) }}</strong>
          <NuxtTime :datetime="n.postedAt" relative />
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.redirect-note { color: var(--muted); font-size: 0.9rem; }
.redirect-note a { color: var(--accent); }
.back { display: inline-block; margin-bottom: 1rem; color: var(--muted); }
.back:hover { color: var(--accent); }
h1 { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.rank { color: #b9d; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.85rem; }
.screenshot { border: 1px solid var(--border); margin: 1rem 0; }
.screenshot img { width: 100%; height: auto; display: block; }
.signals { list-style: none; padding: 0; }
.signals li { padding: 0.4rem 0; border-bottom: 1px solid var(--border); display: flex; gap: 1rem; align-items: baseline; }
.signals li:last-child { border-bottom: none; }
.sig-name { flex-grow: 1; }
.sig-weight { color: var(--accent); }
.sig-detail { color: var(--muted); font-size: 0.85rem; }
.notifications { list-style: none; padding: 0; }
.notifications li { padding: 0.25rem 0; color: var(--muted); }
.notifications strong { color: var(--fg); }
/* Brand-coloured channel names use lighter tints than the official #5865f2 / #0a7aff so
   they clear 4.5:1 on the #0a0a0a background. The brand colours themselves only hit ~4:1
   and ~4.9:1 respectively, which fails or sits at the border of the WCAG AA floor. */
.notifications strong.channel-discord { color: #8e98f8; }
.notifications strong.channel-bluesky { color: #4ca3ff; }
.small { font-size: 0.85rem; }
</style>

<script setup lang="ts">
import { fmtNumber } from '~/composables/format'

definePageMeta({ name: 'index' })

useHead({ title: 'Overview — nuxt.fyi' })

const { data } = await useFetch('/api/stats')

const unverifiedCount = computed(() =>
  (data.value?.versions ?? [])
    .filter(v => v.bucket === 'off-registry' || v.bucket === 'unknown')
    .reduce((sum, v) => sum + v.count, 0),
)
</script>

<template>
  <div v-if="data">
    <h1>overview</h1>

    <div class="grid">
      <div class="card">
        <div class="big">{{ fmtNumber(data.stats.nuxtHits) }}</div>
        <div class="label">nuxt sites confirmed</div>
      </div>
      <div class="card">
        <div class="big">{{ fmtNumber(data.stats.scans) }}</div>
        <div class="label">domains scanned</div>
      </div>
      <div class="card">
        <div class="big">{{ fmtNumber(data.stats.domains) }}</div>
        <div class="label">domains observed</div>
      </div>
      <div class="card">
        <div class="big">{{ fmtNumber(data.stats.notifications) }}</div>
        <div class="label">notifications posted</div>
      </div>
    </div>

    <p class="muted small">
      last scan <NuxtTime :datetime="data.stats.lastScanAt" relative /> &middot;
      {{ fmtNumber(data.stats.pendingScan) }} seen but never scanned &middot;
      {{ fmtNumber(data.stats.errors) }} scans errored
    </p>

    <h2 id="versions-heading">versions detected</h2>
    <VersionChart :versions="data.versions" aria-labelledby="versions-heading" />
    <p v-if="unverifiedCount > 0" class="muted small versions-footnote">
      plus {{ fmtNumber(unverifiedCount) }} other sites with versions we couldn't verify
      against <a href="https://www.npmjs.com/package/nuxt" target="_blank" rel="noopener">npmjs.com<span class="sr-only"> (opens in a new tab)</span></a>,
      or sites where we couldn't detect a version at all.
    </p>

    <h2 id="signals-heading">signals that fired on nuxt hits</h2>
    <table class="bars" aria-labelledby="signals-heading">
      <thead class="sr-only">
        <tr>
          <th scope="col">signal</th>
          <th scope="col">relative frequency</th>
          <th scope="col">count</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in data.signals" :key="row.name">
          <td class="ver">{{ row.name }}</td>
          <td class="bar" aria-hidden="true"><div :style="{ width: barWidth(row.count, data.signals[0]?.count ?? 1) }" /></td>
          <td class="count">{{ fmtNumber(row.count) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script lang="ts">
function barWidth(value: number, max: number): string {
  if (!max) return '0%'
  return `${Math.max(2, Math.round((value / max) * 100))}%`
}
</script>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.card { padding: 1rem; border: 1px solid var(--border); border-radius: 4px; }
.big { font-size: 1.8rem; color: var(--accent); }
.label { color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem; }
.small { font-size: 0.85rem; }
.bars { width: 100%; border-collapse: collapse; table-layout: fixed; }
.bars td { padding: 0.25rem 0.5rem; }
.bars .ver { word-break: break-word; }
@media (min-width: 640px) {
  .bars .ver { white-space: nowrap; word-break: normal; }
}
.bars .bar { width: 100%; }
.bars .bar > div { background: var(--accent); height: 12px; border-radius: 2px; min-width: 2px; }
.bars .count { text-align: right; color: var(--muted); white-space: nowrap; }

.versions-footnote { margin: 0.5rem 0 0; }
</style>

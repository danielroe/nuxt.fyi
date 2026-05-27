<script setup lang="ts">
// Async-loaded so vue-data-ui's module-scope side effects (CSS injection, globals) don't
// run during SSR and trigger a hydration mismatch on the client re-render.
const VueUiXy = defineAsyncComponent(async () => {
  const mod = await import('vue-data-ui')
  await import('vue-data-ui/style.css')
  return mod.VueUiXy
})

interface VersionRow {
  version: string
  count: number
  bucket?: 'published' | 'off-registry' | 'unknown'
}

const props = defineProps<{
  versions: VersionRow[]
}>()

// Only npm-published versions are plotted; off-registry strings and unknown rows live in
// the sidebar so every chart bar is something you can `npm install`.
const chartedVersions = computed(() => props.versions.filter(v => v.bucket === 'published'))

// One bar per major.minor; sorted strictly ascending so the x-axis reads oldest -> newest.
interface MinorBucket {
  label: string
  major: number
  minor: number
  count: number
  isUnknown: boolean
}

function bucketByMinor(versions: VersionRow[]): MinorBucket[] {
  const map = new Map<string, MinorBucket>()
  for (const row of versions) {
    if (row.version === 'unknown') {
      const existing = map.get('unknown')
      map.set('unknown', {
        label: 'unknown',
        major: Number.POSITIVE_INFINITY,
        minor: Number.POSITIVE_INFINITY,
        count: (existing?.count ?? 0) + row.count,
        isUnknown: true,
      })
      continue
    }
    const parts = row.version.split('.')
    const major = Number(parts[0])
    const minor = Number(parts[1] ?? 0)
    if (!Number.isFinite(major)) continue
    const key = `${major}.${minor}`
    const existing = map.get(key)
    map.set(key, {
      label: key,
      major,
      minor,
      count: (existing?.count ?? 0) + row.count,
      isUnknown: false,
    })
  }
  return [...map.values()].sort((a, b) => {
    if (a.isUnknown && !b.isUnknown) return 1
    if (!a.isUnknown && b.isUnknown) return -1
    if (a.major !== b.major) return a.major - b.major
    return a.minor - b.minor
  })
}

const buckets = computed(() => bucketByMinor(chartedVersions.value))

const dataset = computed(() => [{
  type: 'bar' as const,
  name: 'sites',
  series: buckets.value.map(b => b.count),
  color: '#00dc82',
}])

const config = computed(() => ({
  responsive: true,
  chart: {
    // chart.userOptions (PDF/CSV/PNG export menu) is per-component; for VueUiXy it nests
    // here, not at the top level of the config.
    userOptions: { show: false },
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    backgroundColor: 'transparent',
    color: '#e5e5e5',
    legend: { show: false },
    title: { show: false },
    tooltip: {
      backgroundColor: '#0a0a0a',
      color: '#e5e5e5',
      borderColor: '#222',
      // Single-series chart: each bar's percentage is always 100% of itself.
      showPercentage: false,
    },
    grid: {
      stroke: '#222',
      labels: {
        color: '#888',
        xAxisLabels: {
          color: '#888',
          show: true,
          values: buckets.value.map(b => b.label),
          rotation: 0,
        },
        yAxis: {
          showBaseline: true,
          useNiceScale: true,
          scaleMin: 0,
        },
      },
    },
    highlighter: { color: '#e5e5e5', opacity: 5 },
    zoom: { show: false },
  },
}))
</script>

<template>
  <div class="version-chart">
    <!-- The third-party VueUiXy chart renders interactive SVG with no usable accessible
         name or text alternative. We hide it from assistive tech and expose the same
         numbers via a visually-hidden data table that mirrors the bar buckets. -->
    <div aria-hidden="true" class="chart-visual">
      <ClientOnly>
        <VueUiXy :dataset="(dataset as never)" :config="(config as never)" />
        <template #fallback>
          <ChartSkeleton :bar-count="buckets.length || 20" />
        </template>
      </ClientOnly>
    </div>
    <table class="sr-only">
      <caption>Nuxt sites grouped by detected major.minor version</caption>
      <thead>
        <tr>
          <th scope="col">version</th>
          <th scope="col">sites</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in buckets" :key="b.label">
          <td>{{ b.isUnknown ? 'unknown' : `v${b.label}` }}</td>
          <td>{{ b.count.toLocaleString() }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
/* Fixed container height keeps the SSR reservation and the post-hydration chart aligned;
   without it the library mounts at its default size and reflows everything below. */
.version-chart { margin: 1rem 0; height: 360px; position: relative; }
.chart-visual { height: 100%; }
.version-chart :deep(.vue-ui-xy),
.version-chart :deep(.vue-data-ui-component) { height: 100% !important; }
.version-chart :deep(.vue-ui-xy),
.version-chart :deep(svg) { background: transparent !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>

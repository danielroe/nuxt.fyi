<script setup lang="ts">
interface VersionRow {
  version: string
  count: number
  bucket?: 'published' | 'off-registry' | 'unknown'
}

const props = defineProps<{
  versions: VersionRow[]
}>()

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

const buckets = computed(() =>
  bucketByMinor(props.versions.filter(v => v.bucket === 'published')),
)

const WIDTH = 720
const HEIGHT = 360
const PADDING = { top: 18, right: 12, bottom: 32, left: 44 }
const BAR_GAP = 4

/**
 * Round `max` up to a friendly axis ceiling (1, 2, 2.5, 5 * 10^n) so tick labels read
 * as round numbers rather than the raw data max.
 */
function niceCeil(max: number): number {
  if (max <= 0) return 1
  const exp = Math.floor(Math.log10(max))
  const pow = 10 ** exp
  const norm = max / pow
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
  return nice * pow
}

function fmtTick(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

const layout = computed(() => {
  const items = buckets.value
  const plotW = WIDTH - PADDING.left - PADDING.right
  const plotH = HEIGHT - PADDING.top - PADDING.bottom
  const n = items.length
  const barW = n > 0 ? (plotW - BAR_GAP * Math.max(0, n - 1)) / n : 0
  const dataMax = items.reduce((m, b) => Math.max(m, b.count), 0)
  const yMax = niceCeil(dataMax)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    value: yMax * t,
    y: PADDING.top + plotH * (1 - t),
  }))
  const bars = items.map((b, i) => {
    const h = yMax > 0 ? (b.count / yMax) * plotH : 0
    return {
      ...b,
      x: PADDING.left + i * (barW + BAR_GAP),
      y: PADDING.top + plotH - h,
      w: barW,
      h,
      cx: PADDING.left + i * (barW + BAR_GAP) + barW / 2,
      labelY: HEIGHT - PADDING.bottom + 14,
    }
  })
  return {
    bars,
    ticks,
    baselineY: PADDING.top + plotH,
    plotLeft: PADDING.left,
    plotRight: WIDTH - PADDING.right,
  }
})
</script>

<template>
  <div class="version-chart">
    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Nuxt versions detected, grouped by major.minor. See data table below."
    >
      <g class="grid">
        <line
          v-for="(t, i) in layout.ticks"
          :key="`grid-${i}`"
          :x1="layout.plotLeft"
          :y1="t.y"
          :x2="layout.plotRight"
          :y2="t.y"
        />
      </g>
      <g class="y-axis">
        <text
          v-for="(t, i) in layout.ticks"
          :key="`y-${i}`"
          :x="layout.plotLeft - 8"
          :y="t.y"
          text-anchor="end"
          dominant-baseline="middle"
        >{{ fmtTick(t.value) }}</text>
      </g>
      <g class="bars">
        <g v-for="b in layout.bars" :key="b.label" class="bar">
          <rect
            :x="b.x"
            :y="b.y"
            :width="b.w"
            :height="b.h"
            rx="1"
          >
            <title>{{ b.label }}: {{ b.count.toLocaleString() }}</title>
          </rect>
        </g>
      </g>
      <line
        class="baseline"
        :x1="layout.plotLeft"
        :y1="layout.baselineY"
        :x2="layout.plotRight"
        :y2="layout.baselineY"
      />
      <g class="x-axis">
        <text
          v-for="b in layout.bars"
          :key="`x-${b.label}`"
          :x="b.cx"
          :y="b.labelY"
          text-anchor="middle"
          dominant-baseline="hanging"
        >{{ b.label }}</text>
      </g>
    </svg>
    <div class="sr-only">
      <table>
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
  </div>
</template>

<style scoped>
.version-chart {
  margin: 1rem 0;
  width: 100%;
  min-width: 0;
}
.version-chart svg {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
}
.version-chart .grid line {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 2 4;
}
.version-chart .baseline {
  stroke: var(--border);
  stroke-width: 1;
}
.version-chart .y-axis text,
.version-chart .x-axis text {
  fill: var(--muted);
}
.version-chart .bars rect {
  fill: var(--accent);
  transition: opacity 120ms ease;
}
.version-chart .bars .bar:hover rect {
  opacity: 0.75;
}
</style>

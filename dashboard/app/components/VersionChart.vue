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
const PADDING = { top: 18, right: 12, bottom: 56, left: 44 }
const BAR_GAP = 4
const MAJOR_GAP = 18

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

interface MajorGroup {
  major: number | 'unknown'
  label: string
  start: number
  end: number
  cx: number
  count: number
}

const layout = computed(() => {
  const items = buckets.value
  const plotW = WIDTH - PADDING.left - PADDING.right
  const plotH = HEIGHT - PADDING.top - PADDING.bottom
  const n = items.length
  const dataMax = items.reduce((m, b) => Math.max(m, b.count), 0)
  const yMax = niceCeil(dataMax)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    value: yMax * t,
    y: PADDING.top + plotH * (1 - t),
  }))

  const majorKeys: Array<number | 'unknown'> = []
  const majorCounts = new Map<number | 'unknown', number>()
  for (const b of items) {
    const key: number | 'unknown' = b.isUnknown ? 'unknown' : b.major
    if (!majorCounts.has(key)) majorKeys.push(key)
    majorCounts.set(key, (majorCounts.get(key) ?? 0) + 1)
  }
  const groupCount = majorKeys.length
  const totalGaps = MAJOR_GAP * Math.max(0, groupCount - 1)
  const totalBarGaps = items.reduce((sum, _, i) => {
    if (i === 0) return sum
    const prev = items[i - 1]!
    const cur = items[i]!
    const sameGroup = prev.isUnknown === cur.isUnknown && prev.major === cur.major
    return sum + (sameGroup ? BAR_GAP : 0)
  }, 0)
  const barW = n > 0 ? (plotW - totalGaps - totalBarGaps) / n : 0

  const bars = [] as Array<MinorBucket & {
    x: number
    y: number
    w: number
    h: number
    cx: number
    labelY: number
    minorLabel: string
  }>
  let cursor = PADDING.left
  const groups: MajorGroup[] = []
  let groupStart = cursor
  let groupKey: number | 'unknown' | null = null
  for (let i = 0; i < items.length; i++) {
    const b = items[i]!
    const key: number | 'unknown' = b.isUnknown ? 'unknown' : b.major
    if (groupKey === null) {
      groupKey = key
      groupStart = cursor
    } else if (key !== groupKey) {
      groups.push({
        major: groupKey,
        label: groupKey === 'unknown' ? 'unknown' : `${groupKey}.x`,
        start: groupStart,
        end: cursor - BAR_GAP,
        cx: (groupStart + (cursor - BAR_GAP)) / 2,
        count: majorCounts.get(groupKey) ?? 0,
      })
      cursor += MAJOR_GAP - BAR_GAP
      groupKey = key
      groupStart = cursor
    }
    const h = yMax > 0 ? (b.count / yMax) * plotH : 0
    bars.push({
      ...b,
      x: cursor,
      y: PADDING.top + plotH - h,
      w: barW,
      h,
      cx: cursor + barW / 2,
      labelY: HEIGHT - PADDING.bottom + 14,
      minorLabel: b.isUnknown ? '?' : String(b.minor),
    })
    cursor += barW + BAR_GAP
  }
  if (groupKey !== null) {
    groups.push({
      major: groupKey,
      label: groupKey === 'unknown' ? 'unknown' : `${groupKey}.x`,
      start: groupStart,
      end: cursor - BAR_GAP,
      cx: (groupStart + (cursor - BAR_GAP)) / 2,
      count: majorCounts.get(groupKey) ?? 0,
    })
  }

  return {
    bars,
    groups,
    ticks,
    baselineY: PADDING.top + plotH,
    majorLabelY: HEIGHT - PADDING.bottom + 42,
    groupRuleY: HEIGHT - PADDING.bottom + 32,
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
      <g class="x-axis minor">
        <text
          v-for="b in layout.bars"
          :key="`x-${b.label}`"
          :x="b.cx"
          :y="b.labelY"
          text-anchor="middle"
          dominant-baseline="hanging"
        >{{ b.minorLabel }}</text>
      </g>
      <g class="x-axis major">
        <line
          v-for="g in layout.groups"
          :key="`rule-${g.label}`"
          :x1="g.start"
          :x2="g.end"
          :y1="layout.groupRuleY"
          :y2="layout.groupRuleY"
        />
        <text
          v-for="g in layout.groups"
          :key="`major-${g.label}`"
          :x="g.cx"
          :y="layout.majorLabelY"
          text-anchor="middle"
          dominant-baseline="hanging"
        >{{ g.label }}</text>
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
.version-chart .x-axis.major text {
  font-size: 12px;
  font-weight: 600;
  fill: var(--fg, var(--muted));
}
.version-chart .x-axis.major line {
  stroke: var(--border);
  stroke-width: 1;
}
.version-chart .bars rect {
  fill: var(--accent);
  transition: opacity 120ms ease;
}
.version-chart .bars .bar:hover rect {
  opacity: 0.75;
}
</style>

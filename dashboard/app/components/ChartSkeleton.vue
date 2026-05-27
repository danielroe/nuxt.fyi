<script setup lang="ts">
/**
 * SVG placeholder rendered while the real chart is async-loading. Mirrors the chart's
 * dimensions so SSR and pre-hydration paints don't shift content below.
 */
const props = withDefaults(defineProps<{
  barCount?: number
  width?: number
  height?: number
}>(), {
  barCount: 20,
  width: 720,
  height: 360,
})

// Deterministic heights so the skeleton doesn't flicker between renders.
const HEIGHTS = [4, 6, 5, 8, 4, 6, 9, 12, 7, 10, 14, 6, 8, 11, 18, 22, 15, 28, 40, 95]

const bars = computed(() => {
  const padding = { top: 18, right: 12, bottom: 28, left: 36 }
  const plotW = props.width - padding.left - padding.right
  const plotH = props.height - padding.top - padding.bottom
  const gap = 4
  const n = Math.min(props.barCount, HEIGHTS.length)
  const barW = (plotW - gap * (n - 1)) / n
  const maxH = Math.max(...HEIGHTS.slice(0, n))
  return Array.from({ length: n }, (_, i) => {
    const h = (HEIGHTS[i] ?? 10) / maxH * plotH
    return {
      x: padding.left + i * (barW + gap),
      y: padding.top + plotH - h,
      w: barW,
      h,
    }
  })
})

const baselineY = computed(() => props.height - 28)
const yTicks = computed(() => {
  const padding = { top: 18, bottom: 28 }
  const plotH = props.height - padding.top - padding.bottom
  return [0, 0.25, 0.5, 0.75, 1].map(t => padding.top + plotH * (1 - t))
})
</script>

<template>
  <svg
    class="chart-skeleton"
    :viewBox="`0 0 ${width} ${height}`"
    :width="width"
    :height="height"
    preserveAspectRatio="xMidYMid meet"
    aria-hidden="true"
  >
    <g class="grid">
      <line v-for="(y, i) in yTicks" :key="`t${i}`" :x1="36" :y1="y" :x2="width - 12" :y2="y" />
    </g>
    <g class="bars">
      <rect
        v-for="(b, i) in bars"
        :key="i"
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        rx="1"
      />
    </g>
    <line class="baseline" :x1="36" :y1="baselineY" :x2="width - 12" :y2="baselineY" />
  </svg>
</template>

<style scoped>
.chart-skeleton {
  width: 100%;
  height: 100%;
  display: block;
}
.chart-skeleton .grid line {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 2 4;
}
.chart-skeleton .baseline {
  stroke: var(--border);
  stroke-width: 1;
}
.chart-skeleton .bars rect {
  fill: var(--accent);
  opacity: 0.25;
  animation: pulse 1.4s ease-in-out infinite;
}
.chart-skeleton .bars rect:nth-child(odd) {
  animation-delay: 0.15s;
}
.chart-skeleton .bars rect:nth-child(3n) {
  animation-delay: 0.3s;
}
@keyframes pulse {
  0%, 100% { opacity: 0.18; }
  50% { opacity: 0.42; }
}
@media (prefers-reduced-motion: reduce) {
  .chart-skeleton .bars rect { animation: none; opacity: 0.3; }
}
</style>

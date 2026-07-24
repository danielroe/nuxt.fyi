<script setup lang="ts">
defineProps<{
  width?: string
  height?: string
  radius?: string
}>()
</script>

<template>
  <span
    class="skeleton"
    :style="{ width, height, borderRadius: radius }"
    aria-hidden="true"
  />
</template>

<style scoped>
.skeleton {
  display: block;
  width: 100%;
  height: 1em;
  background: linear-gradient(90deg, #1a1a1a 25%, #262626 50%, #1a1a1a 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.2s ease-in-out infinite;
  border-radius: 3px;
}
@keyframes skeleton-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; }
}
</style>

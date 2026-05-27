<script setup lang="ts">
defineProps<{ domain: string }>()
</script>

<template>
  <span class="domain-text">
    <template v-if="domain.startsWith('www.')">
      <span class="prefix">www.</span><span class="rest">{{ domain.slice(4) }}</span>
    </template>
    <template v-else>{{ domain }}</template>
  </span>
</template>

<style scoped>
.domain-text .prefix { color: var(--muted); }
.domain-text .rest { color: inherit; }
</style>

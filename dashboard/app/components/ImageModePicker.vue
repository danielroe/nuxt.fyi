<script setup lang="ts">
/**
 * Three-state segmented control that flips the user's preference between showing the
 * site's own og:image, our captured screenshot, or letting the page pick (auto). The
 * preference is a CSS class on `<html>` (`image-mode-{auto,screenshot,og}`); each card
 * server-renders every image source it has and CSS hides the unwanted ones. See
 * `useImageMode` for the prehydration hookup and `<HitImage>` for the markup it targets.
 */
type ImageMode = 'auto' | 'screenshot' | 'og'

const STORAGE_KEY = 'nuxt-fyi:image-mode'
const MODES: ImageMode[] = ['auto', 'screenshot', 'og']
const LABELS: Record<ImageMode, string> = {
  auto: 'auto',
  screenshot: 'screenshot',
  og: 'og:image',
}

const mode = ref<ImageMode>('auto')

onMounted(() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'screenshot' || stored === 'og' || stored === 'auto') {
      mode.value = stored
    }
  }
  catch { /* localStorage unavailable: keep the default */ }
})

function setMode(next: ImageMode): void {
  mode.value = next
  try {
    if (next === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  }
  catch { /* noop */ }
  const root = document.documentElement
  for (const m of MODES) root.classList.remove(`image-mode-${m}`)
  if (next !== 'auto') root.classList.add(`image-mode-${next}`)
}
</script>

<template>
  <fieldset class="image-mode-picker">
    <legend class="sr-only">Image source preference</legend>
    <button
      v-for="m in MODES"
      :key="m"
      type="button"
      :aria-pressed="mode === m"
      :class="{ active: mode === m }"
      @click="setMode(m)"
    >
      {{ LABELS[m] }}
    </button>
  </fieldset>
</template>

<style scoped>
.image-mode-picker {
  display: inline-flex;
  gap: 0;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
}
.image-mode-picker button {
  background: transparent;
  color: var(--muted);
  border: none;
  border-right: 1px solid var(--border);
  padding: 0.2rem 0.55rem;
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
}
.image-mode-picker button:last-child { border-right: none; }
.image-mode-picker button:hover { color: var(--fg); }
.image-mode-picker button.active {
  background: var(--accent-dim);
  color: var(--accent);
}
</style>

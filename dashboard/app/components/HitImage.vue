<script setup lang="ts">
/**
 * Renders the screenshot for a hit. Prefers the ImageKit-hosted copy (via `<NuxtImg>`)
 * when its key is present, otherwise falls back to the legacy `/api/screenshots/<domain>`
 * endpoint that streams the daemon's local file, otherwise the upstream og:image URL.
 * The picker order is: imagekit screenshot -> imagekit og:image -> local screenshot
 * stream -> upstream og:image. A future toggle (step 5) will let callers override that
 * preference; for now we pick the highest-fidelity available source.
 */
interface ImageSources {
  screenshotKey: string | null
  ogImageKey: string | null
  screenshotUrl: string | null
  ogImageUrl: string | null
}

const props = defineProps<{
  image: ImageSources
  alt: string
  width?: number
  height?: number
  loading?: 'eager' | 'lazy'
  fetchpriority?: 'high' | 'auto' | 'low'
}>()

const W = computed(() => props.width ?? 1280)
const H = computed(() => props.height ?? 800)

const picked = computed<
  | { kind: 'imagekit', src: string }
  | { kind: 'legacy', src: string }
  | null
>(() => {
  if (props.image.screenshotKey) return { kind: 'imagekit', src: props.image.screenshotKey }
  if (props.image.ogImageKey) return { kind: 'imagekit', src: props.image.ogImageKey }
  if (props.image.screenshotUrl) return { kind: 'legacy', src: props.image.screenshotUrl }
  if (props.image.ogImageUrl) return { kind: 'legacy', src: props.image.ogImageUrl }
  return null
})
</script>

<template>
  <NuxtImg
    v-if="picked && picked.kind === 'imagekit'"
    provider="imagekit"
    :src="picked.src"
    :alt="alt"
    :width="W"
    :height="H"
    :loading="loading ?? 'lazy'"
    :fetchpriority="fetchpriority ?? 'auto'"
    decoding="async"
    referrerpolicy="no-referrer"
  />
  <img
    v-else-if="picked && picked.kind === 'legacy'"
    :src="picked.src"
    :alt="alt"
    :width="W"
    :height="H"
    :loading="loading ?? 'lazy'"
    :fetchpriority="fetchpriority ?? 'auto'"
    decoding="async"
    referrerpolicy="no-referrer"
  >
  <div v-else class="no-shot" aria-hidden="true">no image</div>
</template>

<style scoped>
.no-shot {
  width: 100%;
  aspect-ratio: 16 / 10;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: var(--accent-dim, transparent);
  font-size: 0.85rem;
}
</style>

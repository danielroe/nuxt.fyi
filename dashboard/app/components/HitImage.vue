<script setup lang="ts">
/**
 * Renders every available image source for a hit and lets CSS pick which one to show.
 * The picker is a global `image-mode-*` class on `<html>` driven by `<ImageModePicker>`;
 * see the CSS block in `app.vue` for the rules. Each source carries a stable class
 * (`hit-image-screenshot` / `hit-image-og`) and the wrapper exposes
 * `data-has-screenshot` / `data-has-og` so CSS can fall back when the preferred source
 * is absent.
 *
 * Source priority within a family: ImageKit (via `<NuxtImg provider="imagekit">`) when
 * the key is present, else the legacy URL (local `/api/screenshots/...` or upstream
 * og:image URL). At most one element is emitted per family.
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

const hasScreenshot = computed(() => !!(props.image.screenshotKey || props.image.screenshotUrl))
const hasOg = computed(() => !!(props.image.ogImageKey || props.image.ogImageUrl))
const hasAny = computed(() => hasScreenshot.value || hasOg.value)
</script>

<template>
  <div
    class="hit-image"
    :data-has-screenshot="hasScreenshot ? 'true' : 'false'"
    :data-has-og="hasOg ? 'true' : 'false'"
  >
    <NuxtImg
      v-if="image.screenshotKey"
      provider="imagekit"
      :src="image.screenshotKey"
      :alt="alt"
      class="hit-image-source hit-image-screenshot"
      :width="W"
      :height="H"
      :loading="loading ?? 'lazy'"
      :fetchpriority="fetchpriority ?? 'auto'"
      decoding="async"
      referrerpolicy="no-referrer"
    />
    <img
      v-else-if="image.screenshotUrl"
      :src="image.screenshotUrl"
      :alt="alt"
      class="hit-image-source hit-image-screenshot"
      :width="W"
      :height="H"
      :loading="loading ?? 'lazy'"
      :fetchpriority="fetchpriority ?? 'auto'"
      decoding="async"
      referrerpolicy="no-referrer"
    >

    <NuxtImg
      v-if="image.ogImageKey"
      provider="imagekit"
      :src="image.ogImageKey"
      :alt="alt"
      class="hit-image-source hit-image-og"
      :width="W"
      :height="H"
      :loading="loading ?? 'lazy'"
      :fetchpriority="fetchpriority ?? 'auto'"
      decoding="async"
      referrerpolicy="no-referrer"
    />
    <img
      v-else-if="image.ogImageUrl"
      :src="image.ogImageUrl"
      :alt="alt"
      class="hit-image-source hit-image-og"
      :width="W"
      :height="H"
      :loading="loading ?? 'lazy'"
      :fetchpriority="fetchpriority ?? 'auto'"
      decoding="async"
      referrerpolicy="no-referrer"
    >

    <div v-if="!hasAny" class="no-shot" aria-hidden="true">no image</div>
  </div>
</template>

<style scoped>
.hit-image { position: relative; }
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

<style>
.hit-image-source { display: block; width: 100%; height: auto; }
.hit-image-og { display: none; }
.hit-image[data-has-screenshot="false"] .hit-image-og { display: block; }

html.image-mode-og .hit-image-screenshot { display: none; }
html.image-mode-og .hit-image-og { display: block; }
html.image-mode-og .hit-image[data-has-og="false"] .hit-image-screenshot { display: block; }
html.image-mode-og .hit-image[data-has-og="false"] .hit-image-og { display: none; }

html.image-mode-screenshot .hit-image-screenshot { display: block; }
html.image-mode-screenshot .hit-image-og { display: none; }
html.image-mode-screenshot .hit-image[data-has-screenshot="false"] .hit-image-og { display: block; }
</style>

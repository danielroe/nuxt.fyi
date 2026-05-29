<script setup lang="ts">
/**
 * Renders every available image source for a hit and lets CSS pick which one to show.
 * The picker is a global `image-mode-*` class on `<html>` driven by `<ImageModePicker>`;
 * see the unscoped CSS block at the bottom of this file for the rules. Each source
 * carries a stable class (`hit-image-screenshot` / `hit-image-og`) and the wrapper
 * exposes `data-has-screenshot` / `data-has-og` so CSS can fall back when the preferred
 * source is absent.
 *
 * Screenshots always come from ImageKit (via `<NuxtImg provider="imagekit">`). The
 * og:image side prefers ImageKit too, but keeps a plain `<img src>` fallback to the
 * upstream URL for the rare row where the daemon recorded an og:image origin but the
 * ImageKit upload didn't land.
 *
 * NSFW handling: when `nsfwLabel === 'nsfw'` the wrapper carries `data-nsfw="nsfw"`
 * which CSS uses to blur the image and overlay a "show NSFW" button. Click toggles
 * `data-nsfw-revealed="true"` on the wrapper for that card only; the preference is not
 * persisted so navigating away re-hides. `suggestive` rows render normally per the
 * earlier design call.
 */
interface ImageSources {
  screenshotKey: string | null
  ogImageKey: string | null
  ogImageUrl: string | null
  nsfwLabel: 'safe' | 'suggestive' | 'nsfw' | null
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

const hasScreenshot = computed(() => !!props.image.screenshotKey)
const hasOg = computed(() => !!(props.image.ogImageKey || props.image.ogImageUrl))
const hasAny = computed(() => hasScreenshot.value || hasOg.value)
const isNsfw = computed(() => props.image.nsfwLabel === 'nsfw')

const revealed = ref(false)
function reveal(): void { revealed.value = true }
</script>

<template>
  <div
    class="hit-image"
    :data-has-screenshot="hasScreenshot ? 'true' : 'false'"
    :data-has-og="hasOg ? 'true' : 'false'"
    :data-nsfw="image.nsfwLabel ?? 'unknown'"
    :data-nsfw-revealed="revealed ? 'true' : 'false'"
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

    <button
      v-if="isNsfw"
      type="button"
      class="nsfw-reveal"
      :aria-pressed="revealed"
      @click="reveal"
    >
      <span class="nsfw-label">NSFW</span>
      <span class="nsfw-hint">{{ revealed ? 'shown' : 'click to show' }}</span>
    </button>

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
.nsfw-reveal {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  background: rgba(10, 10, 10, 0.55);
  border: none;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
  z-index: 1;
}
.nsfw-reveal:hover { background: rgba(10, 10, 10, 0.7); }
.nsfw-label {
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
}
.nsfw-hint { font-size: 0.8rem; color: var(--muted); }
/* Once revealed, the button collapses to a small corner tag so the image is unobstructed. */
.hit-image[data-nsfw-revealed="true"] .nsfw-reveal {
  inset: auto 0.5rem 0.5rem auto;
  background: rgba(10, 10, 10, 0.7);
  padding: 0.2rem 0.5rem;
  border-radius: 3px;
  flex-direction: row;
  cursor: default;
}
.hit-image[data-nsfw-revealed="true"] .nsfw-hint { display: none; }
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

/* NSFW blur. The transform: scale prevents the blur softening the image edges,
   which would leak hints around the frame. Cleared once the user reveals. */
.hit-image[data-nsfw="nsfw"][data-nsfw-revealed="false"] .hit-image-source {
  filter: blur(40px);
  transform: scale(1.08);
}
</style>

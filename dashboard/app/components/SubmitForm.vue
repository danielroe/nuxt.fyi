<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { $apiFetch, type SubmitResult } from '#shared/api'

const url = ref('')
const submitting = ref(false)
const result = ref<SubmitResult | null>(null)
const errorMessage = ref<string | null>(null)

async function onSubmit(): Promise<void> {
  const trimmed = url.value.trim()
  if (!trimmed) {
    errorMessage.value = 'enter a url first'
    return
  }
  submitting.value = true
  result.value = null
  errorMessage.value = null
  try {
    result.value = await $apiFetch('/api/submit', {
      method: 'POST',
      body: { url: trimmed },
    })
    url.value = ''
  }
  catch (err) {
    const e = err as { data?: { message?: string }, statusMessage?: string, message?: string }
    errorMessage.value = e.data?.message || e.statusMessage || e.message || 'submission failed'
  }
  finally {
    submitting.value = false
  }
}

function detailLink(domain: string): RouteLocationRaw {
  return { name: 'hits-detail', params: { domain } }
}

const STATUS_COPY: Record<NonNullable<SubmitResult['status']>, string> = {
  'queued': 'queued for scanning. Check back in a minute or two.',
  'already-pending': 'already in the scan queue. Hang tight.',
  'recently-scanned': 'already scanned recently.',
}
</script>

<template>
  <section aria-labelledby="submit-heading" class="submit">
    <h2 id="submit-heading">submit a site</h2>

    <p v-if="errorMessage" class="status status-error" role="alert">
      {{ errorMessage }}
    </p>

    <div v-if="result && result.domain && result.status" class="status status-ok" role="status">
      <strong>{{ result.domain }}</strong>
      {{ STATUS_COPY[result.status] }}
      <NuxtLink v-if="result.status === 'recently-scanned'" :to="detailLink(result.domain)">
        see what we know
      </NuxtLink>
    </div>

    <form class="submit-form" @submit.prevent="onSubmit">
      <label for="submit-url" class="sr-only">URL to scan</label>
      <input
        id="submit-url"
        v-model="url"
        type="url"
        inputmode="url"
        placeholder="https://example.com"
        autocomplete="off"
        spellcheck="false"
        :disabled="submitting"
        required
      >
      <button type="submit" :disabled="submitting">
        {{ submitting ? 'submitting…' : 'submit' }}
      </button>
    </form>

    <p class="muted hint">
      Spotted a Nuxt site we haven't picked up from the firehose? Drop the URL in.
      Domains scanned in the last 30 days won't be re-scanned.
    </p>
  </section>
</template>

<style scoped>
.submit { margin-top: 2rem; }
.submit h2 { margin-top: 0; }

.submit-form { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.75rem 0 0.5rem; }
.submit-form input {
  flex: 1 1 320px;
  min-width: 0;
  padding: 0.6rem 0.75rem;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 3px;
  font: inherit;
}
.submit-form input:focus-visible {
  border-color: var(--accent);
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.submit-form button {
  padding: 0.6rem 1.1rem;
  background: var(--accent);
  color: #062b1c;
  border: 1px solid var(--accent);
  border-radius: 3px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.submit-form button:disabled { opacity: 0.6; cursor: progress; }
.submit-form button:hover:not(:disabled) { filter: brightness(1.1); }

.status { margin: 0.5rem 0; padding: 0.6rem 0.85rem; border: 1px solid var(--border); border-radius: 3px; font-size: 0.9rem; }
.status-ok { border-color: var(--accent); background: var(--accent-dim); }
.status-error { border-color: #c64; color: #ffb29a; background: rgba(255, 90, 60, 0.08); }
.status a { margin-left: 0.4rem; }

.hint { font-size: 0.85rem; margin: 0; }
</style>

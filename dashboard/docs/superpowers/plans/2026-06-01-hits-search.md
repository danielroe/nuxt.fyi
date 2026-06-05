# Hits Page Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side text search input to `/hits` that filters by `domain` and `title`, with the search term in the URL (`?q=…`), an empty-state message with a clear-search action, and a debounced live update.

**Architecture:** Three files change. The page owns the input + URL wiring; the server endpoint owns the LIKE predicate and cache key extension; the shared types file owns the request contract. The URL is the source of truth — the local input ref is initialized from `route.query.q` and the fetch re-runs whenever the URL changes.

**Tech Stack:** Nuxt 5 (nuxt-nightly), Vue 3.5 `<script setup>`, Nitro 3 `defineCachedHandler`, `node:sqlite` (better-sqlite3-style), `fetchdts` for typed `useFetch`, `pnpm` workspaces. No test framework — verification is `pnpm test:types` plus a manual 12-step plan against `pnpm dev:fixtures`.

**Spec:** `docs/superpowers/specs/2026-06-01-hits-search-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `shared/api.ts` | Modify | Declare `q?: string` query param on the `/api/hits` GET request side of `APISchema` |
| `server/api/hits.get.ts` | Modify | Read `q`, build escaped LIKE predicate, append to existing `where`, extend cache `getKey` |
| `app/pages/hits/[[sort]]/[[order]].vue` | Modify | Add `search`/`searchTerm`/`inputEl` refs, debounce helpers, `clearSearch`, search input markup, empty-state paragraph, scoped styles |
| `docs/superpowers/plans/2026-06-01-hits-search.md` | Create (this file) | The plan |

No new files in `app/` or `server/`. The page stays a single file; the styles stay scoped to the page.

---

## Task 1: Declare `q` on the API request schema

**Files:**
- Modify: `shared/api.ts:124-127`

- [ ] **Step 1: Edit the `/api/hits` GET entry in `APISchema`**

Replace the current entry:

```ts
'/api/hits': {
  [Endpoint]: { GET: { response: HitsResponse } }
  [DynamicParam]: { [Endpoint]: { GET: { response: HitDetailResponse } } }
}
```

with:

```ts
'/api/hits': {
  [Endpoint]: { GET: { response: HitsResponse, query: { q?: string } } }
  [DynamicParam]: { [Endpoint]: { GET: { response: HitDetailResponse } } }
}
```

This declares the optional `q` query string parameter on the unparameterized `/api/hits` GET. The `[DynamicParam]` entry (the `/api/hits/:domain` detail endpoint) is unchanged.

- [ ] **Step 2: Run `pnpm test:types`**

Run: `pnpm test:types`
Expected: PASS. The change is purely additive — no existing call site passes `q`, so there's nothing to break yet.

- [ ] **Step 3: Commit**

```bash
git add shared/api.ts
git commit -m "feat(shared/api): declare q query param on /api/hits"
```

---

## Task 2: Implement the server-side `q` filter

**Files:**
- Modify: `server/api/hits.get.ts:19-91`

- [ ] **Step 1: Add a sanitization helper above the handler**

Add this helper just below the `SORTS` constant (currently at line 17), before `export default defineCachedHandler`:

```ts
function sanitizeQ(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Cap length, strip ASCII control chars, trim whitespace.
  return raw.slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => `\\${m}`)
}
```

- [ ] **Step 2: Extend the WHERE clause with the LIKE predicate**

In the handler body, after the existing version-filter block (currently lines 38-45) and before the `total` count query (line 47), insert:

```ts
  const q = sanitizeQ(query.q)
  if (q) {
    where += ` AND (LOWER(s.domain) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(s.title, '')) LIKE ? ESCAPE '\\')`
    const term = `%${escapeLike(q).toLowerCase()}%`
    params.push(term, term)
  }
```

The two bound `term` values feed both the `COUNT(*)` (line 47) and the `SELECT` (line 49) — they share `where` and `params`, so this single insertion covers both. `IFNULL(s.title, '')` is required because `scans.title` is nullable per `shared/api.ts:50`.

- [ ] **Step 3: Extend the cache `getKey` to include `q`**

Replace the `getKey` body (currently lines 87-90):

```ts
  getKey: event => {
    const query = getQuery(event)
    return `hits:${query.page ?? 1}:${query.version ?? 'all'}:${query.sort ?? 'scanned_at'}:${query.order ?? 'desc'}:${query.q ?? ''}`
  }
```

The trailing `query.q ?? ''` slots `q` into the existing cache key. The unfiltered default (`?q` absent) keeps its prior key shape: `hits:1:all:scanned_at:desc:` — but that trailing colon makes it a different cache slot from the pre-change key. The Nitro cache is in-memory with `maxAge: 1` (1 second) so this only matters for the brief moment after deploy. Acceptable; this is the simplest change.

- [ ] **Step 4: Run `pnpm test:types`**

Run: `pnpm test:types`
Expected: PASS. The server handler doesn't import any of the changed types, and `query.q` access via `getQuery` is typed `Record<string, string | string[] | undefined>` (untyped in practice) so adding the read is a no-op for typecheck.

- [ ] **Step 5: Smoke-test the server filter**

Run: `pnpm dev:fixtures`
Then in another terminal:

```bash
curl -s 'http://localhost:3000/api/hits' | head -c 200
curl -s 'http://localhost:3000/api/hits?q=nuxt' | head -c 200
curl -s 'http://localhost:3000/api/hits?q=zzznotreal' | head -c 200
```

Expected:
- First call returns the full unfiltered result set.
- Second call returns only sites whose domain or title contains `nuxt` (case-insensitive).
- Third call returns `{"total":0,"page":1,...,"hits":[]}`.

- [ ] **Step 6: Commit**

```bash
git add server/api/hits.get.ts
git commit -m "feat(api/hits): filter results by q (domain + title)"
```

---

## Task 3: Add page state and URL wiring

**Files:**
- Modify: `app/pages/hits/[[sort]]/[[order]].vue:1-65`

- [ ] **Step 1: Add the new state and helpers in `<script setup>`**

Insert after the `detailPath` function (currently lines 58-64) and before the closing `</script>`:

```ts
const search = ref(typeof route.query.q === 'string' ? route.query.q : '')
const searchTerm = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const inputEl = ref<HTMLInputElement | null>(null)
const router = useRouter()

let timer: ReturnType<typeof setTimeout> | null = null

/** Deep-equal for the subset of LocationQuery we care about (flat string|null|undefined). */
function queryEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a).filter(k => a[k] !== undefined)
  const bKeys = Object.keys(b).filter(k => b[k] !== undefined)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (String(a[k]) !== String(b[k])) return false
  }
  return true
}

function buildNextQuery(trimmed: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(route.query)) {
    if (k === 'q' || k === 'page') continue
    if (typeof v === 'string') next[k] = v
  }
  if (trimmed) next.q = trimmed
  return next
}

function commit(trimmed: string) {
  const next = buildNextQuery(trimmed)
  if (queryEqual(next, route.query as Record<string, unknown>)) return
  router.replace({ name: 'hits-list', params: { sort: sort.value, order: order.value }, query: next })
}

function scheduleUpdate() {
  if (timer) clearTimeout(timer)
  const trimmed = search.value.trim()
  timer = setTimeout(() => commit(trimmed), 300)
}

function commitNow() {
  if (timer) { clearTimeout(timer); timer = null }
  commit(search.value.trim())
}

function clearSearch() {
  if (timer) { clearTimeout(timer); timer = null }
  search.value = ''
  commit('')
  nextTick(() => inputEl.value?.focus())
}

onUnmounted(() => { if (timer) clearTimeout(timer) })
```

Notes:
- `useRouter` is auto-imported by Nuxt; the `const router = useRouter()` line is explicit for clarity but not strictly required. Keep it explicit so the plan is self-contained.
- `buildNextQuery` explicitly omits `q` (set conditionally) and `page` (so a pending debounce doesn't clobber a `?page=` the user has navigated to). Other query params (`version`, future filters) flow through.
- `queryEqual` is a minimal comparator — sufficient for the flat string-valued subset we produce.
- `nextTick` is auto-imported by Nuxt.

- [ ] **Step 2: Extend the `useFetch` query to include `q`**

Replace the existing `useFetch` call (lines 38-40):

```ts
const { data, pending } = await useFetch<APIResponse<'/api/hits'>>('/api/hits', {
  query: computed(() => ({ page: page.value, version: version.value, sort: sort.value, order: order.value, q: searchTerm.value })),
})
```

`searchTerm` reads from `route.query.q`, so when `commit()` calls `router.replace` and the route updates, `searchTerm.value` updates, the computed re-evaluates, and `useFetch` refetches with the new `q` automatically.

- [ ] **Step 3: Run `pnpm test:types`**

Run: `pnpm test:types`
Expected: PASS. The new `query: { q?: string }` on the schema (Task 1) makes `q: searchTerm.value` type-correct.

- [ ] **Step 4: Commit**

```bash
git add 'app/pages/hits/[[sort]]/[[order]].vue'
git commit -m "feat(hits): wire search term to URL and refetch"
```

---

## Task 4: Add the search input, empty state, and styles

**Files:**
- Modify: `app/pages/hits/[[sort]]/[[order]].vue:67-160`

- [ ] **Step 1: Add the search input to `.controls`**

Replace the existing `<nav class="controls">` block (lines 74-83) with:

```vue
    <nav class="controls" aria-label="Sort and search sites">
      <span id="sort-label" class="control-label">sort:</span>
      <NuxtLink
        v-for="opt in SORT_OPTIONS"
        :key="opt.key"
        :to="sortPath(opt)"
        :class="['sort-link', { active: sort === opt.key }]"
        :aria-current="sort === opt.key ? 'true' : undefined"
      >{{ opt.label }}</NuxtLink>
      <span class="search-control">
        <label for="hits-search" class="control-label">search:</label>
        <input
          id="hits-search"
          ref="inputEl"
          v-model="search"
          type="search"
          placeholder="filter sites…"
          autocomplete="off"
          spellcheck="false"
          aria-label="Filter sites by domain or title"
          @input="scheduleUpdate"
          @keydown.enter.prevent="commitNow"
        >
      </span>
    </nav>
```

The `<span class="search-control">` sits inside `.controls` so the existing `flex-wrap: wrap` and `align-items` rules apply. The `search:` label matches the `sort:` label pattern at line 75.

- [ ] **Step 2: Update the loading indicator to drop the `&& !data` guard**

Replace the loading div (line 85):

```vue
    <div v-if="pending" role="status" aria-live="polite" class="muted">loading…</div>
```

So first load AND refetch both show "loading…"; the stale grid stays rendered during refetch (no flicker).

- [ ] **Step 3: Gate the grid on length > 0 and add the empty state**

Replace the existing `<ul>` (line 87):

```vue
    <ul v-if="data" class="grid" role="list">
```

with:

```vue
    <ul v-if="data && data.hits.length > 0" class="grid" role="list">
```

Then immediately after the closing `</ul>` (currently line 112) and before the pagination `<nav>` (line 114), insert:

```vue

    <p v-else-if="data" class="muted empty" role="status">
      no sites match this filter
      <button
        v-if="searchTerm"
        type="button"
        class="empty-clear"
        @click="clearSearch"
      >clear search</button>
    </p>
```

`v-else-if="data"` chains with the grid's `v-if` and the loading indicator's `v-if` — exactly one of the three renders at a time. The `v-if="searchTerm"` on the button gates it to the URL state, not the local input ref.

- [ ] **Step 4: Add the new styles to the existing `<style scoped>` block**

In the `<style scoped>` block (lines 136-160), change the existing `.controls` rule (line 137):

```css
.controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; align-items: center; }
```

(`align-items: baseline` → `align-items: center` so the input box aligns with the pill text.)

Then insert these new rules just after the `.controls` rule and before `.control-label`:

```css
.search-control { margin-left: auto; display: inline-flex; align-items: center; gap: 0.4rem; }
.search-control input { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 0.25rem 0.6rem; font: inherit; font-size: 0.85rem; min-width: 12rem; }
.search-control input:focus-visible { border-color: var(--accent); outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.search-control input::-webkit-search-cancel-button { cursor: pointer; }
.empty { margin: 2rem 0; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.empty-clear { background: transparent; border: 1px solid var(--border); color: var(--accent); padding: 0.2rem 0.6rem; font-family: inherit; font-size: 0.85rem; border-radius: 3px; cursor: pointer; }
.empty-clear:hover { border-color: var(--accent); }
.empty-clear:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
```

- [ ] **Step 5: Run `pnpm test:types`**

Run: `pnpm test:types`
Expected: PASS. No new types introduced in the template; the new `inputEl` ref is already declared in Task 3.

- [ ] **Step 6: Commit**

```bash
git add 'app/pages/hits/[[sort]]/[[order]].vue'
git commit -m "feat(hits): add search input, empty state, and clear action"
```

---

## Task 5: Manual verification

This task has no code changes — it's a structured walkthrough. Use `pnpm dev:fixtures` (offline fixture data, no scanner needed) at `http://localhost:3000/hits`.

- [ ] **Step 1: Initial load and basic typing**

1. Load `/hits` — input is empty, grid is unfiltered, header shows the total.
2. Type `nux` — within 300ms, URL becomes `…&q=nux`, grid refilters.
3. Type more characters — URL keeps updating. Use browser back to leave the page; it should *not* unwind the search character by character (one back click leaves the page, confirming `router.replace`).

- [ ] **Step 2: Enter and clear**

4. Press Enter mid-typing — URL updates immediately, no 300ms wait.
5. Click the `×` clear button on the input — input empties, `q` drops from URL, full set returns.

- [ ] **Step 3: Sort and deep link**

6. Type a term, then click a sort pill — search persists in URL, sort updates, both reflected.
7. Land on `/hits/scanned_at/desc?q=foo` directly (paste URL, refresh) — input shows `foo` on first render, grid is filtered.

- [ ] **Step 4: Empty state and clear action**

8. Type a term that matches nothing — grid is hidden, "no sites match this filter" appears with a "clear search" button, header shows `(0)`, "loading…" hides once fetch resolves.
8a. Click the "clear search" button — input empties, `q` drops from URL, full set returns, focus is back on the search input.
8b. Combine a search with a `?version=` that yields zero results — same empty state shows, the "clear search" button is still there and removes only `q`, leaving `?version=` in place (which still yields zero).

- [ ] **Step 5: Edge cases**

9. Paste a 200-character string into the input — it's capped at 100 on the way out. Verify by inspecting the URL: `?q=` is at most 100 chars.
10. Type `100%` — matches literal `100%` in titles/domains, does not match `100` followed by arbitrary characters (escape works). Confirm by checking that results contain the literal `%` rather than any 4-char suffix.

- [ ] **Step 6: Final type check**

Run: `pnpm test:types`
Expected: PASS, with no new errors or warnings introduced by the work in Tasks 1-4.

---

## Self-Review

**1. Spec coverage:**
- Server-side filter with `q` (Tasks 2): ✓
- 100-char cap, control-char strip, LIKE escape (Task 2): ✓
- `total` reflects filtered set (Task 2, sharing `where`/`params`): ✓
- Cache `getKey` includes `q` (Task 2): ✓
- `q?: string` on request schema (Task 1): ✓
- `search` and `searchTerm` refs from URL (Task 3): ✓
- 300ms debounce + `router.replace` (Task 3): ✓
- Enter flushes immediately (Task 3): ✓
- `onUnmounted` cleanup (Task 3): ✓
- Deep-equal no-op guard (Task 3): ✓
- Drop `q` from URL when empty (Task 3): ✓
- `clearSearch()` with refocus (Task 3): ✓
- Search input markup (Task 4): ✓
- Loading indicator on refetch (Task 4): ✓
- Empty state paragraph (Task 4): ✓
- Clear-search button gated on `searchTerm` (Task 4): ✓
- Styles (Task 4): ✓
- Accessibility (Task 4: label, aria-label, `:focus-visible`, `role="status"`): ✓
- Manual 12-step verification (Task 5): ✓

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N" found. All code blocks are complete.

**3. Type consistency:**
- `search`, `searchTerm`, `inputEl` are introduced in Task 3 and used in Task 4. Consistent.
- `commit`, `scheduleUpdate`, `commitNow`, `clearSearch` defined in Task 3; bound in Task 4. Consistent.
- `queryEqual` and `buildNextQuery` defined and used only in Task 3. Self-contained.
- The server-side `sanitizeQ`/`escapeLike` helpers are not used outside Task 2. Self-contained.
- The `q?: string` schema addition (Task 1) is consumed in Task 3's `useFetch` call. Consistent.
- `route.query.q` access pattern (typeof check, string) is consistent across `search`, `searchTerm`, and the existing `version`/`page` computeds.

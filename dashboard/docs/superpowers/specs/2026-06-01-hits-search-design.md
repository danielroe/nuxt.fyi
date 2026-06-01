# Hits page search

**Date:** 2026-06-01
**Status:** Approved, awaiting implementation plan

## Context

The hits page (`app/pages/hits/[[sort]]/[[order]].vue`) lists detected Nuxt sites in a paginated grid. The page already supports two URL-driven controls: the sort pills (`/hits/<sort>/<order>`) and a `?version=` filter, both of which refetch from `/api/hits` server-side. There is no way to find a specific site by name or title.

This change adds a search input to the existing `.controls` row, next to the sort pills. Typing into the input navigates to a URL with `?q=<term>`, which the page uses to refetch a server-filtered result set. The URL is the source of truth, matching the rest of the site.

## Goals

- Add a search input in the same row as the sort pills on `/hits`
- Filter the result set by substring match against `domain` and `title`
- Keep the search state in the URL (`?q=…`) so it's shareable, bookmarkable, and consistent with `?version=`
- Reuse the existing "loading…" indicator for refetch feedback
- No new UI components, no new dependencies

## Non-goals

- Multi-token / boolean search (`foo AND bar`, `"exact phrase"`, etc.)
- Highlighting matches in the grid
- Search-as-you-type suggestions dropdown
- Search on the `/recent` page (it has its own filter pills; out of scope)
- A separate `/search` route — search is a filter on the existing list, not its own page

## Architecture

Three files change. No new files in `app/` or `server/`; one new spec file in `docs/`.

### 1. `server/api/hits.get.ts` — server-side filter

- Read `query.q` as a string. Trim whitespace. If length > 100, cap at 100. Strip control characters (`[\u0000-\u001f\u007f]`). Treat empty after trim as absent.
- When `q` is non-empty, append a LIKE predicate to the existing `where` clause:
  ```sql
  AND (LOWER(s.domain) LIKE ? ESCAPE '\' OR LOWER(IFNULL(s.title, '')) LIKE ? ESCAPE '\')
  ```
- Build the bound term as `'%' + escapeLike(q).toLowerCase() + '%'`, where `escapeLike` replaces `\\`, `%`, `_` with a `\\` prefix so user input is matched literally.
- The same predicate and the same two bound params go into the `COUNT(*)` query so `total` and `pageCount` reflect the filtered set. The existing `where` and `params` variables already flow into both queries, so this is a single extension point.
- Extend the Nitro cache `getKey` to include `query.q` (empty string when absent), so the unfiltered default keeps its current cache slot:
  ```ts
  return `hits:${query.page ?? 1}:${query.version ?? 'all'}:${query.sort ?? 'scanned_at'}:${query.order ?? 'desc'}:${query.q ?? ''}`
  ```
- Response shape (`HitsResponse`) is unchanged. `total` becomes the filtered count; `hits` is the filtered page.

### 2. `shared/api.ts` — request-side type

Add `q?: string` to the request side of the `/api/hits` entry in `APISchema` so `useFetch<APIResponse<'/api/hits'>>('/api/hits', { query: { q: searchTerm.value } })` is type-correct via `fetchdts`. The response schema is unchanged.

### 3. `app/pages/hits/[[sort]]/[[order]].vue` — input + URL wiring

**State**:
- `const search = ref(typeof route.query.q === 'string' ? route.query.q : '')` — local input state, initialized from the URL so deep links render the term in the input.
- `const searchTerm = computed(() => typeof route.query.q === 'string' ? route.query.q : '')` — read by the fetch; this is what makes the URL the source of truth.
- `const inputEl = ref<HTMLInputElement | null>(null)` — template ref on the search input, used by `clearSearch()` to refocus after the URL update resolves.

**Debounce + commit**:
- A `let timer: ReturnType<typeof setTimeout> | null = null` in setup scope.
- `scheduleUpdate()`:
  - Clears any pending timer
  - Sets a new 300ms timer that computes the next query and calls `router.replace`
  - Query construction: start from `route.query`, set `q` to the trimmed input if non-empty, or delete `q` if empty
  - If the resulting query is deep-equal to `route.query`, no-op (skip redundant navigate + fetch)
  - The target route is `{ name: 'hits-list', params: { sort: sort.value, order: order.value }, query }` — keeps sort/order in path, filter in query, matching the existing pattern
- `commitNow()`:
  - Clears the pending timer
  - Calls the same "compute and navigate" logic synchronously
  - Bound to `@keydown.enter.prevent` on the input so keyboard users don't wait for the debounce
- `clearSearch()`:
  - Sets `search.value = ''`
  - Builds the next query by deleting `q` from `route.query` (preserves `version` and any other filter)
  - Calls `router.replace` to the same sort/order with that query
  - Then `nextTick` → `inputEl.value?.focus()` so the user can type a new term without reaching for the mouse
  - Bound to the empty state's "clear search" button
- `onUnmounted(() => { if (timer) clearTimeout(timer) })` — prevents a stale timer from firing after navigation

**Fetch**:
- The existing `useFetch` already takes `query: computed(() => ({ page, version, sort, order }))`. Add `q: searchTerm.value` to that computed. When the URL changes, the computed re-evaluates and `useFetch` refetches automatically. No new fetch call.

**Template** (inside the existing `<nav class="controls">`, after the sort pills):
```vue
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
```

**Loading indicator**:
- The existing `<div v-if="pending && !data" role="status" aria-live="polite" class="muted">loading…</div>` becomes `<div v-if="pending" …>loading…</div>`. The `&& !data` guard is dropped:
  - First load: `pending=true, data=undefined` → "loading…" shows, grid is hidden (the empty-state `<p v-else-if="data">` is also gated by `data` being defined). Same behavior as today.
  - Refetch: `pending=true, data=stale` → "loading…" shows between the controls and the grid; the stale grid stays rendered below. No layout shift, no flicker.
- Single word "loading…" for both cases. Differentiating ("filtering…") is a polish choice we can defer.

**Empty state**:
- Today the page renders an empty `<ul>` when `data.hits.length === 0` — visually a void. Match the precedent at `app/pages/recent/[[filter]]/[[sort]]/[[order]].vue:160` (a single muted `<p>` with `role="status"`).
- The grid `<ul>` becomes `v-if="data && data.hits.length > 0"`.
- A new `<p v-else-if="data" class="muted empty" role="status">` renders when the fetch has resolved with zero hits. The message is generic on purpose — `?q=` is one possible cause but not the only one (`?version=`, future filters), and echoing the search term would be misleading when a different filter is the culprit. Wording: `no sites match this filter`.
- When `?q=` is set, append a `<button type="button" class="empty-clear" @click="clearSearch">clear search</button>` to the paragraph. The button gives a one-click recovery path: clicking it removes `q` from the URL (preserving any other filter), refetches, and refocuses the search input.
- Why a `<button>` not a `<a>`: the action is a same-page filter change, not navigation. Anchors with `href="#"` would push onto history; an in-page `<button>` with `router.replace` matches the rest of the page (which already uses `router.replace` for state changes).

```vue
<ul v-if="data && data.hits.length > 0" class="grid" role="list">
  ...existing items...
</ul>

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

**Styles** (scoped additions to the page):
- `.controls { align-items: center }` (was `baseline`) — aligns the search input box with the pill text baseline
- `.search-control { margin-left: auto; display: inline-flex; align-items: center; gap: 0.4rem }` — pushes to the right edge of the row, mirrors the `sort:` label pattern
- `.search-control input { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 0.25rem 0.6rem; font: inherit; font-size: 0.85rem; min-width: 12rem }` — matches `.sort-link` padding and font-size, and the border treatment from `app/components/SubmitForm.vue:92-101`
- `.search-control input:focus-visible { border-color: var(--accent); outline: 2px solid var(--focus-ring); outline-offset: 2px }` — same focus ring as the rest of the site
- `.search-control input::-webkit-search-cancel-button { cursor: pointer }` — keep the native `×` clear button visible and clickable
- `.empty { margin: 2rem 0; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap }` — breathing room above the message, inline alignment for the clear button
- `.empty-clear { background: transparent; border: 1px solid var(--border); color: var(--accent); padding: 0.2rem 0.6rem; font-family: inherit; font-size: 0.85rem; border-radius: 3px; cursor: pointer }` — same border treatment as the sort pills, accent color to draw the eye
- `.empty-clear:hover { border-color: var(--accent) }`
- `.empty-clear:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px }`

The page already has `flex-wrap: wrap` on `.controls`, so on narrow screens the search input drops to a new line naturally. The `min-width: 12rem` keeps it usable when wrapped.

## Data flow

```
user types "nux" in input
  └─> v-model updates local `search` ref (immediate visual feedback)
  └─> @input fires scheduleUpdate()
       └─> starts 300ms timer
            └─> timer fires:
                 ├─> builds { ...route.query, q: 'nux' }
                 ├─> if unchanged: no-op
                 └─> router.replace(...)
                      └─> route.query.q updates
                           └─> `searchTerm` computed updates
                                └─> useFetch's `query` computed updates
                                     └─> useFetch refetches /api/hits?q=nux
                                          └─> `data` updates → grid re-renders
                                          └─> `pending` goes true → "loading…" shows between controls and grid
                                          └─> `pending` goes false → "loading…" hides
```

Pressing Enter skips the 300ms wait by clearing the timer and running the same "compute and navigate" logic inline. The native `×` clear button from `type="search"` sets `search` to `''`, which triggers `scheduleUpdate`, which navigates with `q` deleted from the query.

## Edge cases

| Case | Behavior |
|---|---|
| User types the same term that's already in `route.query.q` | `scheduleUpdate` deep-equals the new query against `route.query` and skips the navigate. No redundant fetch. |
| Trimmed input is empty | `q` is deleted from the URL (not set to empty string), so the URL becomes `…?version=v3` rather than `…?q=`. |
| Input contains `%`, `_`, or `\` | Escaped on the server via `escapeLike` so they're matched literally. A user typing `100%` won't accidentally match `100abc`. |
| Input length > 100 | Capped to 100 on the client (defensive). The server also caps at 100 as defense in depth. |
| Control characters in input (`\n`, `\t`, etc.) | Stripped on both client and server before the LIKE is built. |
| User clicks a sort pill while a debounce is pending | The sort click navigates immediately (NuxtLink handles this), which cancels the in-flight refetch and discards the pending debounce. The new URL reflects the new sort and the same `q`. |
| User navigates away mid-debounce | `onUnmounted` clears the timer so no router update fires on a torn-down component. |
| Search yields zero results | `total` is 0, the header still shows `(0)`, the grid is hidden, and the muted "no sites match this filter" paragraph shows. If `?q=` is set, the paragraph includes a "clear search" button. |
| Other filter (`?version=`) yields zero results | Same empty-state paragraph shows. No clear-search button (since `?q=` is not the cause). The user has to clear `?version=` themselves via the version filter UI. |
| Direct deep link to `/hits?…&q=foo` | On hydration, `search` initializes from `route.query.q`, the input shows "foo", and the grid is already filtered (the initial `useFetch` includes `q` in its query). |
| Sort + search coexist | `sortPath` already spreads `...route.query` minus `page`, so `q` (and `version`) flow through unchanged. Changing sort preserves the search. |
| Page param interaction | `q` does not affect `page` handling. Existing pagination nav still works. We do *not* reset to page 1 on search change — the user's expectation is that a new search returns the first page anyway (because the result set changes), and `useFetch` will deliver page 1. If a user lands on `?q=foo&page=3` directly, they stay on page 3 of the filtered set. |

## Accessibility

- Visible `<label for="hits-search">` matches the existing `<span id="sort-label">` pattern — no `sr-only` label.
- `aria-label="Filter sites by domain or title"` on the input as a belt-and-suspenders description for screen readers.
- `type="search"` gives the native `×` clear button on supporting browsers.
- The existing `aria-live="polite"` "loading…" message is reused, so refetch state is announced.
- Focus remains on the input across refetches (no remounting), so keyboard users don't lose their place.
- All new styles use `:focus-visible` to avoid stealing the focus ring on mouse clicks.
- The empty-state paragraph carries `role="status"` so screen readers announce "no sites match this filter" once it appears.
- The clear-search `<button>` is keyboard-reachable (it's a real `<button>`, focusable by default) and its `:focus-visible` ring matches the rest of the site. After click, focus returns to the search input via `clearSearch()`'s `nextTick` + `focus()` call.

## Verification

The repo has no test framework — only `pnpm test:types`. Verification is `pnpm test:types` plus a manual 12-step plan run against `pnpm dev:fixtures`.

**Type check**:
```
pnpm test:types
```
Confirms: (1) `q?: string` on the request side of `APISchema['/api/hits']`, (2) the typed `useFetch` call with `q` in its `query`, (3) the new `search`/`searchTerm` refs in the page compile.

**Manual plan** (run `pnpm dev:fixtures` to use offline fixture data):
1. Load `/hits` — input is empty, grid is unfiltered.
2. Type "nux" — within 300ms, URL becomes `…&q=nux`, grid refilters.
3. Type more characters — URL keeps updating, no extra history entries (use browser back to leave the page; it should not unwind the search character by character).
4. Press Enter mid-typing — URL updates immediately, no 300ms wait.
5. Click the `×` clear button — input empties, `q` drops from URL, full set returns.
6. Type a term, then click a sort pill — search persists in URL, sort updates, both reflected.
7. Land on `/hits/scanned_at/desc?q=foo` directly (paste URL) — input shows "foo" on first render, grid is filtered.
8. Type a term that matches nothing — grid is hidden, "no sites match this filter" appears with a "clear search" button, header shows `(0)`, "loading…" hides once fetch resolves.
8a. Click the "clear search" button — input empties, `q` drops from URL, full set returns, focus is back on the search input.
8b. Combine a search with a `?version=` that yields zero results (e.g. set both) — same empty state shows, the "clear search" button is still there and removes only `q`, leaving `?version=` in place (which still yields zero).
9. Paste a 200-character string into the input — it's capped at 100 on the way out.
10. Type `100%` — matches literal `100%` in titles/domains, does not match `100` followed by arbitrary characters (escape works).

## Out of scope / follow-ups

- Multi-field search (e.g. searching `version` alongside `domain`/`title`).
- Highlighting matched substrings in the grid.
- Autocomplete / typeahead suggestions.
- Per-filter "clear" actions in the empty state (the clear-search button only clears `?q=`; clearing `?version=` would need its own button next to the version filter, not on the empty state).
- A "no results" empty state with suggested categories (e.g. "browse all v3 sites", "see recently added") — possible follow-up if zero-result searches turn out to be common.
- Server-side full-text search via FTS5 (the dataset is small enough that LIKE is fine; revisit if `total` grows past ~100k).

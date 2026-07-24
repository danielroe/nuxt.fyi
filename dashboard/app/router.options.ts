import type { RouterConfig } from 'nuxt/schema'

/**
 * Vue Router restores the saved position on back/forward, scrolls to a hash target when
 * present, and otherwise leaves the viewport where it is on a same-path navigation. The
 * paginated lists change only `?page=`, so the default would leave the reader stranded at
 * the bottom of the page after clicking "next". Force a scroll to the top when the `page`
 * query changes so the next batch starts from the top.
 */
export default <RouterConfig> {
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) return { el: to.hash, top: 0 }
    if (to.path === from.path && to.query.page !== from.query.page) {
      return { left: 0, top: 0, behavior: 'smooth' }
    }
    if (to.path !== from.path) return { left: 0, top: 0 }
    return false
  },
}

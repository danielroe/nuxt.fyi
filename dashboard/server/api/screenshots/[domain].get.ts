/**
 * Serves daemon-captured screenshots as JPEG bytes from the shared screenshot directory.
 *
 * The daemon writes files at `<screenshotDir>/<safeName(domain)>.jpg` where safeName
 * collapses anything outside [a-z0-9.-] to `_`. We apply the same sanitisation here so the
 * dashboard URL and the daemon path stay aligned, and to prevent path-traversal
 * (`../etc/passwd` becomes `__etc_passwd`).
 */

function safeName(domain: string): string {
  return domain.replace(/[^a-z0-9.-]/gi, '_')
}

export default defineEventHandler(async (event) => {
  const domain = getRouterParam(event, 'domain')
  if (!domain) {
    throw createError({ statusCode: 400, statusMessage: 'missing domain' })
  }
  const key = `${safeName(domain)}.jpg`
  const storage = useStorage('screenshots')
  const buf = await storage.getItemRaw<Buffer>(key)
  if (!buf) {
    throw createError({ statusCode: 404, statusMessage: 'screenshot not found' })
  }
  const meta = await storage.getMeta(key)
  setResponseHeader(event, 'content-type', 'image/jpeg')
  setResponseHeader(event, 'content-length', buf.length)
  if (meta?.mtime) {
    setResponseHeader(event, 'last-modified', new Date(meta.mtime).toUTCString())
  }
  return buf
})

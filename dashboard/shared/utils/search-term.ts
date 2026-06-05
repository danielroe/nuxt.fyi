/**
 * Strips and clamps a raw search term to a safe form for URL storage and SQL LIKE.
 *
 * - Caps at 100 characters (defensive limit shared by client and server)
 * - Strips ASCII control characters (\u0000–\u001f and \u007f) that have no place in a
 *   URL or query — newlines, tabs, NUL, DEL, and the rest of the C0 control block
 * - Trims surrounding whitespace
 *
 */
export function sanitizeSearchTerm(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

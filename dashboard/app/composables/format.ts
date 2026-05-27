export function fmtAge(ms: number | null | undefined): string {
  if (!ms) return '\u2014'
  const delta = Date.now() - ms
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function fmtNumber(n: number | null | undefined): string {
  if (n == null) return '\u2014'
  return n.toLocaleString()
}

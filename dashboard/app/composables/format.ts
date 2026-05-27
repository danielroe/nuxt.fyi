export function fmtNumber(n: number | null | undefined): string {
  if (n == null) return '\u2014'
  return n.toLocaleString()
}

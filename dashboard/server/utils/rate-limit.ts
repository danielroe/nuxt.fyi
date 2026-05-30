interface Bucket {
  count: number
  /** Epoch ms at which the bucket resets. */
  resetAt: number
}

/**
 * In-memory fixed-window rate limiter keyed by an arbitrary string (typically the
 * client IP). Lives for the Nitro process lifetime; fine for a single-machine deploy and
 * trivial to swap for Redis if we ever scale out. Returns the remaining allowance and
 * the reset time so callers can surface a `Retry-After`.
 */
export function rateLimit(buckets: Map<string, Bucket>, key: string, limit: number, windowMs: number): {
  ok: boolean
  remaining: number
  resetAt: number
} {
  const now = Date.now()
  const existing = buckets.get(key)
  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + windowMs }
    buckets.set(key, fresh)
    return { ok: true, remaining: limit - 1, resetAt: fresh.resetAt }
  }
  existing.count++
  if (existing.count > limit) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt }
  }
  return { ok: true, remaining: limit - existing.count, resetAt: existing.resetAt }
}

/** Drop entries that have already expired. Cheap enough to call on every request. */
export function sweep(buckets: Map<string, Bucket>): void {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

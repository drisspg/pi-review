/** Memoize an async function by key for a bounded time; ttlMs <= 0 disables caching entirely. */
export function withTtlCache<A extends unknown[], R>(fn: (...args: A) => Promise<R>, key: (...args: A) => string, ttlMs: number): (...args: A) => Promise<R> {
  if (ttlMs <= 0) return fn;
  const entries = new Map<string, { at: number; value: Promise<R> }>();
  return (...args) => {
    const cacheKey = key(...args);
    const hit = entries.get(cacheKey);
    const now = Date.now();
    if (hit != null && now - hit.at < ttlMs) return hit.value;
    const value = fn(...args).catch((error: unknown) => {
      // Never cache failures: the next caller should retry.
      if (entries.get(cacheKey)?.value === value) entries.delete(cacheKey);
      throw error;
    });
    entries.set(cacheKey, { at: now, value });
    return value;
  };
}

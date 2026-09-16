type CachedFunction<A extends unknown[], R> = ((...args: A) => Promise<R>) & { refresh: (...args: A) => Promise<R> };

/** Memoize an async function by key; refresh bypasses and replaces the cached result. */
export function withTtlCache<A extends unknown[], R>(fn: (...args: A) => Promise<R>, key: (...args: A) => string, ttlMs: number): CachedFunction<A, R> {
  const entries = new Map<string, { at: number; value: Promise<R> }>();
  function load(args: A, refresh: boolean): Promise<R> {
    if (ttlMs <= 0) return fn(...args);
    const cacheKey = key(...args);
    const hit = entries.get(cacheKey);
    const now = Date.now();
    if (!refresh && hit != null && now - hit.at < ttlMs) return hit.value;
    const value = fn(...args).catch((error: unknown) => {
      // Never cache failures: the next caller should retry.
      if (entries.get(cacheKey)?.value === value) entries.delete(cacheKey);
      throw error;
    });
    entries.set(cacheKey, { at: now, value });
    return value;
  }
  return Object.assign((...args: A) => load(args, false), { refresh: (...args: A) => load(args, true) });
}

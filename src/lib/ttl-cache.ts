/**
 * A tiny in-process TTL cache for expensive, read-only computations.
 *
 * Scope is deliberately small: this is not a general cache, and it is not a
 * substitute for HTTP caching. It exists for the handful of endpoints whose
 * answer is expensive to build and is allowed to be a few seconds stale —
 * analytics is the one that made it necessary, because it walks up to 20,000
 * transactions on every request.
 *
 * Two properties matter for correctness here:
 *
 *   - Concurrent misses share one load. Without the `pending` map, ten tabs
 *     opening the dashboard at once would each start their own full scan, which
 *     is the exact stampede the cache is supposed to prevent.
 *   - Writes can evict explicitly. A cache that is only time-based makes a
 *     movement invisible on the dashboard for the whole TTL, which reads as a
 *     bug to the person who just recorded it.
 *
 * Per process, like every other in-memory structure in this app. In a
 * multi-instance deployment each instance has its own copy; the TTL keeps them
 * within one interval of each other and no correctness decision depends on it.
 */

type Entry = { value: unknown; expiresAt: number };

const MAX_ENTRIES = 200;

const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

export function memoGet<T>(key: string): T | undefined {
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function memoSet<T>(key: string, value: T, ttlMs: number): void {
  if (entries.size >= MAX_ENTRIES) entries.clear();
  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Drop one key, or every key beginning with `prefix`. */
export function memoClear(prefix: string): void {
  for (const key of entries.keys()) {
    if (key === prefix || key.startsWith(prefix)) entries.delete(key);
  }
}

/**
 * Read through the cache, collapsing concurrent misses onto one load.
 *
 * A rejected load is never cached, so a transient database failure is retried by
 * the next request rather than being remembered for the whole TTL.
 */
export async function memoize<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>
): Promise<T> {
  const hit = memoGet<T>(key);
  if (hit !== undefined) return hit;

  const inFlight = pending.get(key) as Promise<T> | undefined;
  if (inFlight) return inFlight;

  const attempt = load()
    .then((value) => {
      memoSet(key, value, ttlMs);
      return value;
    })
    .finally(() => {
      if (pending.get(key) === attempt) pending.delete(key);
    });

  pending.set(key, attempt);
  return attempt;
}

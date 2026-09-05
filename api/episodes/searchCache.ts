/**
 * 1h TTL, in-memory, per-instance cache for `api/episodes/search.ts`'s
 * Apple fallback (S-07). Keyed by normalized query + scope (`show=`
 * value, if any) so a scoped and unscoped search for the same text don't
 * collide. Same per-warm-instance caveat as appleBucket.ts/showIdMap.ts —
 * this is a hit-rate optimization, not a correctness guarantee, and a
 * cold start or a different concurrent instance simply misses and
 * refetches.
 */

export interface Clock {
  now(): number;
}
export const realClock: Clock = { now: () => Date.now() };

const ONE_HOUR_MS = 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private store = new Map<string, CacheEntry<T>>();

  constructor(ttlMs: number = ONE_HOUR_MS, clock: Clock = realClock) {
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.clock.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });
  }

  /** Test-only observability. */
  size(): number {
    return this.store.size;
  }
}

export function normalizeQueryKey(q: string, show: string | null, limit: number): string {
  return `${show ?? ""}::${limit}::${q.trim().toLowerCase()}`;
}

export const episodeSearchCache = new TtlCache<unknown>();

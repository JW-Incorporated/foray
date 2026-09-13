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

  /** Drops every entry. Test-only: module-scope caches outlive a single test
   *  (the same reason showIdMap.ts ships `_resetShowIdMapCacheForTests`), and
   *  a failure remembered from an earlier test would answer a later one. */
  clear(): void {
    this.store.clear();
  }
}

export function normalizeQueryKey(q: string, show: string | null, limit: number): string {
  return `${show ?? ""}::${limit}::${q.trim().toLowerCase()}`;
}

export const episodeSearchCache = new TtlCache<unknown>();

/* P-05 piece 3 (docs/search-parity-plan.md §4, 2026-09-12) — THE SHOW PAGE.
   A SHORT, SEPARATE MEMORY FOR FEEDS THAT DID NOT ANSWER.

   `episodeSearchCache` above deliberately stores successes only, which is
   right, and left a hole: the show-scoped path sets `Cache-Control: no-store`
   on an error and skips the `set`, so a show whose feed Vercel cannot reach
   pays the full fetch on EVERY query, forever. Measured 2026-09-12 against the
   live endpoint: `omega-tau` burns 387 / 467 / 756 ms per query and returns
   `degraded: true, n=0` every time. The listener's answer never improves; only
   the bill does.

   KEYED BY SHOW, NOT BY QUERY, because it is the FEED that failed and the feed
   is what the next query would refetch. That is the whole saving: retyping
   inside the box must not re-pay the round trip the last keystroke already
   proved would fail.

   DISTINCT FROM CACHING AN EMPTY SUCCESS, and the distinction is the product
   one. A remembered failure is replayed as `degraded: true` with the original
   error string, which is what the client branches on (`searchShowEpisodesScoped`
   returns `{episodes: null}` on degraded, and the show page falls back to
   `filterLoadedEpisodes`). Replaying it as an empty success would tell the
   listener their query matched nothing, which is a lie.

   90 SECONDS, AND SHORT ON PURPOSE. A cached failure means a feed that comes
   back stays dark until the entry expires, so this window is the cost of the
   saving and it is deliberately smaller than one listening session. Anything
   on the hour scale would turn one bad minute at the feed's origin into a
   visibly broken show page. Per warm instance, like every other cache in this
   directory — a cold start or a different lambda simply refetches. */
export const FEED_FAILURE_TTL_MS = 90 * 1000;
export const episodeFeedFailureCache = new TtlCache<string>(FEED_FAILURE_TTL_MS);

/**
 * The in-memory, per-instance result caches for `api/episodes/search.ts`.
 * Same per-warm-instance caveat as appleBucket.ts/showIdMap.ts: this is a
 * hit-rate optimization, not a correctness guarantee, and a cold start or a
 * different concurrent instance simply misses and refetches.
 *
 * TWO LIFETIMES, ONE CLASS (code-health-2 CH2-38, A1-05):
 *   - `episodeSearchCache`, 1 h: the general search's Apple answers (S-07),
 *     keyed by the folded query (`normalizeQueryKey`).
 *   - the SHOW-SCOPED results (`showScopedResultCache` in search.ts, keyed by
 *     `showScopedQueryKey`) live no longer than the feed they were read from
 *     is fresh (feedCache.ts's FEED_FRESH_MS), and an answer read from a stale
 *     feed copy is never kept at all. They used to share the 1 h cache, so an
 *     answer read while a refresh was refused was replayed for an hour as a
 *     clean success, and a new episode stayed unfindable by that query for as
 *     long. That cache is declared in search.ts because feedCache.ts imports
 *     TtlCache from here.
 *
 * A FEED THAT FAILED is not remembered here any more: the 90 s failure memory
 * (P-05 piece 3) moved into feedCache.ts, so the per-show list and the
 * show-scoped search answer one dead feed the same way (CH2-38, A1-06).
 */

import { normalizeSearchText } from "./clientLimit";
import { realClock, type Clock } from "./clock";

const ONE_HOUR_MS = 60 * 60 * 1000;

/* BOUNDED (round-3 audit, search-api-css-4). An expired entry used to be
   deleted only when its own key was read again, and there was no size cap, so
   every distinct (show, limit, q), every typeahead prefix, stayed in a warm
   instance's memory for its whole life. Now `set` sweeps expired entries off
   the front (every entry shares one TTL, so insertion order is expiry order)
   and evicts the oldest past `maxEntries`. */
export const DEFAULT_MAX_ENTRIES = 500;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly maxEntries: number;
  private store = new Map<string, CacheEntry<T>>();

  constructor(ttlMs: number = ONE_HOUR_MS, clock: Clock = realClock, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
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
    const now = this.clock.now();
    /* Re-inserted, not updated in place, so insertion order stays expiry order. */
    this.store.delete(key);
    this.sweepExpired(now);
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value as string;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  /** Drops expired entries from the oldest end, stopping at the first live one. */
  private sweepExpired(now: number): void {
    for (const [key, entry] of this.store) {
      if (now < entry.expiresAt) break;
      this.store.delete(key);
    }
  }

  /** Test-only observability. */
  size(): number {
    return this.store.size;
  }

  /** Drops every entry. Test-only: module-scope caches outlive a single test
   *  (the same reason breadthCatalog.ts ships `_setCatalogRootForTests`), and
   *  a failure remembered from an earlier test would answer a later one. */
  clear(): void {
    this.store.clear();
  }
}

/** Trivial variants of one query share one key (security-10): case, width,
    punctuation and spacing are folded (clientLimit.ts normalizeSearchText). */
export function normalizeQueryKey(q: string, show: string | null, limit: number): string {
  return `${show ?? ""}::${limit}::${normalizeSearchText(q)}`;
}

/** The key for a SHOW-SCOPED search: exactly the text its matcher compares
    (`searchWithinShow`: `q.trim().toLowerCase()` as a substring of each
    title). The folded key above is wider than that matcher (round-3 review,
    L4): "part-2" and "part 2", "#12" and "12", and every punctuation-only
    query shared one key while matching different titles, so whichever ran
    first answered the other for an hour. The show-scoped path spends no Apple
    slot, so the folding security-10 wanted buys nothing here. */
export function showScopedQueryKey(q: string, show: string, limit: number): string {
  return `${show}::${limit}::=${q.trim().toLowerCase()}`;
}

export const episodeSearchCache = new TtlCache<unknown>();

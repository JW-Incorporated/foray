import { fetchFeedConditional } from "../../backend/src/feeds/conditionalGet";
import { parseFeed, type ParsedFeed } from "../../backend/src/feeds/parser";
import { TtlCache, realClock, type Clock } from "./searchCache";
import { KeyedBuckets } from "./keyedBuckets";

/**
 * ONE PARSED FEED PER SHOW, SHARED BY BOTH LIVE ENDPOINTS (round-3 audit,
 * search-api-css-3).
 *
 * Every show-page search (each distinct `q` misses the query-keyed result
 * cache) and every page of the per-show episode list used to re-download and
 * re-parse the whole feed: up to ~2 MB and 165-2082 ms at the feed's origin,
 * five times over to load a five-page show. This keeps the parsed feed per
 * show for FEED_FRESH_MS and answers from it; past that it revalidates with a
 * conditional GET using the etag/last-modified this used to throw away, so an
 * unchanged feed costs one 304 and no parse.
 *
 * Bounded three ways: at most FEED_CACHE_MAX_SHOWS feeds (oldest first), each
 * dropped FEED_RETAIN_MS after it was last checked, and cached WITHOUT
 * `descriptionHtml` (no caller reads it: the list drops it at the response
 * boundary and search matches titles) so a heavy feed costs a fraction of its
 * download. Actual fetches are limited per show (search-api-css-4).
 *
 * Per warm instance, like every cache in this directory: a cold start or a
 * different instance simply fetches.
 *
 * parseFeed is wrapped: a feed that does not parse is a degraded answer, never
 * a 500 (L6's backend-rest-1 makes parseFeed itself never throw; this does
 * not depend on it landing first).
 */
export const FEED_FRESH_MS = 5 * 60_000;
export const FEED_RETAIN_MS = 60 * 60_000;
export const FEED_CACHE_MAX_SHOWS = 30;
export const FEED_FETCHES_PER_SHOW_PER_MINUTE = 6;
export const FEED_FETCH_LIMITED_ERROR = "too many feed fetches for this show — try again shortly";

interface CachedFeed {
  feedUrl: string;
  parsed: ParsedFeed;
  etag: string | null;
  lastModified: string | null;
  checkedAt: number;
}

export interface FeedRead {
  parsed: ParsedFeed | null;
  error: string | null;
  /** The feed fetch itself failed (worth remembering briefly; see searchCache). */
  feedFailed: boolean;
  /** "cache" (fresh), "revalidated" (304), "fetched", "stale" (served a kept
      copy because a refresh was refused or failed), or "none". */
  source: "cache" | "revalidated" | "fetched" | "stale" | "none";
}

export interface FeedReadOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

function slim(parsed: ParsedFeed): ParsedFeed {
  return { ...parsed, episodes: parsed.episodes.map((ep) => ({ ...ep, descriptionHtml: null })) };
}

export function createFeedReader({
  clock = realClock,
  maxShows = FEED_CACHE_MAX_SHOWS,
  fetchesPerShowPerMinute = FEED_FETCHES_PER_SHOW_PER_MINUTE,
}: { clock?: Clock; maxShows?: number; fetchesPerShowPerMinute?: number } = {}) {
  const cache = new TtlCache<CachedFeed>(FEED_RETAIN_MS, clock, maxShows);
  const buckets = new KeyedBuckets(fetchesPerShowPerMinute, 60_000, clock);

  async function read(showId: string, feedUrl: string, opts: FeedReadOptions = {}): Promise<FeedRead> {
    const held = cache.get(showId);
    const kept = held && held.feedUrl === feedUrl ? held : undefined;
    if (kept && clock.now() - kept.checkedAt < FEED_FRESH_MS) {
      return { parsed: kept.parsed, error: null, feedFailed: false, source: "cache" };
    }
    if (!buckets.tryConsume(showId)) {
      if (kept) return { parsed: kept.parsed, error: null, feedFailed: false, source: "stale" };
      return { parsed: null, error: FEED_FETCH_LIMITED_ERROR, feedFailed: false, source: "none" };
    }
    const result = await fetchFeedConditional(
      feedUrl,
      { etag: kept?.etag ?? null, lastModified: kept?.lastModified ?? null },
      { fetchImpl: opts.fetchImpl, userAgent: opts.userAgent }
    );
    if (result.notModified && kept) {
      cache.set(showId, { ...kept, checkedAt: clock.now() });
      return { parsed: kept.parsed, error: null, feedFailed: false, source: "revalidated" };
    }
    if (result.error || result.body === null) {
      if (kept) return { parsed: kept.parsed, error: null, feedFailed: false, source: "stale" };
      return {
        parsed: null,
        error: result.error ?? `unexpected empty body (status ${result.status})`,
        feedFailed: true,
        source: "none",
      };
    }
    let parsed: ParsedFeed;
    try {
      parsed = slim(parseFeed(result.body));
    } catch (err) {
      if (kept) return { parsed: kept.parsed, error: null, feedFailed: false, source: "stale" };
      return { parsed: null, error: `feed could not be parsed: ${(err as Error).message}`, feedFailed: true, source: "none" };
    }
    cache.set(showId, { feedUrl, parsed, etag: result.etag, lastModified: result.lastModified, checkedAt: clock.now() });
    return { parsed, error: null, feedFailed: false, source: "fetched" };
  }

  return {
    read,
    cache,
    buckets,
    /** Test-only: module-scope state outlives a single test. */
    clear(): void {
      cache.clear();
      buckets.clear();
    },
  };
}

/** The reader both live endpoints share, so a show-page search and the list
    of the same show pay for one fetch. */
export const sharedFeedReader = createFeedReader();

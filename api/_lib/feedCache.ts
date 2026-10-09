import { fetchFeedConditional } from "../../backend/src/feeds/conditionalGet";
import { parseFeed, type ParsedFeed } from "../../backend/src/feeds/parser";
import { TtlCache } from "./searchCache";
import { realClock, type Clock } from "./clock";
import { KeyedBuckets } from "./keyedBuckets";
import { guardFeedFetch, systemLookup, type LookupAll } from "./feedGuard";

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
 * download. Actual fetches are limited per show (search-api-css-4), and a
 * feed whose fetch just failed is answered from a 90 s memory of that failure
 * instead of being fetched again (FEED_FAILURE_TTL_MS below).
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

/* A SHORT MEMORY FOR FEEDS THAT DID NOT ANSWER (P-05 piece 3,
   docs/search-parity-plan.md §4; moved here from searchCache.ts by
   code-health-2 CH2-38, A1-06).

   The parsed-feed cache above keeps successes only, which left a hole: a show
   whose feed Vercel cannot reach paid the full fetch on EVERY request.
   Measured 2026-09-12 against the live search endpoint: `omega-tau` burned
   387 / 467 / 756 ms per query and answered `degraded: true, n=0` every time.
   The fix used to live on the search path alone, so the show page's list
   re-fetched the dead feed for every visitor (up to the per-show budget, each
   fetch able to hold the function for conditionalGet.ts's 15 s timeout) while
   the search box beside it remembered the failure. It lives here now, so both
   endpoints answer one dead feed the same way.

   KEYED BY SHOW AND FEED URL: it is the feed that failed, and the feed is what
   the next request would refetch. The url is part of the key for the same
   reason the kept parse checks it: a `pi:` show resolved through another shard
   key may name another feed.

   ONLY A FETCH THAT WENT OUT AND FAILED (or came back unparseable) is
   remembered. A refusal by the per-show budget never touched the network and
   stays unremembered, and a failed refresh over a kept copy is answered from
   that copy (`stale`), so it is never remembered either.

   A REMEMBERED FAILURE IS REPLAYED AS A FAILURE, with its original error,
   never as an empty success: both endpoints answer it degraded and no-store,
   and the client branches on `degraded` (the show page's search box falls
   back to `filterLoadedEpisodes`).

   90 SECONDS, AND SHORT ON PURPOSE. A feed that comes back stays dark until
   the entry expires, so this window is the cost of the saving, deliberately
   smaller than one listening session. Per warm instance, like every cache in
   this directory: a cold start or a different instance simply refetches. */
export const FEED_FAILURE_TTL_MS = 90 * 1000;

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
  /** The feed fetch itself failed, now or inside FEED_FAILURE_TTL_MS (then
      answered from the failure memory, with the original error). */
  feedFailed: boolean;
  /** "cache" (fresh), "revalidated" (304), "fetched", "stale" (served a kept
      copy because a refresh was refused or failed), or "none". */
  source: "cache" | "revalidated" | "fetched" | "stale" | "none";
}

/* No User-Agent option (code-health-2 CH2-39, B1-12): every feed fetch sends
   the product's one identity, which fetchFeedConditional sets itself. */
export interface FeedReadOptions {
  fetchImpl?: typeof fetch;
}

function slim(parsed: ParsedFeed): ParsedFeed {
  return { ...parsed, episodes: parsed.episodes.map((ep) => ({ ...ep, descriptionHtml: null })) };
}

export function createFeedReader({
  clock = realClock,
  maxShows = FEED_CACHE_MAX_SHOWS,
  fetchesPerShowPerMinute = FEED_FETCHES_PER_SHOW_PER_MINUTE,
  lookup = systemLookup,
}: { clock?: Clock; maxShows?: number; fetchesPerShowPerMinute?: number; lookup?: LookupAll } = {}) {
  const cache = new TtlCache<CachedFeed>(FEED_RETAIN_MS, clock, maxShows);
  const failures = new TtlCache<string>(FEED_FAILURE_TTL_MS, clock);
  const buckets = new KeyedBuckets(fetchesPerShowPerMinute, 60_000, clock);

  function failed(failureKey: string, error: string): FeedRead {
    failures.set(failureKey, error);
    return { parsed: null, error, feedFailed: true, source: "none" };
  }

  async function read(showId: string, feedUrl: string, opts: FeedReadOptions = {}): Promise<FeedRead> {
    const held = cache.get(showId);
    const kept = held && held.feedUrl === feedUrl ? held : undefined;
    if (kept && clock.now() - kept.checkedAt < FEED_FRESH_MS) {
      return { parsed: kept.parsed, error: null, feedFailed: false, source: "cache" };
    }
    const failureKey = `${showId} ${feedUrl}`;
    const remembered = failures.get(failureKey);
    if (remembered !== undefined) return { parsed: null, error: remembered, feedFailed: true, source: "none" };
    if (!buckets.tryConsume(showId)) {
      if (kept) return { parsed: kept.parsed, error: null, feedFailed: false, source: "stale" };
      return { parsed: null, error: FEED_FETCH_LIMITED_ERROR, feedFailed: false, source: "none" };
    }
    const result = await fetchFeedConditional(
      feedUrl,
      { etag: kept?.etag ?? null, lastModified: kept?.lastModified ?? null },
      /* Every feed fetch goes through the destination guard (feedGuard.ts,
         SEC-01): the url and each redirect must name a public address. */
      { fetchImpl: guardFeedFetch(opts.fetchImpl, { lookup }) }
    );
    if (result.notModified && kept) {
      cache.set(showId, { ...kept, checkedAt: clock.now() });
      return { parsed: kept.parsed, error: null, feedFailed: false, source: "revalidated" };
    }
    if (result.error || result.body === null) {
      if (kept) return { parsed: kept.parsed, error: null, feedFailed: false, source: "stale" };
      return failed(failureKey, result.error ?? `unexpected empty body (status ${result.status})`);
    }
    let parsed: ParsedFeed;
    try {
      parsed = slim(parseFeed(result.body));
    } catch (err) {
      if (kept) return { parsed: kept.parsed, error: null, feedFailed: false, source: "stale" };
      return failed(failureKey, `feed could not be parsed: ${(err as Error).message}`);
    }
    cache.set(showId, { feedUrl, parsed, etag: result.etag, lastModified: result.lastModified, checkedAt: clock.now() });
    return { parsed, error: null, feedFailed: false, source: "fetched" };
  }

  return {
    read,
    cache,
    /** Test-only: module-scope state outlives a single test. */
    clear(): void {
      cache.clear();
      failures.clear();
      buckets.clear();
    },
  };
}

/** The reader both live endpoints share, so a show-page search and the list
    of the same show pay for one fetch. */
export const sharedFeedReader = createFeedReader();

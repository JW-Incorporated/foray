import { applyCors } from "../_lib/cors";
import { firstParam } from "../_lib/params";
import { type ParsedEpisode } from "../../backend/src/feeds/parser";
import { appleSearchBucket } from "../_lib/appleBucket";
import { appleSearch } from "../_lib/appleClient";
import { loadShowIdMap } from "../_lib/showIdMap";
import { resolveShow, isPiShowId, UNKNOWN_SHOW_ID } from "../_lib/resolveShow";
import { TtlCache, episodeSearchCache, normalizeQueryKey, showScopedQueryKey } from "../_lib/searchCache";
import { sharedFeedReader, FEED_FRESH_MS, FEED_FETCHES_PER_SHOW_PER_MINUTE, FEED_FETCH_LIMITED_ERROR } from "../_lib/feedCache";
import { episodeIdentity } from "../../backend/src/feeds/episodeIdentity";
import {
  appleCallerBuckets, clientKey, normalizeSearchText, CLIENT_LIMITED_ERROR,
  QUERY_MAX_CHARS, QUERY_MIN_CHARS, QUERY_TOO_LONG_ERROR, QUERY_TOO_SHORT_ERROR,
} from "../_lib/clientLimit";

/**
 * GET /api/episodes/search?q=<query>&show=<show_id>[&k=<shard key>] — episode search (S-07,
 * kanban t_6baccaa0). See the design comment on t_6baccaa0 for the rationale
 * behind the two deviations from a literal reading of the card (id-map
 * fallback pre-S-04, per-instance-only rate limit/cache).
 *
 * TWO MODES, chosen by whether `show=` is present:
 *
 *   1. GENERAL SEARCH (no `show=`): queries Apple's public, keyless
 *      `itunes.apple.com/search?entity=podcastEpisode` endpoint, rate
 *      limited to <=20/min (appleBucket.ts) and cached 1h by normalized
 *      query (searchCache.ts). Every hit's `collectionId` is mapped back to
 *      a 4a `show_id` via showIdMap.ts; a hit that doesn't map to any known
 *      show is DROPPED (never surfaced with a broken show link) — this is
 *      the card's own explicit rule. Since P-05 that map spans BOTH
 *      catalogue files (19.9k ids, not 220), so the rule fires on genuine
 *      strangers rather than on 73 % of every answer — see showIdMap.ts's
 *      header for the measurement.
 *
 *   2. SHOW-SCOPED SEARCH (`show=<show_id>`): no Apple call at all. Fetches
 *      that show's live feed (through api/_lib/feedCache.ts, the parsed feed
 *      kept per show and shared with `api/shows/[show_id]/episodes.ts`;
 *      round-3 audit, search-api-css-3) and filters episodes by
 *      a case-insensitive substring match on title. It doesn't touch the
 *      rate-limited Apple endpoint and gives an exact answer for a show 4a
 *      already knows about — but it is NOT cheap, and S-07's "this is cheap"
 *      did not survive measurement. Its floor is the third-party feed
 *      ORIGIN: 165 ms best case, ~950 ms median on Lex Fridman, 2082 ms
 *      observed worst, and bytes do not predict it (2284 KB in 258 ms vs
 *      2053 KB in 954 ms — a bigger feed on a CDN beat a smaller one on
 *      WordPress 4x). Nothing in this file moves that number, so do not
 *      promise this path will ever feel like the search page's. What P-05
 *      piece 3 could remove is the part we were paying twice: a feed that just
 *      failed is not refetched on the next keystroke (the failure memory now
 *      lives in feedCache.ts, shared with the list; code-health-2 CH2-38).
 *
 *      THE SHOW is resolved by api/_lib/resolveShow.ts, the one resolver the
 *      per-show list uses too (code-health-2 CH2-35, A1-03): the catalogue,
 *      then a `pi:<n>` shard-index show's row in the shard the caller names
 *      with `k=`. SO IN-SHOW SEARCH FOR A `pi:` SHOW NEEDS `k`, the same key
 *      the client passes to the list; without it the answer is the honest
 *      degraded `unknown show_id: pi:<n>`. The client passing it is the
 *      UI-freeze half of A1-03 (docs/roadmap/code-health-2.md founder
 *      question 6; default: pass `k`).
 *
 * DB-MODE: not implemented. The card asks for it to be "stubbed behind
 * DATABASE_URL presence for a later card" — production has no DATABASE_URL
 * today (S-02's PR), so this always takes the no-DB path regardless of the
 * env var. A later card wires an ingested-index-first path the way S-02's
 * episodes.ts wires DB mode for the per-show list.
 *
 * Never touches audio bytes — only ever returns metadata pointers (ADR-0007
 * / product principle #3), same as every other endpoint in this directory.
 */

/* THE EPISODE CALLER'S APPLE BUDGET (code-health-2 CH2-39). The call itself
   is api/_lib/appleClient.ts, shared with the show directory. 8 s is
   UNMEASURED: nobody has timed `entity=podcastEpisode`, and an 8 s bound does
   not keep a 1.5 s target reachable, which is what this line used to claim.
   The directory's 2 s was measured on `entity=podcast` only. Whether this
   drops to 2 s is founder question 3 (docs/roadmap/code-health-2.md §1;
   default: keep 8 s until an episode-entity measurement exists). */
export const APPLE_EPISODE_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 25;

/* OUTBOUND FEED FETCHES ARE LIMITED PER SHOW (round-3 audit, search-api-css-4),
   and the parsed feed is kept per show (search-api-css-3): both live in
   api/_lib/feedCache.ts, shared with the per-show list. A script looping
   `?show=<id>&q=<random>` used to download a multi-MB third-party feed per
   request; now a new `q` reads the kept parse, and a refetch past the per-show
   budget is refused (degraded, never an empty success). Re-exported for tests. */
export { FEED_FETCHES_PER_SHOW_PER_MINUTE, FEED_FETCH_LIMITED_ERROR };
export const feedFetchBuckets = sharedFeedReader.buckets;
export { sharedFeedReader };

/* SHOW-SCOPED ANSWERS ARE KEPT NO LONGER THAN THEIR FEED IS FRESH
   (code-health-2 CH2-38, A1-05). They shared the Apple path's 1 h cache over a
   feed kept fresh for FEED_FRESH_MS, so a new episode stayed unfindable by a
   query for the hour, and an answer read from a STALE copy (the refresh was
   refused or failed) was replayed for that hour as a clean success while the
   list for the same read said stale. Now the answer lives FEED_FRESH_MS, which
   still saves the feed reader's revalidation for a repeated query, and a stale
   answer is never kept: it says `stale: true` and goes out no-store, as the
   list's does. */
interface KeptAnswer {
  episodes: EpisodeSearchResult[];
  source: string[];
  total: number;
  capped: boolean;
}
export const showScopedResultCache = new TtlCache<KeptAnswer>(FEED_FRESH_MS);

/* THE APPLE ASK IS NOT THE CALLER'S `limit` (defect 2, 2026-09-13).
 *
 * `entity=podcastEpisode` returns far fewer rows than the number asked for
 * when that number is small, and the shortfall is worst exactly where the app
 * lives. Measured against Apple directly, 2026-09-13, three samples per cell:
 *
 *   query          ask=10   ask=25   ask=50   ask=100   ask=200
 *   history           4       16       38        82        82
 *   true crime        6       21       46        91        91
 *   sleep             9       19       37        81        81
 *   fridman          10       25       50       100       100
 *
 * End to end, the live endpoint returned 4 / 15 / 36 rows for `history` at
 * limit 10 / 25 / 50 on the same day, so the shortfall is Apple's and not
 * ours: `mapAppleHit`'s drop rule accounts for 0-2 rows at every limit.
 * `api/episodes/search?q=history&limit=10` — which is what app.js asks on
 * every search — therefore filled 4 of the 10 slots it had.
 *
 * So the ask is decoupled: over-fetch from Apple, then `.slice(0, limit)`
 * after mapping, which the handler already did. `limit * 2`, floored at
 * OVERFETCH_MIN and capped at Apple's own 200, is what the table above
 * supports — the worst observed YIELD at an ask of 50 or more is 0.74
 * (`sleep`, 37 of 50), so doubling covers every caller limit the handler
 * accepts, while an ask of 10 yields as little as 0.40 and cannot.
 *
 * WHAT IT COSTS, because this is the one change here that could make search
 * feel slower. Paired alternating samples against Apple, 12 reps per arm,
 * 2026-09-13: ask=10 median 35-44 ms, ask=50 median 46-51 ms, ask=100 median
 * 60-63 ms. The over-fetch a limit=10 caller now triggers is +5 to +15 ms
 * (median +11 ms) on the Vercel -> Apple leg. The listener's device pays NONE
 * of the extra bytes: the response is sliced to `limit` before it is
 * serialised, so the client payload is the same size it was. The bigger
 * response (12 KB -> 103 KB for `history`) is entirely inside the function. */
const APPLE_OVERFETCH_FACTOR = 2;
const APPLE_OVERFETCH_MIN = 50;
const APPLE_OVERFETCH_MAX = 200; // Apple's own documented ceiling for `limit`

/** How many rows to ask Apple for when the caller wants `limit` of them. */
export function appleEpisodeAsk(limit: number): number {
  return Math.min(APPLE_OVERFETCH_MAX, Math.max(APPLE_OVERFETCH_MIN, limit * APPLE_OVERFETCH_FACTOR));
}

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(): void;
}

export interface EpisodeSearchResult {
  show_id: string;
  show_title: string | null;
  title: string;
  guid: string | null;
  description_text: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  audio_url: string | null;
  /** The show's square, when the source carries one (Apple's `artworkUrl600`).
   *  Null for a live-feed row; the client falls back to the show record it
   *  already holds. Without it, an episode played from Search reached the lock
   *  screen and CarPlay with the 4a icon (audit round 2, search-8). */
  artwork_url: string | null;
  source: "apple" | "live";
}

interface AppleEpisodeHit {
  collectionId?: number;
  collectionName?: string;
  trackName?: string;
  episodeGuid?: string;
  description?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  episodeUrl?: string;
  artworkUrl600?: string;
  artworkUrl160?: string;
  artworkUrl60?: string;
}

/** Maps one Apple search hit to our shape, or null if its collectionId doesn't
 *  resolve to a known show.
 *
 *  THE DROP IS STILL RIGHT; ITS OLD JUSTIFICATION IS NOT (P-05, 2026-09-12).
 *  S-07 wrote this drop so a hit was "never surfaced with a broken show link",
 *  which was true while a breadth show page 404'd on a cold open. S-06(b)/#560
 *  landed after S-07 and made every merged-catalogue id resolvable — verified
 *  live, `GET /api/shows/search?id=863897795` -> "The Tim Ferriss Show". So the
 *  reason to drop is now narrow and literal: an id `showIdMap.ts` cannot place
 *  at all would render a row pointing at a show page that does not exist, and
 *  no listener is served by that. What P-05 changed is the SIZE of the set this
 *  catches — 220 ids to 19.9k — because at 220 this line was silently eating
 *  three quarters of every answer and five of eight probe queries returned
 *  nothing at all with `degraded:false`. If this ever starts dropping most hits
 *  again, the id-map is broken, not the query. */
function mapAppleHit(hit: AppleEpisodeHit, idMap: ReadonlyMap<number, string>): EpisodeSearchResult | null {
  if (typeof hit.collectionId !== "number") return null;
  const show_id = idMap.get(hit.collectionId);
  if (!show_id) return null; // genuinely outside our catalogue — see this function's header
  if (!hit.trackName) return null;
  return {
    show_id,
    show_title: hit.collectionName ?? null,
    title: hit.trackName,
    guid: hit.episodeGuid ?? null,
    description_text: hit.description ?? null,
    published_at: hit.releaseDate ?? null,
    duration_seconds: typeof hit.trackTimeMillis === "number" ? Math.round(hit.trackTimeMillis / 1000) : null,
    audio_url: hit.episodeUrl ?? null,
    artwork_url: hit.artworkUrl600 || hit.artworkUrl160 || hit.artworkUrl60 || null,
    source: "apple"
  };
}

/** Maps a freshly-parsed live-feed episode to our shape (show-scoped path).
 *  A guid-less episode gets the id the per-show list serves it under: THE
 *  identity rule (backend/src/feeds/episodeIdentity.ts), which the list and
 *  the DB ingest mint through toCatalogEpisode. Like that mapper, an item
 *  with no enclosure is dropped before an id is minted. */
export function mapLiveEpisode(showId: string, showTitle: string | null, ep: ParsedEpisode): EpisodeSearchResult | null {
  const enclosureUrl = ep.enclosureUrl;
  if (!enclosureUrl) return null;
  return {
    show_id: showId,
    show_title: showTitle,
    title: ep.title,
    guid: episodeIdentity({ guid: ep.guid, title: ep.title, publishedAt: ep.publishedAt, enclosureUrl }),
    description_text: ep.descriptionText || null,
    published_at: ep.publishedAt,
    duration_seconds: ep.duration.seconds,
    audio_url: enclosureUrl,
    artwork_url: null,
    source: "live"
  };
}

/** `limit` here is the CALLER's limit, not the number asked of Apple — see
    `appleEpisodeAsk` and the table above it. The caller's cut is taken after
    mapping, by the handler. */
async function searchApple(
  query: string,
  limit: number,
  fetchImpl: typeof fetch
): Promise<{ hits: AppleEpisodeHit[]; error: string | null }> {
  const { results, error } = await appleSearch<AppleEpisodeHit>("podcastEpisode", query, appleEpisodeAsk(limit), {
    fetchImpl,
    timeoutMs: APPLE_EPISODE_TIMEOUT_MS
  });
  return { hits: results, error };
}

/* A feed that just failed is answered from the feed reader's 90 s failure
   memory (feedCache.ts, P-05 piece 3), shared with the per-show list. Only a
   failed FEED FETCH is remembered there: an unknown `show_id` never touched
   the network, and a missing catalogue file is a deploy gap that a 90-second
   window neither helps nor describes, so both keep answering honestly on
   every request. `stale` says the answer was read from a kept copy whose
   refresh was refused or failed. */
async function searchWithinShow(
  showId: string,
  key: string | null,
  query: string,
  fetchImpl: typeof fetch
): Promise<{ results: EpisodeSearchResult[]; error: string | null; stale: boolean }> {
  /* The show, from the one resolver the per-show list uses
     (api/_lib/resolveShow.ts, CH2-35): the catalogue (a local lookup; an
     `in_curated` breadth id is answered as its curated twin, so the rows
     carry the twin's show_id and the feed is the one the twin's episode list
     reads), then a `pi:` show's shard row named by `key`. None of its
     failures is a feed failure: an unknown id never touched the network, a
     missing catalogue pair is a deploy gap (vercel.json's includeFiles /
     api/_test/vercel-bundle.test.mjs) that a 90-second window neither helps
     nor describes, and an unreadable shard release must be asked again at
     once (the list's rule). Each answers honestly, degraded, every time. */
  const lookup = await resolveShow(showId, key);
  if (!lookup.meta) {
    const error = lookup.error === UNKNOWN_SHOW_ID ? `${UNKNOWN_SHOW_ID}: ${showId}` : lookup.error;
    return { results: [], error, stale: false };
  }
  const meta = lookup.meta;

  const feed = await sharedFeedReader.read(meta.showId, meta.feedUrl, { fetchImpl });
  if (!feed.parsed) return { results: [], error: feed.error ?? "feed unavailable", stale: false };

  const parsed = feed.parsed;
  const q = query.trim().toLowerCase();
  const results = parsed.episodes
    .map((ep) => (ep.title.toLowerCase().includes(q) ? mapLiveEpisode(meta.showId, meta.title, ep) : null))
    .filter((ep): ep is EpisodeSearchResult => ep !== null);
  return { results, error: null, stale: feed.source === "stale" };
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (applyCors(req, res)) return; // OPTIONS preflight already answered

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const q = firstParam(req.query.q);
  if (!q || !q.trim()) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  if (q.length > QUERY_MAX_CHARS) {
    res.status(400).json({ error: QUERY_TOO_LONG_ERROR });
    return;
  }

  const showScope = firstParam(req.query.show);
  /* A `pi:` show is found only in the shard `k` names (resolveShow.ts). Its
     answers are kept and remembered under the id AND the key, the list's
     rule: a request with another key, or none, never gets an answer that
     only an earlier request's key could resolve. */
  const shardKey = showScope && isPiShowId(showScope) ? firstParam(req.query.k) : null;
  const scopeKey = showScope && isPiShowId(showScope) ? `${showScope} ${shardKey ?? ""}` : showScope;
  const limitParam = firstParam(req.query.limit);
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : MAX_RESULTS;

  /* The show-scoped matcher compares raw lowercased text, so its key must too
     (showScopedQueryKey); the Apple path keys on the folded text. Each path
     keeps its answers in its own cache (see showScopedResultCache). */
  const resultCache = scopeKey ? showScopedResultCache : (episodeSearchCache as TtlCache<KeptAnswer>);
  const cacheKey = scopeKey ? showScopedQueryKey(q, scopeKey, limit) : normalizeQueryKey(q, showScope, limit);
  const cached = resultCache.get(cacheKey);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json({ query: q, show: showScope, episodes: cached.episodes, source: cached.source, total: cached.total, capped: cached.capped, degraded: false, stale: false, error: null });
    return;
  }

  if (showScope && scopeKey) {
    /* A feed that just failed comes back from the feed reader's failure memory
       (feedCache.ts, P-05 piece 3), answered as `degraded: true` with the
       original error and no-store, never as an empty success: the client
       branches on `degraded` and falls back to its own `filterLoadedEpisodes`.
       An answer read from a stale copy is served, says it is stale, and is
       not kept (A1-05). */
    const { results, error, stale } = await searchWithinShow(showScope, shardKey, q, fetch);
    const payload = {
      query: q,
      show: showScope,
      episodes: results.slice(0, limit),
      source: ["live"],
      total: results.length,
      capped: false, // a feed is read whole; the count is the count
      degraded: !!error && results.length === 0,
      stale,
      error: error && results.length === 0 ? error : null
    };
    if (!error && !stale) showScopedResultCache.set(cacheKey, { episodes: payload.episodes, source: payload.source, total: payload.total, capped: payload.capped });
    res.setHeader("Cache-Control", error || stale ? "no-store" : "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json(payload);
    return;
  }

  // General (unscoped) search — the rate-limited Apple path.
  /* security-10: the caller's own budget, and a query worth a slot, before the
     shared Apple bucket. Same one shape as every other answer. */
  const refusal = normalizeSearchText(q).length < QUERY_MIN_CHARS
    ? QUERY_TOO_SHORT_ERROR
    : !appleCallerBuckets.tryConsume(clientKey(req.headers))
      ? CLIENT_LIMITED_ERROR
      : null;
  if (refusal) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ query: q, show: null, episodes: [], source: [], total: 0, capped: false, degraded: true, stale: false, error: refusal });
    return;
  }
  if (!appleSearchBucket.tryConsume()) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      query: q,
      show: null,
      episodes: [],
      source: [],
      /* One shape on every path (audit round 2, honesty-11 added these two to
         the answered paths; a refusal that dropped them would make the client
         and api/_test/episodes-search-degraded-honesty.test.mjs branch on keys). */
      total: 0,
      capped: false,
      degraded: true,
      stale: false,
      error: "rate limit exceeded — try again shortly"
    });
    return;
  }

  const idMap = await loadShowIdMap();
  const { hits, error } = await searchApple(q, limit, fetch);
  const mapped = hits
    .map((hit) => mapAppleHit(hit, idMap.byCollectionId))
    .filter((ep): ep is EpisodeSearchResult => ep !== null);
  const episodes = mapped.slice(0, limit);

  /* HOW MANY WERE CUT (audit round 2, honesty-11). The client asks for ten and
     printed ten with nothing saying whether that was all of them; `total` is
     what this mapped before the cut, and `capped` says Apple returned as many
     rows as it was asked for — so the total is a floor, not the whole count,
     and the client prints it with a "+". */
  const payload = {
    query: q,
    show: null,
    episodes,
    source: episodes.length ? ["apple"] : [],
    total: mapped.length,
    capped: hits.length >= appleEpisodeAsk(limit),
    degraded: !!error,
    stale: false,
    error: error ?? null
  };
  if (!error) episodeSearchCache.set(cacheKey, { episodes: payload.episodes, source: payload.source, total: payload.total, capped: payload.capped });
  res.setHeader("Cache-Control", error ? "no-store" : "public, max-age=300, stale-while-revalidate=3600");
  res.status(200).json(payload);
}

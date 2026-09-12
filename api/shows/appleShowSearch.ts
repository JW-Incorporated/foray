import { SlidingWindowBucket, APPLE_BUCKET_WINDOW_MS, APPLE_BUCKET_CAPACITY } from "../episodes/appleBucket";
import { TtlCache } from "../episodes/searchCache";

/**
 * S-06 (docs/search-plan.md): the Apple fall-through for SHOW search.
 *
 * ============================================================================
 * THE DESIGN COMMENT S-06 ASKS FOR, BEFORE THE CODE
 * ----------------------------------------------------------------------------
 * (1) WHY SERVER-SIDE, ARGUED RATHER THAN ASSUMED.
 * Doing this from the client would need `https://itunes.apple.com` in
 * `index.html`'s CSP `connect-src`, which today names exactly three sources and
 * is pinned by `test/api-origin.test.js` ("the CSP names the API origin, and
 * nothing wider"). `index.html` is UNLISTED in `tools/ci/path-policy.mjs`, so
 * that would be a second human-merge file AND a loosened security pin, for a
 * feature that is a fallback. Server-side needs neither, reuses a rate limiter
 * and a cache that already exist and are already tested, and keeps the
 * listener's typed query going to ONE origin instead of two — which is also
 * what `docs/legal/privacy-policy.md` §2 now describes.
 *
 * (2) THE COST, STATED PLAINLY. The fall-through inherits the ~0.1-3 s round
 * trip S-03 just removed from the interactive path. That is acceptable
 * precisely because it now happens only on a GENUINE miss: the client only
 * asks for it when its own 10,113-row index found nothing, and this endpoint
 * only performs it when the full 19,904-row merged catalogue also found
 * nothing. Two independent gates, and neither is optional — without the
 * second, the client's `chart_rank <= 100` cut would make "zero hits" mean
 * "not in 10,113", and every query for a mid-chart show would burn a slot in
 * a 20/min bucket for a show we already have.
 *
 * (3) NO THIRD RATE LIMITER, NO THIRD CACHE. The card is explicit about this
 * and it is the whole reason this module is thin. `SlidingWindowBucket` and
 * `TtlCache` are imported from `api/episodes/` — the same CLASSES, with their
 * own tests (`api/test/apple-bucket.test.mjs`) — and this file adds only two
 * new INSTANCES of them. Separate instances rather than the shared
 * `appleSearchBucket` singleton, deliberately: episode search and show search
 * hit two different Apple endpoints (`entity=podcastEpisode` vs
 * `entity=podcast`) and a listener typing in the Shows box must not be able to
 * exhaust the budget that makes the Episodes section work, or vice versa. The
 * capacity and window constants ARE shared, so "20/min" means one thing in
 * this repo.
 *
 * (4) THE HONEST LIMITATION, REPEATED RATHER THAN QUIETLY DROPPED.
 * `appleBucket.ts`'s header says it, and it is still true here: a Vercel
 * function is not one long-lived process. A cold start gets a fresh bucket and
 * concurrent warm instances each get their own, so this is a best-effort
 * PER-WARM-INSTANCE ceiling, not a global cap across the deployment. A true
 * global cap needs shared state (Redis/KV), which is new infra and out of
 * scope. Do not let this comment decay into "we cap Apple at 20/min".
 *
 * (5) `artistName` IS KEPT, and that is not incidental. §1.1 measured that our
 * own breadth catalogue has NO author/artist/host field on any of its 19,787
 * rows — the harvester calls Apple's `lookup`, which returns `artistName`, and
 * throws it away. So this fall-through is the only place in the product where
 * the "titles AND authors" half of the Pocket Casts premise is available at
 * all. It is carried through to the client as `artist_name`; a re-harvest that
 * kept the field is the real fix and is not this card's.
 * ============================================================================
 */

const APPLE_SEARCH_URL = "https://itunes.apple.com/search";
/** Verbatim from `api/episodes/search.ts` — one User-Agent for this product. */
const SHOW_USER_AGENT = "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)";
const APPLE_TIMEOUT_MS = 8_000;

/** See (3): our own instances of the shared classes, never a second copy of
    the logic, and never the episode path's singleton. */
export const appleShowBucket = new SlidingWindowBucket(APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS);
export const appleShowCache = new TtlCache<AppleShowResult[]>();

export interface AppleShowRaw {
  collectionId?: number;
  collectionName?: string;
  artistName?: string;
  artworkUrl600?: string;
  artworkUrl100?: string;
  feedUrl?: string;
}

/** The shape `app.js:renderShowSearchResults` already caches into
    `state.breadthShowCache` — matched field for field so a tapped Apple result
    resolves through exactly the same `#/show/:id` path a breadth result does,
    with no new client branch. */
export interface AppleShowResult {
  show_id: string;
  title: string;
  artwork_url: string | null;
  artist_name: string | null;
  editorial_note: null;
  taxonomy_node_ids: never[];
  tier: "breadth";
  source: "apple";
}

/** Normalised cache key. Lowercased and trimmed to match what
    `searchBreadthShows` does to the same query, so "Radiolab" and " radiolab "
    are one question here too. */
export function appleShowCacheKey(query: string, limit: number): string {
  return `${limit}::${String(query || "").trim().toLowerCase()}`;
}

/** One Apple hit -> one client-shaped row, or `null` if it cannot be mapped.
    UNMAPPABLE MEANS DROPPED, never surfaced with a broken link: a result with
    no `collectionId` has no id for `#/show/:id` to resolve, and one with no
    name has nothing to render. Same rule `mapAppleHit` applies on the episode
    side. */
export function mapAppleShow(hit: AppleShowRaw): AppleShowResult | null {
  if (hit?.collectionId === undefined || hit.collectionId === null) return null;
  const title = String(hit.collectionName || "").trim();
  if (!title) return null;
  return {
    show_id: String(hit.collectionId), // matches breadthCatalog.ts's minted id
    title,
    artwork_url: hit.artworkUrl600 || hit.artworkUrl100 || null,
    artist_name: hit.artistName ? String(hit.artistName) : null,
    editorial_note: null,
    taxonomy_node_ids: [],
    tier: "breadth",
    source: "apple",
  };
}

export interface AppleShowSearchOutcome {
  shows: AppleShowResult[];
  /** `"rate-limited"`, a transport/parse message, or null on success. A
      rate-limited or failed fall-through is NEVER an error to the caller — it
      returns the local results with this flag beside them. */
  error: string | null;
  cached: boolean;
}

/**
 * The fall-through itself. Cache first, then the bucket, then Apple.
 *
 * THE ORDER MATTERS: a cached answer must not consume a bucket slot, or a
 * listener retyping the same miss would exhaust the budget on questions we
 * have already answered.
 */
export async function appleShowSearch(
  query: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
  deps: { bucket?: SlidingWindowBucket; cache?: TtlCache<AppleShowResult[]> } = {}
): Promise<AppleShowSearchOutcome> {
  const bucket = deps.bucket ?? appleShowBucket;
  const cache = deps.cache ?? appleShowCache;
  const key = appleShowCacheKey(query, limit);

  const cached = cache.get(key);
  if (cached) return { shows: cached, error: null, cached: true };

  if (!bucket.tryConsume()) {
    return { shows: [], error: "rate limit exceeded — try again shortly", cached: false };
  }

  const url =
    `${APPLE_SEARCH_URL}?entity=podcast&limit=${encodeURIComponent(String(Math.min(limit, 200)))}` +
    `&term=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPLE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": SHOW_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { shows: [], error: `Apple search HTTP ${res.status}`, cached: false };
    const body = (await res.json()) as { results?: AppleShowRaw[] };
    const shows = (body.results ?? [])
      .map(mapAppleShow)
      .filter((s): s is AppleShowResult => s !== null)
      .slice(0, limit);
    /* Only a SUCCESSFUL call is cached, and an empty successful call is a
       success: "Apple has never heard of this either" is a real answer worth
       remembering for an hour. A transport failure is not an answer. */
    cache.set(key, shows);
    return { shows, error: null, cached: false };
  } catch (err) {
    return { shows: [], error: `Apple search fetch error: ${(err as Error).message}`, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

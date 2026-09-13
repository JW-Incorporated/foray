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
 * (6) P-02 (docs/search-parity-plan.md): THE GATE THIS FILE'S NOTE (2) LEANS
 * ON IS GONE, and the note above is left standing as the history rather than
 * quietly rewritten. "Only on a GENUINE miss" was the whole argument for an
 * 8 s timeout and a 20/min bucket; the directory is now a SECOND PASS asked on
 * every show search of >= 3 characters, so both numbers had to be re-argued
 * against measurement rather than inherited. What changed here:
 *
 *   - `APPLE_SHOW_TIMEOUT_MS` is 2 s, not 8 s. 8 s was an episode-feed budget
 *     (`api/episodes/search.ts` fetches a show's live RSS; this fetches one
 *     JSON document from one host). Measured 2026-09-12 over 25 listener
 *     queries against `itunes.apple.com/search?entity=podcast`: 52 ms min,
 *     266 ms median, 698 ms max. 2 s is ~3x the measured worst case and it
 *     bounds what a typeahead's second pass can cost when Apple hangs.
 *   - `mergeDirectoryShows` lives here rather than in the handler, because the
 *     dedup rule is a property of Apple's answer: Apple returns the SAME show
 *     under several `collectionId`s (`lex fridman` -> three rows all titled
 *     "Lex Fridman Podcast", measured), so an id-only dedup surfaces all
 *     three. The normalised-title half is not redundant belt-and-braces; it is
 *     the half doing the work on that query.
 *
 * THE LIMITER IS STILL NOT A SAFETY NET, and under a second pass that is more
 * visibly true, not less. See note (4): 20/min is per warm instance, so the
 * effective ceiling is 20/min x however many instances Vercel is running. A
 * real global cap is shared state (Redis/KV) and new infra. What P-02 could do
 * without new infra is stop a trip from compounding, and that is in
 * `search.ts`: a rate-limited answer now carries the catalogue rows and a short
 * edge TTL instead of `shows: []` with `no-store`.
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
/** 2 s, and NOT `api/episodes/search.ts`'s 8 s — see note (6). Exported so
    `api/test/shows-search-apple.test.mjs` can pin the number rather than the
    behaviour, which is untestable without waiting for it. */
export const APPLE_SHOW_TIMEOUT_MS = 2_000;

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

/**
 * P-02's dedup key, and the reason it is not just the id.
 *
 * Lowercase, then every run of non-letter/non-digit becomes one space, then
 * trim. Character for character the rule `search-parity-plan.md` §4 P-02
 * names, and the same `\p{L}/\p{N}` classes `search-engine.js`'s
 * `SHOW_WORD_BREAK` and `searchBreadthShows.ts`'s copy of it use — Unicode
 * property escapes rather than `\W`, because `\W` is ASCII-only and this
 * catalogue is not ("99% Invisible", "伊藤洋一のRound Up World Now！").
 *
 * An empty result (a title that is all punctuation) is NEVER a dedup key: it
 * would collapse every such title into one row. Callers check for it.
 */
export function normaliseShowTitle(title: string): string {
  return String(title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The dedup key P-02 should have had, and the measurement that replaced the
 * one it did have (adversarial review 2026-09-12, defect 3).
 *
 * Exact normalised EQUALITY cannot see the shape Apple actually varies, which
 * is a SUBTITLE. Joining `data/catalog.json` to `data/catalog-breadth.json` by
 * `apple_collection_id` gives 164 rows whose titles can be compared directly —
 * `catalog-breadth.json`'s title IS Apple's `collectionName` — and FIVE of the
 * 164 disagree. Every one of the five is a suffix or a subtitle, never a
 * different name:
 *
 *   The Twenty Minute VC (20VC)            | …(20VC): Venture Capital | Startup Funding | The Pitch
 *   The TWIML AI Podcast                   | …(formerly This Week in Machine Learning & …)
 *   omega tau                              | omega tau - English only
 *   Around the House with Eric G           | …with Eric G®: Upgrade Your Home Like a Pro
 *   Ask Lisa: The Psychology of Parenting  | Ask Lisa: The Psychology of Raising Tweens & Teens
 *
 * The STEM — the title cut at its first subtitle separator, then normalised —
 * collapses all five; equality collapses none.
 *
 * AND THE INVERSE COST IS REAL, so it is recorded rather than left implicit.
 * Directory rows are title-deduped against catalogue rows, so ANY title rule
 * suppresses a genuinely different show that shares the key — the exact
 * "'The Daily' is not one show" case `mergeDirectoryShows` invokes for the
 * other half of the rule. Measured the same way, 220 curated titles against all
 * 19,787 breadth titles, counting only pairs with different
 * `apple_collection_id`s: equality already suppresses 7, the stem suppresses 9.
 * The two it adds are named, because they are the trade:
 *
 *   Dan Carlin's Hardcore History  <>  Dan Carlin's Hardcore History: Addendum
 *   In The Dark                    <>  In The Dark (Bigfoot, Dogmen, Aliens, …)
 *
 * No title rule separates those from the five above: "X: Addendum" and
 * "omega tau - English only" are the same string shape. Five duplicates
 * collapsed against two spin-offs suppressed is the measured trade, taken
 * deliberately.
 *
 * SEPARATORS ARE THE ONES THE DATA USES AND NO MORE. A bare hyphen is NOT one —
 * it needs surrounding spaces, or "Sword-and-Scale" loses everything after its
 * first word; `(` and `[` need a leading space for the same reason. An empty
 * stem is never a dedup key, exactly as an empty normalised title is not.
 *
 * A PIPE IS NOT ONE EITHER, and that is measured rather than stylistic. `|` was
 * in the first version of this set and earns NOTHING on the committed catalogue
 * — the same 5 of 5 collapse and the same 2 extra suppressions occur with it
 * and without it, because all five real cases cut at `:`, ` - ` or ` (` first.
 * Live it costs: with `|` in the set, `tim ferriss`, `sam harris` and
 * `lex fridman` each lose one row, the same row every time — a derivative feed
 * named `<the real show> | 5 minute podcast summaries`, whose stem becomes the
 * real show's whole title. A pipe is a list separator; `:`, ` - ` and ` (` are
 * subtitle markers.
 *
 * MUST STAY CHARACTER FOR CHARACTER IDENTICAL to `app.js:showTitleDedupStem`,
 * pinned by `test/show-search-fallthrough.test.js` the same way
 * `normaliseShowTitle` is.
 */
export const SHOW_TITLE_SUBTITLE_SEPARATOR = /\s[–—]\s|\s-\s|:|\s\(|\s\[/u;

export function showTitleDedupStem(title: string): string {
  const raw = String(title || "");
  const cut = raw.search(SHOW_TITLE_SUBTITLE_SEPARATOR);
  return normaliseShowTitle(cut > 0 ? raw.slice(0, cut) : raw);
}

/**
 * BOTH KEYS, because the stem is an ADDITION to exact equality and not a
 * replacement for it, and the committed catalogue says so in both directions.
 *
 * Replacing equality with the stem broke a pair equality had been collapsing
 * correctly: `It's a Material World: Materials Science Podcast` (curated) and
 * `It's a Material World | Materials Science Podcast` (Apple). Their full
 * normalised titles are identical — the only difference is which separator the
 * two publishers typed — but their stems are not, because one side cuts at `:`
 * and the other has nothing to cut at. A rule that answers only on stems is
 * therefore not a superset of the one it replaces.
 *
 * MEASURED WITH BOTH, over the 164 rows that join `data/catalog.json` to
 * `data/catalog-breadth.json` by `apple_collection_id`: every one of the 164
 * collapses (equality alone left 5 standing; the stem alone left this one). Over
 * the 220 curated titles against all 19,787 breadth titles, pairs with different
 * `apple_collection_id`s that collapse: 7 with equality alone, 10 with both —
 * and 8 of those 10 are the SAME show under a second Apple collection id, which
 * is the thing this rule exists to collapse. The two that are genuinely
 * different shows are named in `showTitleDedupStem` above; they are the whole
 * cost of the change.
 */
export function showDedupKeys(title: string): string[] {
  const keys: string[] = [];
  for (const k of [normaliseShowTitle(title), showTitleDedupStem(title)]) {
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * P-02: merge the directory's answer BENEATH the catalogue's, deduped by
 * `show_id` (which for an Apple row IS `apple_collection_id`, stringified by
 * `mapAppleShow`) and by normalised title.
 *
 * THE ORDER IS THE CONTRACT: catalogue rows keep their positions and the
 * directory's are appended after them, never interleaved and never in front.
 * The client re-ranks everything it receives with `SearchEngine.rankShows`
 * anyway, but what arrives first is what a caller reading this endpoint
 * directly sees, and "the local one first" is the deck's §1.4 line.
 *
 * `limit` IS NOT APPLIED TO THE MERGED LIST, and that is deliberate rather
 * than an oversight. `searchBreadthShows` has already cut its own answer to
 * `limit`, so a merged cut at `limit` would return ZERO directory rows for
 * exactly the queries where the catalogue filled the quota — measured
 * 2026-09-12 at `limit=25`: `history`, `the daily`, `dark` and `true crime`
 * all return 25 catalogue rows, and all four gain 17-20 rows from the
 * directory. Cutting there would reinstate the old gate under a new name for
 * every broad query. `limit` is therefore PER SOURCE on this path: at most
 * `limit` catalogue rows and at most `limit` directory rows, so a response is
 * bounded at `2 * limit` and a caller can still reason about its size.
 *
 * THE TITLE HALF OF THE DEDUP IS TWO KEYS — the full normalised title AND the
 * stem — see `showTitleDedupStem` and `showDedupKeys` above for the five
 * committed-catalogue rows equality missed, the one the stem alone missed, and
 * the two genuinely different shows the pair suppresses in exchange.
 */
export function mergeDirectoryShows<T extends { show_id: string; title: string }>(
  catalogueRows: readonly T[],
  directoryRows: readonly AppleShowResult[]
): (T | AppleShowResult)[] {
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const row of catalogueRows) {
    ids.add(row.show_id);
    for (const k of showDedupKeys(row.title)) titles.add(k);
  }
  const merged: (T | AppleShowResult)[] = catalogueRows.slice();
  for (const row of directoryRows) {
    if (ids.has(row.show_id)) continue;
    const keys = showDedupKeys(row.title);
    if (keys.some((k) => titles.has(k))) continue;
    ids.add(row.show_id);
    for (const k of keys) titles.add(k);
    merged.push(row);
  }
  return merged;
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
  const timer = setTimeout(() => controller.abort(), APPLE_SHOW_TIMEOUT_MS);
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

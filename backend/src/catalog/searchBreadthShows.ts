import { loadBreadthCatalog, type CatalogueShowEntry } from "./breadthCatalog";

/**
 * Search over the FULL breadth catalogue (curated + breadth tiers), the
 * backend half of A3.1/Q3 (kanban t_8d1a6a58): "the user should never
 * notice any limitations based on our own limited curation." Client-side
 * `SearchEngine.searchShows` in `search-engine.js` stays scoped to the
 * curated 220 (`data/catalog-client.json`) plus the `chart_rank <= 100`
 * index as a fast local first pass — this is the same ranking rule,
 * reimplemented server-side over the merged index because the client module
 * has no Node/DOM-free access to the ~10k-show breadth file and shipping it
 * client-side is exactly what CATALOG-PIPELINE.md §5 rules out.
 *
 * WHY THE RULE IS MIRRORED AND NOT JUST "SOME ORDER" (the defect this file
 * was rewritten to fix, client audit 2026-09-12). `api/shows/search.ts` hands
 * back at most `limit` rows, and THE TRUNCATION IS THE PRODUCT DECISION: what
 * this function cuts at `limit` is gone, and `app.js:mergeBreadth` — which
 * re-ranks every row it receives with `SearchEngine.rankShows` — cannot
 * recover it. So while the client re-ranks whatever arrives (and therefore
 * never displays this file's order), it can only re-rank what this file chose
 * to send. Ranking here by a DIFFERENT rule meant the 25 rows kept were the
 * 25 best under a rule nobody displays. Measured over the real committed
 * catalogue, before the fix: the query "show" shipped the plain-substring row
 * "Antiques Roadshow Detours" and dropped 14 rows the client ranks WORD-START,
 * among them "Money Guy Show" (chart_rank 4); "talk" dropped 14, "news" 12.
 *
 * Deliberately NOT shared code with search-engine.js: that module is a
 * classic browser script (see its own header) with no import surface for a
 * TS backend module to pull from without a build step this endpoint doesn't
 * have. The previous header asked the next author to "update both call sites"
 * by hand if the rule ever grew a fourth bucket — S-04 then added
 * `SHOW_MATCH_WORD_START` on the client alone and this file sat two buckets
 * behind for the whole time in between. Discipline is not the mechanism any
 * more: `test/show-search-ranking.test.js` asserts the two bucket tables are
 * EQUAL, reading both this file's constants and search-engine.js's, and
 * `backend/test/breadthCatalog.test.ts` asserts the two orders agree row for
 * row over the real catalogue. A fifth bucket added on one side only is a red
 * suite, not a silent divergence.
 *
 * THERE IS NO `rank` FIELD ON THE WIRE ANY MORE, and its removal is the point
 * rather than a tidy-up: it was computed here, serialised into every response
 * and read by nobody — `mergeBreadth` re-buckets every row with
 * `rankShows(query, ...)` the moment it arrives, so the number could only ever
 * have been believed by a client that didn't. `chart_rank` replaces it, and
 * that one HAS a named reader: `search-engine.js:popularityBand`. Without it
 * every row from this endpoint was `Number.isFinite(undefined) === false`, i.e.
 * the WORST popularity band, and lost every tie to an index row — which mattered
 * most for exactly the rows only this endpoint has, the chart_rank 101-200 ones
 * `tools/build-show-index.mjs`'s `<=100` cut leaves out of the client index.
 */

/* ---------------------------------------------------------------------------
   THE BUCKET TABLE. Must equal search-engine.js's `SHOW_MATCH_*` constants —
   test/show-search-ranking.test.js reads both files and compares them, so
   these five lines and that file's five lines are one table in two places.
   Declared as plain decimal literals for that reason: the pin parses
   declarations, and a bucket written as an expression would slip past it.
   `SHOW_MATCH_NONE` is a real answer ("this title does not match at all"),
   not an error code.

   search-engine.js's sixth constant, `SHOW_MATCH_UNMATCHED`, is deliberately
   NOT here. It is the bucket for a row that is in a list because a SERVER
   chose it rather than because its title matched, which is a thing only the
   client's `rankShows` can produce — this file filters `SHOW_MATCH_NONE` out
   and never emits an unmatched row. It is also the one client constant
   written as an expression (`SHOW_MATCH_SUBSTRING + 1`) rather than a literal,
   which is how the pin distinguishes it without needing an exception list. */
export const SHOW_MATCH_EXACT = 0;
export const SHOW_MATCH_PREFIX = 1;
export const SHOW_MATCH_WORD_START = 2;
export const SHOW_MATCH_SUBSTRING = 3;
export const SHOW_MATCH_NONE = -1;

/* THE TIER TABLE, interposed ABOVE the bucket in the comparator below, and
   pinned across the two files exactly as the bucket table is. The measurement
   that produced it is in search-engine.js's own header (30 queries, end to end,
   intended show named before the run); the half of it that belongs HERE is
   `history`. The breadth catalogue has far more than 25 rows whose title STARTS
   with "history", so under bucket-first ordering every one of the 25 rows this
   function was allowed to send was a prefix row, and *Dan Carlin's Hardcore
   History* — a CURATED row, chart-listed, and obviously the answer — did not
   survive the `limit` cut at all. It reached the listener only because Apple's
   directory happened to send it too. No amount of client re-ranking could have
   recovered it: the cut is here, so the fix has to be here as well.

   `SHOW_TIER_UNMATCHED` is deliberately absent, like `SHOW_MATCH_UNMATCHED`:
   this file filters `SHOW_MATCH_NONE` out and never emits a row that matched
   nothing. */
export const SHOW_TIER_EXACT = 0;
export const SHOW_TIER_BOUNDARY = 1;
export const SHOW_TIER_SUBSTRING = 2;

/** Which tier a bucket belongs to. Character for character search-engine.js's,
    minus the unmatched branch it has no producer for — a bucket this file can
    never see (`SHOW_MATCH_NONE`) falls through to the substring tier, which is
    unreachable rather than meaningful. */
export function showMatchTier(bucket: number): number {
  if (bucket === SHOW_MATCH_EXACT) return SHOW_TIER_EXACT;
  if (bucket === SHOW_MATCH_PREFIX || bucket === SHOW_MATCH_WORD_START) return SHOW_TIER_BOUNDARY;
  return SHOW_TIER_SUBSTRING;
}

/* What separates two words of a title. Unicode property escapes rather than
   `\W`, because `\W` is ASCII-only and this catalogue is not: "伊藤洋一のRound
   Up World Now！" and "99% Invisible" both have to tokenize sensibly, and an
   ASCII-only class would call every CJK character a word break. Character for
   character search-engine.js's `SHOW_WORD_BREAK`. */
const SHOW_WORD_BREAK = /[^\p{L}\p{N}]/u;

/** Which bucket `title` falls in for an ALREADY trimmed+lowercased `q`. */
export function showMatchBucket(title: string, q: string): number {
  const t = String(title || "").toLowerCase();
  const query = String(q || "");
  if (!query) return SHOW_MATCH_NONE;
  const first = t.indexOf(query);
  if (first === -1) return SHOW_MATCH_NONE;
  if (t === query) return SHOW_MATCH_EXACT;
  if (first === 0) return SHOW_MATCH_PREFIX;
  /* EVERY occurrence is checked, not just the first: "ridman" occurs once in
     "Lex Fridman Podcast" mid-word, but "the" occurs mid-word in "Anything"
     and again at a word start in "The Daily Anything" — stopping at the first
     hit would file the second one as a plain substring. */
  for (let p = first; p !== -1; p = t.indexOf(query, p + 1)) {
    if (SHOW_WORD_BREAK.test(t.charAt(p - 1))) return SHOW_MATCH_WORD_START;
  }
  return SHOW_MATCH_SUBSTRING;
}

/** The bucketed popularity prior, mirroring search-engine.js's. `chart_rank`
    is Apple's PER-GENRE chart position 1-200 (paired with `chart_genre_id`),
    measured over all 19,787 breadth rows in docs/search-plan.md §1.1. Rank 3
    in *Life Sciences* is NOT rank 3 in *Comedy*, so comparing two raw ranks
    across genres compares two different things; the bands collapse it to
    <=10 / <=50 / <=200 / unranked, which is the most the data honestly
    supports. A curated row returns 0 and needs no `chart_rank`: the tier term
    has already placed it. An unranked breadth row is the WORST band, not the
    best — a missing number must never read as zero. */
export const SHOW_PRIOR_BANDS = [10, 50, 200];
export function popularityBand(show: CatalogueShowEntry): number {
  if (show.tier !== "breadth") return 0;
  const rank = Number(show.chart_rank);
  if (!Number.isFinite(rank) || rank <= 0) return SHOW_PRIOR_BANDS.length + 1;
  for (let i = 0; i < SHOW_PRIOR_BANDS.length; i++) {
    const band = SHOW_PRIOR_BANDS[i];
    if (band !== undefined && rank <= band) return i + 1;
  }
  return SHOW_PRIOR_BANDS.length + 1;
}

/* The title tie-break, with the collator built ONCE rather than per
   comparison — search-engine.js's `compareTitles`, same options, and for the
   same measured reason (ICU builds a fresh collator for every bare
   `localeCompare` call; a 90-hit sort cost 216 ms that way and 0.3 ms cached).
   Falls back to code-unit order where `Intl` is absent, which is still a
   total, deterministic order. */
let showTitleCollator: Intl.Collator | false | null = null;
function compareTitles(a: string, b: string): number {
  if (showTitleCollator === null) {
    showTitleCollator =
      typeof Intl !== "undefined" && typeof Intl.Collator === "function"
        ? new Intl.Collator(undefined, { sensitivity: "variant" })
        : false;
  }
  if (showTitleCollator) return showTitleCollator.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The row shape this endpoint returns. It is exactly a catalogue entry: no
    derived field is added on the way out (see the header on `rank`). Kept as a
    named alias because `api/shows/search.ts` and the suites import it. */
export type ShowSearchResult = CatalogueShowEntry;

const DEFAULT_LIMIT = 25;

export function searchBreadthShows(
  query: string,
  limit: number = DEFAULT_LIMIT,
  catalog: CatalogueShowEntry[] = loadBreadthCatalog()
): ShowSearchResult[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  const scored: Array<{ show: CatalogueShowEntry; bucket: number }> = [];

  for (const show of catalog) {
    const bucket = showMatchBucket(show.title, q);
    if (bucket === SHOW_MATCH_NONE) continue;
    scored.push({ show, bucket });
  }

  /* Ties within a bucket, in search-engine.js:compareShowMatches's order and
     no other: curated tier first (richer metadata, higher editorial
     confidence), then the bucketed popularity prior, then a deterministic
     title order.

     THE MATCH INDEX IS NOT A TIE-BREAK, and this comment says so because the
     one it replaces claimed the opposite. It promised "then the earliest match
     index, then alphabetical" beside a comparator that compared rank, tier and
     title and never touched the index at all — a comment describing code that
     was never written. The index is not restored, it is disowned: inside one
     bucket it varies with title length rather than with relevance (S-04's own
     finding, search-engine.js's header), and re-adding it here would put this
     file back out of step with the rule the listener actually sees. */
  scored.sort((a, b) => {
    const at = showMatchTier(a.bucket);
    const bt = showMatchTier(b.bucket);
    if (at !== bt) return at - bt;
    const ab = a.show.tier === "breadth" ? 1 : 0;
    const bb = b.show.tier === "breadth" ? 1 : 0;
    if (ab !== bb) return ab - bb;
    const ap = popularityBand(a.show);
    const bp = popularityBand(b.show);
    if (ap !== bp) return ap - bp;
    /* The bucket, demoted rather than deleted — search-engine.js's line and
       its comment. Two rows the prior cannot separate are still ordered
       prefix-before-word-start. */
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    return compareTitles(a.show.title, b.show.title);
  });

  /* THE CUT, under the order above — which is the whole reason the order
     above is the client's and not this file's own. */
  return scored.slice(0, limit).map((s) => s.show);
}

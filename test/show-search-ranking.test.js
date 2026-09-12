/* S-04 (docs/search-plan.md): the show-search ranking rule.
 *
 * WHAT THIS SUITE IS FOR
 * `search-engine.js:searchShows` used to rank three ways — exact title, title
 * prefix, substring anywhere — and that third bucket is where the show a
 * listener obviously meant went to die: "fridman" put *Lex Fridman Podcast* in
 * the same bucket as every accidental mid-word hit, ordered by match index.
 * S-04 splits it into four (exact > prefix > WORD-START > substring) and adds
 * two tie-breaks the client never had: curated-before-breadth, and Apple's
 * `chart_rank` as a BUCKETED popularity prior.
 *
 * THE PRIOR'S LIMITS ARE THE INTERESTING PART, and two tests here exist only to
 * pin them. `chart_rank` is Apple's PER-GENRE chart position, 1-200, harvested
 * 2026-07-09 (docs/search-plan.md §1.1, measured). Rank 3 in *Life Sciences* is
 * not rank 3 in *Comedy*, so a raw cross-genre comparison compares two
 * different scales and calls the answer a ranking. `popularityBand` collapses
 * it to <=10 / <=50 / <=200 / unranked, which is the most the data honestly
 * supports — and the cross-genre test below is red the moment someone
 * "improves" that into a raw numeric sort.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is
 * not evidence until you have broken it".
 *
 * SYNTHETIC WHERE THE POINT IS THE RULE, REAL WHERE THE POINT IS THE DATA. A
 * four-bucket ordering is pinned on a fixture so the tiers can be stated
 * exactly; the "fridman" case, the bucket monotonicity and the determinism
 * check all run against the REAL committed catalogue, because those are claims
 * about what a listener actually sees.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SearchEngine = require(path.join(ROOT, "search-engine.js"));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const breadth = (title, chart_rank, show_id) => ({ show_id: show_id || title, title, tier: "breadth", chart_rank });
const curated = (title, show_id) => ({ show_id: show_id || title, title });

test("the four buckets rank exact, then prefix, then word-start, then substring", () => {
  /* THE HEADLINE CHANGE. The old rule had no word-start bucket at all, so
     "Casual Show Talk" and "Showering" would have been ordered by match index
     — putting the mid-WORD hit ahead of the word-START hit whenever its index
     happened to be smaller, which is exactly what buried "fridman".

     MUTATION: delete the word-start branch from `showMatchBucket` (return the
     substring bucket instead). "Casual Show Talk" and "Ricochet Showcase" then
     land in the same bucket and the four-way ordering below fails. */
  const shows = [
    breadth("Ricochet Showcase", 5),          // substring, mid-word
    breadth("Casual Show Talk", 5),           // word-start
    breadth("Show Me The Numbers", 5),        // prefix
    breadth("Show", 5),                       // exact
  ];
  const got = SearchEngine.searchShows("show", shows).map((s) => s.title);
  assert.deepStrictEqual(got, [
    "Show", "Show Me The Numbers", "Casual Show Talk", "Ricochet Showcase",
  ]);
});

test("a word-start match reaches the show a listener meant: \"fridman\" puts Lex Fridman Podcast first", () => {
  /* Against the REAL committed catalogue, because this is the complaint the
     card is answering, not a property of a fixture.

     MUTATION: make `showMatchBucket` check only the FIRST occurrence's
     predecessor character instead of walking every occurrence — a title whose
     first occurrence is mid-word and whose second is at a word start then
     files as a plain substring. Also red if the word-start bucket is removed
     outright. */
  const catalog = readJson("data/catalog-client.json");
  const results = SearchEngine.searchShows("fridman", catalog.shows);
  assert.ok(results.length >= 1, "fixture assumption: the curated catalogue contains a Fridman show");
  assert.strictEqual(results[0].show_id, "lex-fridman-podcast");
  assert.strictEqual(
    SearchEngine.showMatchBucket("Lex Fridman Podcast", "fridman").bucket,
    SearchEngine.SHOW_MATCH_WORD_START,
    "a match after a space is a word start, not a bare substring"
  );
});

test("inside one bucket, a curated show beats a breadth show", () => {
  /* The same tie-break backend/src/catalog/searchBreadthShows.ts already
     applies server-side, now applied client-side so the index pass and the
     endpoint pass cannot disagree about which of two equal matches leads.

     A curated row is recognised by the ABSENCE of `tier: "breadth"`, because
     data/catalog-client.json's 220 rows carry no `tier` field at all and are
     the curated set by construction.

     MUTATION: drop the tier term from `compareShowMatches`. "Ada Breadth
     Show" then wins on `localeCompare` and this fails. */
  const shows = [
    breadth("Ada Breadth Show", 1),
    curated("Zeta Curated Show"),
  ];
  const got = SearchEngine.searchShows("show", shows).map((s) => s.show_id);
  assert.deepStrictEqual(got, ["Zeta Curated Show", "Ada Breadth Show"]);
  assert.strictEqual(SearchEngine.popularityBand(curated("Zeta Curated Show")), 0,
    "a curated row needs no chart_rank — the tier term has already placed it");
});

test("the popularity prior is BUCKETED, so two ranks inside one band do not compete across genres", () => {
  /* THE CROSS-GENRE CASE, and the reason this suite exists at all.
     `chart_rank` is Apple's per-genre position (docs/search-plan.md §1.1,
     measured over all 19,787 breadth rows). Rank 3 in one genre and rank 8 in
     another are not comparable, so inside the <=10 band the prior must say
     NOTHING and the deterministic title tie-break must decide.

     MUTATION (the one S-04's card names): replace `popularityBand(a.show)` with
     the raw `a.show.chart_rank` in `compareShowMatches`. "Beta Show" (rank 3)
     then jumps ahead of "Alpha Show" (rank 8) on a comparison that is
     meaningless across genres, and this goes red. */
  const shows = [
    breadth("Beta Show", 3),   // rank 3 in, say, Comedy
    breadth("Alpha Show", 8),  // rank 8 in, say, Life Sciences
  ];
  const got = SearchEngine.searchShows("show", shows).map((s) => s.title);
  assert.deepStrictEqual(got, ["Alpha Show", "Beta Show"],
    "inside one band the prior must not order two per-genre ranks against each other");
  assert.strictEqual(SearchEngine.popularityBand(shows[0]), SearchEngine.popularityBand(shows[1]));
});

test("the prior still separates BANDS, and an unranked breadth row sorts last", () => {
  /* The other direction, so the test above cannot be satisfied by deleting the
     prior entirely: a top-10 show really should beat a rank-150 one, and a row
     with no usable `chart_rank` at all is the worst band rather than the best
     (a missing number must never read as zero).

     MUTATION: make `popularityBand` return 0 for a non-finite rank. "Zzz No
     Rank Show" then leads and this fails. */
  const shows = [
    breadth("Zzz No Rank Show", null),
    breadth("Mmm Mid Show", 150),
    breadth("Aaa Top Show", 4),
  ];
  const got = SearchEngine.searchShows("show", shows).map((s) => s.title);
  assert.deepStrictEqual(got, ["Aaa Top Show", "Mmm Mid Show", "Zzz No Rank Show"]);
  assert.deepStrictEqual(
    SearchEngine.SHOW_PRIOR_BANDS, [10, 50, 200],
    "the bands are the documented <=10 / <=50 / <=200 — changing them changes what the prior claims"
  );
});

test("the result order over the real catalogue is byte-identical across 20 consecutive runs", () => {
  /* S-04's own acceptance line. Determinism is not "no Math.random anywhere":
     an unstable comparator plus a different input order is enough to make two
     runs disagree, which is why the final tie-break is a total order on the
     title rather than a reliance on sort stability.

     Run over the real committed catalogue AND over a deliberately shuffled
     copy of it: same query, same answer. That second half is the one that
     catches a comparator that leans on input order.

     MUTATION: drop the `compareTitles` term from `compareShowMatches`. The
     shuffled-input comparison goes red, because ties then resolve to whatever
     order they arrived in. */
  const catalog = readJson("data/catalog-client.json");
  const baseline = SearchEngine.searchShows("the", catalog.shows).map((s) => s.show_id);
  assert.ok(baseline.length > 10, "fixture assumption: \"the\" matches a useful number of curated titles");
  for (let i = 0; i < 20; i++) {
    assert.deepStrictEqual(SearchEngine.searchShows("the", catalog.shows).map((s) => s.show_id), baseline);
  }
  /* A deterministic PERMUTATION of the same rows (no Math.random — this
     repo's own rule): reversed, which is the cheapest order that shares no
     adjacent pair with the original. Same set in, same list out. */
  assert.deepStrictEqual(
    SearchEngine.searchShows("the", catalog.shows.slice().reverse()).map((s) => s.show_id), baseline,
    "the ranking must not depend on the order rows arrive in"
  );
});

test("over the real catalogue, the returned order is non-decreasing in bucket", () => {
  /* The invariant stated against real data rather than a fixture: whatever the
     tie-breaks do inside a bucket, a bucket-3 result can never appear above a
     bucket-2 one. Checked over several real queries, each of which genuinely
     spans more than one bucket in the committed catalogue.

     MUTATION: reorder `compareShowMatches` to compare the tier before the
     bucket. A curated substring match then outranks a breadth prefix match and
     this goes red. */
  const catalog = readJson("data/catalog-client.json");
  for (const q of ["the", "daily", "science", "life", "show"]) {
    const results = SearchEngine.searchShows(q, catalog.shows);
    const buckets = results.map((s) => SearchEngine.showMatchBucket(s.title, q).bucket);
    for (let i = 1; i < buckets.length; i++) {
      assert.ok(buckets[i] >= buckets[i - 1],
        `"${q}": ${results[i].title} (bucket ${buckets[i]}) ranked below ${results[i - 1].title} (bucket ${buckets[i - 1]})`);
    }
  }
});

test("word boundaries are Unicode-aware, so a non-ASCII or punctuated title is bucketed honestly", () => {
  /* `\W` is ASCII-only and this catalogue is not — data/show-index.tsv carries
     titles like "伊藤洋一のRound Up World Now！" and "99% Invisible". An
     ASCII-only word-break class calls every CJK character a separator, which
     would file a mid-word CJK substring as a word start.

     MUTATION: change SHOW_WORD_BREAK from /[^\p{L}\p{N}]/u to /\W/. BOTH CJK
     assertions below flip to WORD_START, because `\W` calls every CJK
     character a separator, and this fails twice over. */
  const B = SearchEngine;
  assert.strictEqual(B.showMatchBucket("99% Invisible", "invisible").bucket, B.SHOW_MATCH_WORD_START,
    "a match after \"% \" is a word start");
  assert.strictEqual(B.showMatchBucket("伊藤洋一のRound Up World Now！", "up").bucket, B.SHOW_MATCH_WORD_START,
    "a match after a space is a word start, in any script");
  assert.strictEqual(B.showMatchBucket("伊藤洋一のRound Up World Now！", "round").bucket, B.SHOW_MATCH_SUBSTRING,
    "\"Round\" here follows の, which is a LETTER — no break, so this is a substring, not a word start");
  assert.strictEqual(B.showMatchBucket("伊藤洋一のRound Up World Now！", "洋一").bucket, B.SHOW_MATCH_SUBSTRING,
    "a CJK run inside a CJK word is NOT a word start — \\W would wrongly say it is");
  assert.strictEqual(B.showMatchBucket("Lex Fridman Podcast", "zzz").bucket, B.SHOW_MATCH_NONE);
});

test("tools/test-search.mjs's topic scorer is untouched: searchShows shares no state with it", () => {
  /* S-04's scope boundary, restated as a test rather than only as a promise in
     the PR. `interpretQuery`/`scoreMatch`/`searchWithRelaxation` answer a
     different question, `searchShows`'s own header says so, and
     `tools/test-search.mjs` is a DENIED path this card must not edit.

     MUTATION: route `searchShows` through `SearchEngine.tokenize()` (the
     obvious "reuse" a future reader will propose). "On Being" loses its "on",
     and the exact-bucket assertion below fails. */
  const shows = [curated("On Being"), curated("The Daily")];
  assert.strictEqual(
    SearchEngine.showMatchBucket("On Being", "on being").bucket,
    SearchEngine.SHOW_MATCH_EXACT
  );
  assert.deepStrictEqual(
    SearchEngine.searchShows("the daily", shows).map((s) => s.title), ["The Daily"]
  );
  const discover = readJson("data/discover.json");
  const ctx = { semantic: readJson("data/semantic-index.json"), itemTags: readJson("data/item-tags.json"), discover };
  const interp = SearchEngine.interpretQuery("meditation", ctx);
  assert.ok(interp.groups.length > 0, "the topic scorer must still interpret a real query");
});

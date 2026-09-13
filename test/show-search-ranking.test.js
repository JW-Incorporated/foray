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

     THE MID-WORD ROW WAS "Ricochet Showcase" AND IT WAS NOT A MID-WORD ROW
     (found 2026-09-12 while mirroring this rule into
     backend/src/catalog/searchBreadthShows.ts, whose copy of this fixture went
     red where this one was green). "Showcase" follows a SPACE, so it buckets
     WORD_START exactly like "Casual Show Talk" — the two tied, the
     alphabetical tie-break ordered them C-before-R, and the assertion below
     passed with or without the bucket it exists to pin. The named mutation did
     not kill it. "Roadshow" follows "d", a letter and therefore no word break,
     so it is a genuine plain substring, and the explicit bucket assertions
     below say which row is which rather than leaving it to a comment.

     MUTATION: delete the word-start branch from `showMatchBucket` (return the
     substring bucket instead). "Casual Show Talk" and "Antiques Roadshow
     Detours" then land in the same bucket, the title tie-break puts
     "Antiques…" first, and the four-way ordering below fails. */
  const shows = [
    breadth("Antiques Roadshow Detours", 5),  // substring, genuinely mid-word
    breadth("Casual Show Talk", 5),           // word-start
    breadth("Show Me The Numbers", 5),        // prefix
    breadth("Show", 5),                       // exact
  ];
  const got = SearchEngine.searchShows("show", shows).map((s) => s.title);
  assert.deepStrictEqual(got, [
    "Show", "Show Me The Numbers", "Casual Show Talk", "Antiques Roadshow Detours",
  ]);
  assert.strictEqual(SearchEngine.showMatchBucket("Casual Show Talk", "show").bucket,
    SearchEngine.SHOW_MATCH_WORD_START);
  assert.strictEqual(SearchEngine.showMatchBucket("Antiques Roadshow Detours", "show").bucket,
    SearchEngine.SHOW_MATCH_SUBSTRING);
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
test("the server's bucket table is THIS file's bucket table, constant for constant", () => {
  /* THE PIN THE OLD HEADER ASKED A HUMAN FOR.
     `backend/src/catalog/searchBreadthShows.ts` reimplements this rule over the
     ~19,904-row merged catalogue, and its header used to end: "if the rule ever
     needs a fourth rank bucket, update both call sites (this file's header
     names the twin)." S-04 then added `SHOW_MATCH_WORD_START` here and not
     there, and nothing noticed for as long as it took a client audit to read
     both files. The endpoint TRUNCATES to `limit` before this file ever sees
     the list, so a divergence there is not cosmetic: the rows it cut are gone.

     So the discipline is mechanical now. Both files declare the bucket table as
     plain `const NAME = <integer>;` lines and this reads both and compares
     them. A fifth bucket that lands on one side only is a red suite here, on
     the very first run, with no reviewer required to notice.

     `SHOW_MATCH_UNMATCHED` is correctly absent from the server's table and is
     excluded by construction rather than by an exception list: it is declared
     here as `SHOW_MATCH_SUBSTRING + 1` — an expression, not an integer literal
     — because it is the bucket for a row a SERVER chose that matched no title,
     which only `rankShows` can produce. The server filters `SHOW_MATCH_NONE`
     out and never emits one. The assertion below states that too, so this
     exclusion cannot quietly become "the pin stopped seeing a constant".

     MUTATION: add a fifth bucket (or renumber one) in either file alone —
     e.g. change `SHOW_MATCH_SUBSTRING` to 4 in searchBreadthShows.ts. The
     deepStrictEqual fails naming the constant that differs. */
  const DECLARATION = /^(?:export )?const (SHOW_MATCH_[A-Z_]+) = (-?\d+);$/gm;
  const tableOf = (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const table = {};
    for (const m of src.matchAll(DECLARATION)) table[m[1]] = Number(m[2]);
    return table;
  };

  const client = tableOf("search-engine.js");
  const server = tableOf("backend/src/catalog/searchBreadthShows.ts");

  assert.deepStrictEqual(server, client,
    "the two bucket tables must be identical — a bucket added on one side only is this suite's whole reason for existing");
  assert.deepStrictEqual(client, {
    SHOW_MATCH_EXACT: 0, SHOW_MATCH_PREFIX: 1, SHOW_MATCH_WORD_START: 2,
    SHOW_MATCH_SUBSTRING: 3, SHOW_MATCH_NONE: -1,
  }, "and they must still be the four buckets plus NONE this suite documents");

  /* The parse is of live code, not of dead text: every constant it found is
     the value the module actually exports. */
  for (const [name, value] of Object.entries(client)) {
    assert.strictEqual(SearchEngine[name], value, `${name} is exported with a different value than it is declared with`);
  }

  /* UNMATCHED is client-only, and it is an expression rather than a literal —
     which is exactly why the parse above does not see it. */
  assert.strictEqual(SearchEngine.SHOW_MATCH_UNMATCHED, SearchEngine.SHOW_MATCH_SUBSTRING + 1);
  assert.ok(!("SHOW_MATCH_UNMATCHED" in server), "the server never emits an unmatched row, so it must not declare that bucket");

  /* The word-break class is half the word-start bucket's meaning, so it is
     pinned character for character too: an ASCII-only `\W` on one side would
     bucket every CJK title differently while the integers above still agreed.
     MUTATION: change either file's SHOW_WORD_BREAK literal. */
  const wordBreak = (rel) => {
    const m = fs.readFileSync(path.join(ROOT, rel), "utf8").match(/const SHOW_WORD_BREAK = (\/.+?\/u);/);
    assert.ok(m, `${rel} must declare SHOW_WORD_BREAK as a regex literal`);
    return m[1];
  };
  assert.strictEqual(
    wordBreak("backend/src/catalog/searchBreadthShows.ts"),
    wordBreak("search-engine.js"),
    "both sides must split words the same way, or the word-start bucket means two different things"
  );
});

/* ---------- P-03b: the author is NOT a ranking signal (2026-09-12) ----------

   These two are a REFUSAL PINNED AS A TEST, which is unusual enough to say why.
   `docs/search-parity-plan.md` P-03 asks for an author bucket ranked just below
   a title hit of the same strength. It was built and measured against the live
   directory over 20 host-name queries (see that card's amended text and
   `rankShows`'s header in search-engine.js) and it made the answer worse on
   every summary statistic. The next agent to read the card will have the same
   good idea, so the measurement has to be enforceable and not merely written
   down: both fixtures below are the REAL Apple strings that produced the
   regression, so a re-implementation cannot pass by being "smarter about noise".

   MUTATION FOR BOTH: in `rankShows`, fall back to
   `showMatchBucket(show.artist_name, q)` when the title does not match, and
   bucket it above `SHOW_MATCH_UNMATCHED`. Both go red. */

test("a row matched only on artist_name is NOT promoted above a title match", () => {
  /* The measured `tim ferriss` case. All three of Tim Ferriss's AUDIOBOOKS
     carry artist "Tim Ferriss" exactly, so an author-exact bucket (0) outranks
     *The Tim Ferriss Show*'s title word-start bucket (2) and the listener's
     show falls from 3rd to 6th. An exact author hit is routinely the wrong
     artefact by the right person, which is the whole objection. */
  const apple = (title, artist_name) => ({ show_id: title, title, artist_name, tier: "breadth", source: "apple" });
  const got = SearchEngine.rankShows("tim ferriss", [
    apple("CØCKPUNCH", "Tim Ferriss"),
    apple("Tools of Titans", "Tim Ferriss"),
    apple("The Tim Ferriss Show", "Tim Ferriss: Bestselling Author, Human Guinea Pig"),
  ]).map((s) => s.title);

  assert.strictEqual(got[0], "The Tim Ferriss Show",
    "the show whose TITLE matches must come first; an author-only row may never outrank it");
  assert.deepStrictEqual(got.slice(1), ["CØCKPUNCH", "Tools of Titans"],
    "the author-only rows stay unmatched, and unmatched rows keep the order the directory sent them in");
});

test("a noisy artist_name cannot displace the show the listener meant", () => {
  /* The measured `andrew huberman` case, and the reason the field cannot be
     trusted even when it does match. Apple's artist string is SEO-stuffed on
     the long tail: three unrelated shows list "Andrew Huberman" in theirs,
     while *Huberman Lab* itself is published by "Scicomm Media" and so never
     matches at all. Bucketing the author promotes all three above it — the
     field the listener is searching by is not the field we would be searching.

     THE LIST IS IN APPLE'S ORDER, WHICH IS THE POINT: every row here is
     unmatched by title, so this pins that `rankShows` leaves the directory's
     own ranking alone rather than substituting one built on `artist_name`. */
  const apple = (title, artist_name) => ({ show_id: title, title, artist_name, tier: "breadth", source: "apple" });
  const asAppleSentThem = [
    apple("Huberman Lab", "Scicomm Media"),
    apple("High Capacity", "Michelle Grosser – Inspired by Andrew Huberman"),
    apple("The Unapologetic Entrepreneur", "Hosted By: Amanda McKinney | Andrew Huberman"),
    apple("Accountable", "Hosted By: Amanda McKinney | Andrew Huberman"),
  ];
  assert.deepStrictEqual(
    SearchEngine.rankShows("andrew huberman", asAppleSentThem).map((s) => s.title),
    asAppleSentThem.map((s) => s.title),
    "no row matches by title, so the directory's order must survive the merge untouched"
  );
});

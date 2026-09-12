/* S-03 (docs/search-plan.md): the client half of the show index —
 * `search-engine.js`'s `parseShowIndex` / `prefixSearchShows` /
 * `scanShowIndex`, read against the REAL committed `data/show-index.tsv`.
 *
 * WHY A PROPERTY TEST OVER THE REAL FILE AND NOT A FIXTURE
 * The card asks for exactly that, and the reason is the failure mode: a binary
 * search over a mis-sorted array does not throw, it returns a plausible slice
 * of the wrong part of the file. A fixture with six rows would be sorted
 * correctly by accident. So the prefix pass is compared, for the whole 12-query
 * probe battery, against a REFERENCE LINEAR FILTER over the same 10,113 real
 * rows — the one implementation that cannot be wrong about which titles start
 * with a string.
 *
 * THE BUDGET IS ASSERTED GZIPPED, NOT RAW. S-03's acceptance line is <= 400 KB
 * gzipped, because gzip is what the browser actually downloads (both Vercel and
 * GitHub Pages negotiate it, and brotli, on static assets). A raw-byte
 * assertion would be a different, looser claim wearing the same number.
 *
 * Every test names the mutation that kills it.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const SearchEngine = require(path.join(ROOT, "search-engine.js"));

const INDEX_PATH = path.join(ROOT, "data", "show-index.tsv");
const RAW = fs.readFileSync(INDEX_PATH);
const TEXT = RAW.toString("utf8");
const INDEX = SearchEngine.parseShowIndex(TEXT);

/* Verbatim from tools/search-probe.mjs's S-01 battery, so the acceptance
   numbers and the correctness proof are stated over the same queries. */
const QUERY_BATTERY = [
  "l", "le", "lex", "lex f", "sci", "science f", "hist", "the daily",
  "radiolab", "99%", "zzqx", "伊藤洋一のRound Up World Now！",
];

/** The reference implementation. Deliberately the dumbest possible one. */
function referencePrefix(query) {
  const q = String(query).trim().toLowerCase();
  if (!q) return [];
  return INDEX.rows.filter((r) => r.title.toLowerCase().startsWith(q));
}

test("the committed index decodes to a usable index rather than an empty one", () => {
  /* The floor everything else here stands on. An empty parse is the silent
     failure this whole file is about: every prefix query would return nothing
     and every assertion about ordering would pass vacuously.

     MUTATION: make `parseShowIndex` require 5 columns. Every row is skipped,
     `rows.length` is 0, and this is the test that says so out loud. */
  assert.ok(INDEX.rows.length > 5000, `expected a real index, got ${INDEX.rows.length} rows`);
  assert.strictEqual(INDEX.rows.length, INDEX.keys.length, "keys and rows must stay index-aligned");
  assert.strictEqual(INDEX.rows.length, TEXT.split("\n").filter(Boolean).length,
    "every committed line must decode — a skipped row means the file and the parser disagree");
});

test("the emitted file is sorted by lowercased title in code-unit order", () => {
  /* THE CONTRACT. `prefixSearchShows` binary-searches with `<`; if the file is
     not in that order the search is meaningless.

     MUTATION (the one S-03's card names): unsort the emitted file — e.g. sort
     `mergeShowIndexRows` with `localeCompare`, or reverse the array before
     writing. This goes red here, and the parity test below goes red too,
     which is the point of having both: one says the file is wrong, the other
     says the answers are wrong. */
  for (let i = 1; i < INDEX.keys.length; i++) {
    assert.ok(INDEX.keys[i - 1] <= INDEX.keys[i],
      `row ${i} is out of order: ${JSON.stringify(INDEX.keys[i - 1])} > ${JSON.stringify(INDEX.keys[i])}`);
  }
});

test("prefixSearchShows agrees with a reference linear filter on all 12 probe queries", () => {
  /* The property test, over the real committed index. Compares SETS of ids
     (the reference filter has no ranking), so this is purely a claim about
     WHICH rows the binary search finds — the ORDER is show-search-ranking's
     subject, and conflating the two would make this test fail for the wrong
     reason the next time a tie-break changes.

     MUTATION: drop the `+ "￿"` upper sentinel and use `lo + 1` as the
     upper bound. Every multi-hit query returns one row and this goes red. */
  for (const q of QUERY_BATTERY) {
    const got = SearchEngine.prefixSearchShows(q, INDEX).map((s) => s.show_id).sort();
    const want = referencePrefix(q).map((r) => r.show_id).sort();
    assert.deepStrictEqual(got, want, `prefix disagreement on ${JSON.stringify(q)}`);
  }
});

test("the prefix pass also agrees on accented and non-ASCII prefixes, where locale order would differ", () => {
  /* The case a 6-row fixture cannot produce and `localeCompare` gets wrong:
     "ä" sorts after "z" in code-unit order and with the a's in locale order.
     The real committed index contains such titles (measured: several).

     MUTATION: sort the builder with `localeCompare`. The binary search then
     looks for these rows in the wrong region of the file and returns [] while
     the reference filter still finds them. */
  const accented = INDEX.rows.filter((r) => /^[^\x00-\x7F]/.test(r.title));
  assert.ok(accented.length > 0, "fixture assumption: the committed index has non-ASCII-initial titles");
  for (const row of accented.slice(0, 25)) {
    const q = row.title.slice(0, 3);
    const got = SearchEngine.prefixSearchShows(q, INDEX).map((s) => s.show_id);
    assert.ok(got.includes(row.show_id), `${JSON.stringify(q)} did not find ${row.title}`);
  }
});

test("the committed index is under S-03's 400 KB gzipped budget", () => {
  /* Gzipped, because that is what ships. Level 9 to match the measurement in
     docs/search-plan.md §1.2 rather than to flatter the number — the default
     level would report a larger file and still pass, which is the wrong
     direction to be generous in.

     MUTATION: raise tools/build-show-index.mjs's BUILD_MAX_RANK to 200 and
     rebuild. The file goes to ~398 KB gzipped — still under, by 0.4 %, which
     is why the module header argues the cut on the NATIVE bundle's raw-byte
     budget as well. Raise it to 200 and add a harvest and this is red. */
  const gz = zlib.gzipSync(RAW, { level: 9 }).length;
  assert.ok(gz <= 400 * 1024, `data/show-index.tsv is ${(gz / 1024).toFixed(1)} KB gzipped, over the 400 KB budget`);
});

test("every index row carries an id in the shape backend/src/catalog/breadthCatalog.ts mints", () => {
  /* A tapped index result resolves through `#/show/:id` and
     `state.breadthShowCache`, both of which key on the id the ENDPOINT uses:
     the curated `show_id`, or `String(apple_collection_id)`. An id that does
     not match means a result that renders and then says "Show not found."

     MUTATION: emit `apple_collection_id` as a base-36 string (one of the
     shapes docs/search-plan.md §1.2 measured for size). Every breadth id stops
     matching the endpoint's and this goes red. */
  for (const row of INDEX.rows) {
    assert.ok(row.show_id.length > 0);
    if (row.tier === "breadth") {
      assert.ok(/^[0-9]+$/.test(row.show_id), `breadth id ${row.show_id} is not a decimal collection id`);
      assert.ok(row.chart_rank >= 1, `breadth row ${row.title} has no chart_rank`);
    } else {
      assert.strictEqual(row.chart_rank, null, `curated row ${row.title} should carry no chart_rank`);
    }
  }
});

test("scanShowIndex returns word-start and substring hits ONLY, so the caller never dedupes against the prefix pass", () => {
  /* The division of labour app.js depends on: the prefix pass runs on every
     keystroke, the scan runs on the debounce tick, and the two must not both
     claim the same rows or the merged list would double up.

     MUTATION: drop the `bucket === SHOW_MATCH_PREFIX` skip in `scanShowIndex`.
     "radiolab" then appears in both passes and the disjointness assertion
     below fails. */
  for (const q of ["radiolab", "daily", "science"]) {
    const prefix = new Set(SearchEngine.prefixSearchShows(q, INDEX).map((s) => s.show_id));
    const scanned = SearchEngine.scanShowIndex(q, INDEX);
    for (const s of scanned) {
      assert.ok(!prefix.has(s.show_id), `${s.title} came back from both passes for ${JSON.stringify(q)}`);
      const bucket = SearchEngine.showMatchBucket(s.title, q).bucket;
      assert.ok(bucket === SearchEngine.SHOW_MATCH_WORD_START || bucket === SearchEngine.SHOW_MATCH_SUBSTRING,
        `${s.title} is bucket ${bucket}, which the prefix pass already owns`);
    }
  }
});

test("the scan finds what the prefix pass cannot: a mid-title word the listener typed", () => {
  /* The reason the scan exists at all. "fridman" is not a prefix of anything;
     it is the second word of the show a listener means.

     MUTATION: make `scanShowIndex` call `startsWith` instead of `indexOf`. It
     returns nothing for every query and this goes red. */
  const hits = SearchEngine.scanShowIndex("fridman", INDEX).map((s) => s.title);
  assert.ok(hits.some((t) => /fridman/i.test(t)), `expected a Fridman show, got ${JSON.stringify(hits.slice(0, 5))}`);
  assert.deepStrictEqual(SearchEngine.prefixSearchShows("fridman", INDEX), [],
    "fixture assumption: no committed title STARTS with \"fridman\", which is what makes the scan necessary");
});

test("parseShowIndex skips a malformed row rather than throwing, and refuses to invent one", () => {
  /* A truncated download is a real state: the last line can arrive half
     written. Throwing would take the search box down; adopting a half-row
     would put a show with an empty id in the list, which renders as a link to
     `#/show/` and a not-found page.

     MUTATION: drop the `parts.length < 4` guard. The two-column row below
     decodes to a row with `chart_rank: null` and `tier: "breadth"` — a
     fabricated record — and the length assertion fails. */
  const parsed = SearchEngine.parseShowIndex(
    "Good Show\tgood-id\t\t1\n" +
    "Truncated Show\ttrunc-id\n" +
    "\tno-title\t5\t0\n" +
    "\n" +
    "Another Good\t42\t7\t0\n"
  );
  assert.deepStrictEqual(parsed.rows.map((r) => r.show_id), ["good-id", "42"]);
  assert.deepStrictEqual(parsed.keys, ["good show", "another good"]);
  assert.deepStrictEqual(SearchEngine.parseShowIndex("").rows, []);
  assert.deepStrictEqual(SearchEngine.parseShowIndex(null).rows, []);

  /* CRLF, and this one is the silent failure rather than the loud one.
     `.gitattributes` marks this file `-text` so git cannot hand a Windows
     checkout a CRLF copy — but if that guard were ever dropped, an unguarded
     parser would read the fourth column as "1\r", which never equals "1", and
     EVERY curated show in the index would rank as breadth-tier. Nothing would
     throw and nothing would look broken; the order would just be wrong.

     MUTATION: drop the `raw.endsWith("\r")` strip in `parseShowIndex`. The
     tier assertion below reads "breadth" and this goes red. */
  const crlf = SearchEngine.parseShowIndex("Good Show\tgood-id\t\t1\r\nAnother\t42\t7\t0\r\n");
  assert.deepStrictEqual(crlf.rows.map((r) => r.tier), ["curated", "breadth"]);
  assert.deepStrictEqual(crlf.rows.map((r) => r.chart_rank), [null, 7]);
});

test("an empty query returns nothing from either index pass, rather than the whole catalogue", () => {
  /* `"".indexOf("")` is 0 for every string, so an unguarded prefix pass would
     answer a query of nothing with 10,113 rows — and the keystroke path calls
     these on every character, including the one where the listener deleted
     the last letter.

     MUTATION: drop the `if (!q)` guard in `prefixSearchShows`. The first
     assertion returns every row and this fails. */
  assert.deepStrictEqual(SearchEngine.prefixSearchShows("", INDEX), []);
  assert.deepStrictEqual(SearchEngine.prefixSearchShows("   ", INDEX), []);
  assert.deepStrictEqual(SearchEngine.scanShowIndex("", INDEX), []);
  assert.deepStrictEqual(SearchEngine.prefixSearchShows("lex", null), []);
  assert.deepStrictEqual(SearchEngine.prefixSearchShows("lex", { keys: [], rows: [] }), []);
});

test("the prefix pass is fast enough to sit on a keystroke, measured against a linear scan in the same process", () => {
  /* S-03's acceptance number, stated as a RATIO rather than an absolute
     millisecond ceiling, and that choice is the point of this comment.

     An absolute ceiling here was tried and is flaky for a reason that has
     nothing to do with the code: a shared CI runner (and this repo's own
     sandbox, measured 2026-09-12) moves the same unchanged work by 3-20x
     between runs, and p95 over 240 samples is dominated by whichever GC pause
     lands inside them. A test that goes red because the machine was busy
     teaches the next reader to ignore it.

     So the claim is the one S-03 actually rests on: the prefix pass is
     MATERIALLY CHEAPER than the linear scan it replaced, measured side by side
     in the same process, over the same real 10,113-row index, in the same
     conditions. §1.3 measured the linear scan at 12.9-19.9 ms over 19,904
     titles and concluded it was over a 16 ms frame budget; that conclusion is
     what this test keeps true.

     The median IS asserted absolutely as well, loosely (5 ms), because a ratio
     alone would still pass if both passes became catastrophically slow.

     MUTATION: make `prefixSearchShows` filter linearly over `index.keys`
     instead of binary-searching. The two measurements converge, the ratio
     drops to ~1, and this goes red. */
  const reference = (q) => INDEX.rows.filter((r) => r.title.toLowerCase().startsWith(q));
  const time = (fn) => {
    const times = [];
    for (const q of QUERY_BATTERY) {
      for (let i = 0; i < 20; i++) {
        const start = process.hrtime.bigint();
        fn(String(q).trim().toLowerCase());
        times.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
    }
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], total: times.reduce((n, t) => n + t, 0) };
  };
  /* Warmed first, both of them, so the ratio is not a comparison between a
     cold JIT and a warm one. */
  time((q) => SearchEngine.prefixSearchShows(q, INDEX));
  time(reference);

  const prefix = time((q) => SearchEngine.prefixSearchShows(q, INDEX));
  const linear = time(reference);
  assert.ok(
    prefix.total * 3 < linear.total,
    `the prefix pass took ${prefix.total.toFixed(1)} ms over the battery and a linear filter took ` +
      `${linear.total.toFixed(1)} ms — binary search is supposed to be an order of magnitude cheaper, not comparable`
  );
  assert.ok(prefix.median < 5,
    `prefix pass median is ${prefix.median.toFixed(3)} ms over ${INDEX.rows.length} rows`);
});

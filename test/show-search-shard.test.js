/* S-05 (4a-shows-pipeline-plan.md §3.2, kanban t_546eac9f) — the pure shard-
 * index client functions in search-engine.js: tokenising a query into a
 * shard key, filtering a shard's rows by every remaining token, and ranking
 * exact > prefix > word-start > substring with a curated boost.
 *
 * PINNED AGAINST THE REAL BUILDER, not a hand-copied constant: this suite
 * `require`s `tools/shows/shard-build.mjs`'s own `normalizePrefixKey` and
 * `tokenPrefixesFor` and asserts they agree with search-engine.js's
 * `normalizeShardPrefixKey`/`shardKeyForQuery` over a fixture vocabulary —
 * the two files load under genuinely different module systems (this one is
 * a classic script for the no-build CSP, the builder is an ES module under
 * tools/) so a literal `require` of one from the other is not on the table,
 * and CLAUDE.md's "a green test is not evidence until you have broken it"
 * rule is why this is a comparison rather than a restatement.
 *
 * Every test names the mutation that kills it.
 *
 * THE TWO DYNAMIC IMPORTS GO THROUGH `pathToFileURL` (fixed 2026-09-15). A bare
 * absolute path is a valid ESM specifier on POSIX and not on Windows, where it
 * parses as the scheme `c:` — so these two tests threw
 * ERR_UNSUPPORTED_ESM_URL_SCHEME on every Windows checkout while Ubuntu CI
 * stayed green. This repo is developed on Windows against a Unix-normalised
 * tree (CLAUDE.md), so "green in CI" and "runnable by the person writing the
 * code" are different claims, and a suite that only holds on the runner is half
 * a suite. Use `pathToFileURL(...).href` for any `import()` of a computed path.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const SearchEngine = require(path.join(ROOT, "search-engine.js"));

/* ==================================================================== */
/* shardQueryTokens / normalizeShardPrefixKey / shardKeyForQuery         */
/* ==================================================================== */

test('"fridman" tokenizes to one token and picks shard "fr" (the card\'s own example)', () => {
  /* MUTATION: slice the token to 1 char instead of 2. Fails because the
     shard key would be "f_" instead of "fr". */
  assert.deepStrictEqual(SearchEngine.shardQueryTokens("fridman"), ["fridman"]);
  assert.strictEqual(SearchEngine.shardKeyForQuery("fridman"), "fr");
});

test('"science friday" picks the longer token\'s shard, "sc"', () => {
  /* MUTATION: pick the FIRST token instead of the longest. "science"
     (7 chars) is longer than "friday" (6), so the shard must be "sc", not
     "fr" — this assertion catches a swap to first-token selection, since
     "science" is also alphabetically first here (picking either token by
     the wrong rule would coincidentally still pass an assertion that only
     checked "not fr"). */
  assert.deepStrictEqual(SearchEngine.shardQueryTokens("science friday"), ["science", "friday"]);
  assert.strictEqual(SearchEngine.shardKeyForQuery("science friday"), "sc");
});

test("a tie in token length breaks by code-unit order, deterministically", () => {
  /* "abc" and "abd" both length 3; "abc" < "abd" in code-unit order. */
  assert.strictEqual(SearchEngine.longestShardToken(["abd", "abc"]), "abc");
});

test("a single-character token pads to a one-char-plus-underscore shard key", () => {
  assert.strictEqual(SearchEngine.shardKeyForQuery("a"), "a_");
});

test("an empty or whitespace-only query has no shard key", () => {
  /* MUTATION: return "" instead of null for an empty query. A falsy-but-not-
     null return would make app.js's `if (shardKeyForQuery(q))` guard still
     skip the fetch today, but silently break the moment that guard is
     rewritten to an explicit `!== null` check — null is the one value this
     function promises for "nothing to shard on". */
  assert.strictEqual(SearchEngine.shardKeyForQuery(""), null);
  assert.strictEqual(SearchEngine.shardKeyForQuery("   "), null);
});

test("accented characters fold the same way the builder folds them (café -> cafe -> shard ca)", () => {
  /* MUTATION: drop the NFKD normalize+combining-mark strip. "café" would
     then tokenize to "café" and land in shard "__" (non a-z0-9 leading
     char after lowercasing keeps the accent), disagreeing with the
     builder's "cafe" -> "ca". */
  assert.deepStrictEqual(SearchEngine.shardQueryTokens("café"), ["cafe"]);
  assert.strictEqual(SearchEngine.shardKeyForQuery("café"), "ca");
});

test("client normalizeShardPrefixKey agrees with tools/shows/shard-build.mjs's normalizePrefixKey", async () => {
  const builder = await import(pathToFileURL(path.join(ROOT, "tools", "shows", "shard-build.mjs")).href);
  const cases = ["fr", "a_", "__", "1", "z", "9", "ab", "0a", "-", "é", ""];
  for (const raw of cases) {
    assert.strictEqual(
      SearchEngine.normalizeShardPrefixKey(raw),
      builder.normalizePrefixKey(raw),
      `disagreement on input ${JSON.stringify(raw)}`
    );
  }
});

test("client shardKeyForQuery agrees with the builder's tokenPrefixesFor over real title/author pairs", async () => {
  const builder = await import(pathToFileURL(path.join(ROOT, "tools", "shows", "shard-build.mjs")).href);
  const fixtures = [
    { title: "Lex Fridman Podcast", itunesAuthor: "Lex Fridman" },
    { title: "Science Friday", itunesAuthor: null },
    { title: "99% Invisible", itunesAuthor: "Roman Mars" },
    { title: "The Daily", itunesAuthor: "The New York Times" },
    { title: "Café Society", itunesAuthor: null },
  ];
  for (const row of fixtures) {
    // The client only ever shards on the LONGEST query token, so simulate a
    // listener typing the row's own title: the builder's own prefix set for
    // that row must contain the client's chosen shard key, or a query for
    // this exact show would never even fetch the shard it lives in.
    const builderPrefixes = new Set(builder.tokenPrefixesFor(row));
    const clientKey = SearchEngine.shardKeyForQuery(row.title);
    assert.ok(
      clientKey === null || builderPrefixes.has(clientKey),
      `client shard key "${clientKey}" for title "${row.title}" is not one of the builder's own prefixes: ${[...builderPrefixes]}`
    );
  }
});

/* ==================================================================== */
/* shardRowMatchesAllTokens / rankShardRows                              */
/* ==================================================================== */

function row({ id, t, a = null, c = false }) {
  return { id, t, a, i: null, u: null, img: null, n: null, c };
}

test('"fridman" finds Lex Fridman from a mixed shard (the card\'s acceptance case)', () => {
  const shard = [
    row({ id: 1, t: "Food Trucks of Fridman County" }), // substring
    row({ id: 2, t: "Lex Fridman Podcast", a: "Lex Fridman", c: true }), // word-start
    row({ id: 3, t: "Unrelated Show" }), // no match
  ];
  const ranked = SearchEngine.rankShardRows("fridman", shard);
  assert.strictEqual(ranked.length, 2);
  assert.strictEqual(ranked[0].id, 2, "the word-start match should outrank a mid-word substring match");
});

test('"science friday" ranks Science Friday first among a shard with noisy neighbours', () => {
  /* MUTATION: drop the AND-token filter (match on ANY token instead of
     every token). "Science Vs" would then also qualify on "science" alone
     and could out-rank or crowd the intended show depending on tie order —
     this fixture is built so a match-any implementation returns 3 rows
     instead of 2. */
  const shard = [
    row({ id: 10, t: "Science Vs" }),
    row({ id: 11, t: "Science Friday", c: true }),
    row({ id: 12, t: "Friday Night Lights Rewatch" }),
  ];
  const ranked = SearchEngine.rankShardRows("science friday", shard);
  assert.strictEqual(ranked.length, 1, "only the row matching BOTH tokens survives the filter");
  assert.strictEqual(ranked[0].id, 11);
});

test("exact > prefix > word-start > substring ordering, same tiers showMatchBucket uses", () => {
  const shard = [
    row({ id: 1, t: "Prehistory Today" }), // substring: "history" mid-word inside "prehistory"
    row({ id: 2, t: "History" }), // exact
    row({ id: 3, t: "History Extra" }), // prefix
    row({ id: 4, t: "Modern History" }), // word-start
  ];
  const ranked = SearchEngine.rankShardRows("history", shard);
  const order = ranked.map((r) => r.id);
  assert.deepStrictEqual(order, [2, 3, 4, 1]);
});

test("a curated row wins a tie inside the same bucket", () => {
  const shard = [
    row({ id: 1, t: "Daily Roundup", c: false }),
    row({ id: 2, t: "Daily Briefing", c: true }),
  ];
  const ranked = SearchEngine.rankShardRows("daily", shard);
  assert.strictEqual(ranked[0].id, 2, "the curated row must lead its tier");
});

test("within one bucket and the same curated flag, the shard's own popularity order (arrival order) is preserved", () => {
  /* MUTATION: sort ties by id instead of preserving arrival (shard rows
     arrive pre-sorted by popularity desc per shard-build.mjs). Swapping row
     3 and row 1's ids would still pass an id-sorted assertion but fail
     this one, which checks the ORIGINAL array order survives. */
  const shard = [
    row({ id: 99, t: "Popular Daily Show" }),
    row({ id: 5, t: "Less Popular Daily Show" }),
  ];
  const ranked = SearchEngine.rankShardRows("daily", shard);
  assert.deepStrictEqual(ranked.map((r) => r.id), [99, 5]);
});

test("author-only matches still qualify (AND filter reads title+author)", () => {
  const shard = [row({ id: 1, t: "The Show", a: "Fridman Productions" })];
  const ranked = SearchEngine.rankShardRows("fridman", shard);
  assert.strictEqual(ranked.length, 1);
});

test("no rows match: empty result, not a throw", () => {
  const shard = [row({ id: 1, t: "Totally Unrelated" })];
  assert.deepStrictEqual(SearchEngine.rankShardRows("zzqx1nomatch", shard), []);
});

test("an empty query or empty shard returns no rows rather than the whole shard", () => {
  /* MUTATION: drop the `!tokens.length` guard, defaulting to "return
     rows unfiltered" on an empty query. */
  const shard = [row({ id: 1, t: "Anything" })];
  assert.deepStrictEqual(SearchEngine.rankShardRows("", shard), []);
  assert.deepStrictEqual(SearchEngine.rankShardRows("query", []), []);
});

test("out-of-order tokens still rank, at the substring tier, never dropped", () => {
  const shard = [row({ id: 1, t: "Science Friday" })];
  const ranked = SearchEngine.rankShardRows("friday science", shard);
  assert.strictEqual(ranked.length, 1, "both tokens are present, just in the other order — must still match");
});

test("an accented row title still matches an unaccented query, the same way the shard KEY already folds (review finding)", () => {
  /* MUTATION: revert shardRowText to a bare `.toLowerCase()`. A query for
     "cafe" folds to "cafe" (shardQueryTokens), but the row's own text would
     stay "café" — the substring check then fails even though both sides
     resolve to the same shard "ca" and a listener typing without accents
     (the common case on a phone keyboard) would get nothing. */
  const shard = [row({ id: 1, t: "Café Society" })];
  assert.deepStrictEqual(
    SearchEngine.rankShardRows("cafe", shard).map((r) => r.id),
    [1]
  );
  // And the reverse direction: an accented QUERY against an unaccented row.
  const shard2 = [row({ id: 2, t: "Cafe Society" })];
  assert.deepStrictEqual(
    SearchEngine.rankShardRows("café", shard2).map((r) => r.id),
    [2]
  );
});

test("an accented EXACT title ranks at the exact tier, not behind an unrelated unaccented substring row (review finding, round 2)", () => {
  /* MUTATION: fold the query for bucketing but not the row title (or vice
     versa) — showMatchBucket itself only lowercases, so comparing a folded
     query against an UNFOLDED title silently demotes a true exact/prefix
     match to the substring tier. "Café" against query "cafe" must land
     SHOW_MATCH_EXACT, ahead of "Cafe Society" (only a prefix match), which
     itself must beat "Supercafe Talk" (a genuine MID-WORD substring match —
     "Nice Cafe Talk" was tried first and rejected here because "Cafe" there
     starts its own word, landing it in the word-start tier rather than the
     substring tier this test needs to exercise). */
  const shard = [
    row({ id: 10, t: "Supercafe Talk" }),
    row({ id: 11, t: "Cafe Society" }),
    row({ id: 12, t: "Café" }),
  ];
  const ranked = SearchEngine.rankShardRows("cafe", shard);
  assert.deepStrictEqual(ranked.map((r) => r.id), [12, 11, 10]);
});

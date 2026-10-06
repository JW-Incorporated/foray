/* search-engine.js's export object: who reads it (code-health CH-16, X1-12).
 *
 * WHY THIS EXISTS
 * The comments on `SearchEngine`'s export object used to say who read which
 * members, and they were wrong: they named app.js as a reader of the show
 * buckets it never touches and tools/build-show-index.mjs as comparing against
 * `showMatchBucket` (it reads only `foldDiacritics`), and two members —
 * `prettyConceptLabel` and `showIndexLowerBound` — were exported with no reader
 * anywhere outside the file. An agent refactoring the ranker reads an export
 * plus "app.js reads this" as UI contract and preserves it; a wrong comment
 * there costs a refactor, not a crash, which is why nothing caught it.
 *
 * So the page's real dependency on the engine is pinned here, from app.js's
 * side: every `SearchEngine.<name>` app.js names must be exported (a live
 * export cannot be removed), and must be in the reader list the export
 * comment gives (a new app.js reader cannot land with the comment still
 * claiming the old set). The two former orphans must stay private, and the
 * two callers that use them must keep working.
 *
 * Every test names the mutation that kills it. The floor for this suite lives
 * in test/suite-integrity.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SE = require(path.join(ROOT, "search-engine.js"));

/* Every `SearchEngine.x` / `SearchEngine?.x` app.js names, comments included:
   a comment that cites `SearchEngine.DEFAULT_CAP` is pointing a reader at the
   export, so it is held to the same rule as code that calls it. */
function appReaders() {
  const names = new Set();
  for (const m of APP_SRC.matchAll(/\bSearchEngine\??\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return [...names].sort();
}

/* The names the export comment attributes to app.js: every backticked
   identifier in the paragraph that opens "app.js (the page) reads", up to the
   next blank comment line. */
function commentAppReaders() {
  const start = ENGINE_SRC.indexOf("app.js (the page) reads");
  assert.ok(start >= 0, "search-engine.js's export comment has an \"app.js (the page) reads\" paragraph");
  const rest = ENGINE_SRC.slice(start);
  const end = rest.search(/\n\s*\n/);
  const para = end >= 0 ? rest.slice(0, end) : rest;
  const names = new Set();
  for (const m of para.matchAll(/`([A-Za-z_$][\w$]*)`/g)) names.add(m[1]);
  return [...names].sort();
}

test("every SearchEngine member app.js names is exported (live readers keep their export)", () => {
  /* Mutation: delete `classifyResults` (or any of app.js's readers) from the
     export object -> red. */
  const readers = appReaders();
  assert.ok(readers.length >= 14, `app.js names the engine's members (found ${readers.length})`);
  for (const name of ["classifyResults", "interpretQuery", "searchShows", "rankShardRows", "shardKeyForQuery"]) {
    assert.ok(readers.includes(name), `the scan sees app.js read ${name}`);
  }
  const missing = readers.filter((name) => !(name in SE));
  assert.deepStrictEqual(missing, [], "app.js names these SearchEngine members but search-engine.js does not export them");
});

test("the export comment's app.js reader list covers every member app.js names", () => {
  /* Mutation: drop `scanShowIndex` from the "app.js (the page) reads" paragraph
     (or have app.js start reading a member the paragraph does not list) -> red.
     And every name the paragraph lists is really exported: mutation, list a
     made-up `fooBar` in the paragraph -> red. */
  const listed = commentAppReaders();
  const unlisted = appReaders().filter((name) => !listed.includes(name));
  assert.deepStrictEqual(unlisted, [], "app.js reads these but the export comment does not name app.js as their reader");
  const notExported = listed.filter((name) => !(name in SE));
  assert.deepStrictEqual(notExported, [], "the export comment lists these as app.js readers but they are not exported");
});

test("prettyConceptLabel and showIndexLowerBound are private: no reader outside search-engine.js", () => {
  /* Mutation: put either name back on the export object -> red. */
  assert.ok(!("prettyConceptLabel" in SE), "prettyConceptLabel is not exported");
  assert.ok(!("showIndexLowerBound" in SE), "showIndexLowerBound is not exported");
  assert.ok(/\nfunction prettyConceptLabel\(/.test(ENGINE_SRC), "prettyConceptLabel still exists as suggestAdjacentTopics' helper");
  assert.ok(/\nfunction showIndexLowerBound\(/.test(ENGINE_SRC), "showIndexLowerBound still exists as prefixSearchShows' helper");
});

test("showIndexLowerBound still serves prefixSearchShows: the prefix range is exact", () => {
  /* Pins the one caller of the now-private showIndexLowerBound through the
     export that uses it. Mutation: make showIndexLowerBound return 0 (the
     range starts at "alpha hour") or keys.length (the range is empty) -> red. */
  const tsv = [
    ["Alpha Hour", "s1", "", "1"],
    ["Beta Talk", "s2", "", "1"],
    ["Better Off Dead", "s3", "", "0"],
    ["Gamma Rays", "s4", "", "1"],
  ].map((cols) => cols.join("\t")).join("\n");
  const index = SE.parseShowIndex(tsv);
  assert.deepStrictEqual(index.keys, ["alpha hour", "beta talk", "better off dead", "gamma rays"]);
  const ids = SE.prefixSearchShows("Be", index).map((row) => row.show_id);
  assert.deepStrictEqual([...ids].sort(), ["s2", "s3"], `prefix "Be" finds exactly Beta Talk and Better Off Dead (got ${JSON.stringify(ids)})`);
  assert.deepStrictEqual(SE.prefixSearchShows("gamma rays", index).map((row) => row.show_id), ["s4"], "an exact title is its own one-row range");
  assert.deepStrictEqual(SE.prefixSearchShows("zz", index), [], "a needle past the last key is an empty range");
});

test("prettyConceptLabel still serves suggestAdjacentTopics: a related concept id becomes a Title Case label", () => {
  /* Pins the one caller of the now-private prettyConceptLabel. Mutation: make
     prettyConceptLabel return the raw id -> the label reads "blues-music" -> red. */
  const ctx = {
    semantic: {
      concepts: {
        jazz: { terms: ["jazz"], related: ["blues-music", "polka_dance"] },
        "blues-music": { terms: ["blues"] },
        polka_dance: { terms: ["polka"] },
      },
    },
    itemTags: { tags: { e1: ["blues"], e2: ["blues", "polka"] } },
  };
  const out = SE.suggestAdjacentTopics({ groups: [{ token: "jazz" }] }, ctx);
  assert.deepStrictEqual(
    out.map(({ id, label }) => ({ id, label })),
    [{ id: "blues-music", label: "Blues Music" }, { id: "polka_dance", label: "Polka Dance" }],
  );
});

/* S-03 (docs/search-plan.md): tools/build-show-index.mjs, the build step that
 * projects data/catalog.json + data/catalog-breadth.json into
 * data/show-index.tsv.
 *
 * THE ONE THING THIS SUITE REALLY GUARDS is the sort order, and it is worth
 * saying why before the tests: `search-engine.js:prefixSearchShows` answers a
 * prefix query with two binary searches over this file's lowercased titles,
 * compared with `<`. If the builder ever sorted with `localeCompare` instead —
 * the obvious, friendlier-looking choice — the two would disagree on every
 * accented title and the disagreement would be SILENT: a prefix query would
 * return a slice of the wrong part of the file, not an error. So the order is
 * a contract between two files, and it is pinned here from the builder's side
 * and in test/show-index.test.js from the client's.
 *
 * Every test names the mutation that kills it.
 *
 * Harness: plain node:test over the module's exported pure functions, with the
 * real committed catalogues used only where the claim is about the real data.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_MAX_RANK, sanitizeCell, mergeShowIndexRows, formatShowIndex, buildShowIndex,
} from "./build-show-index.mjs";
import { rankByAppleId } from "./harvest-merge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const cur = (show_id, title) => ({ show_id, title });
const bre = (apple_collection_id, title, chart_rank, extra = {}) =>
  ({ apple_collection_id, title, chart_rank, ...extra });

test("rows are sorted by the FOLDED lowercased title in CODE-UNIT order, not locale order", () => {
  /* The contract with prefixSearchShows, which binary-searches the keys
     `parseShowIndex` builds with `foldDiacritics` (audit round 2, search-9).
     Two pairs, because two orders have to be told apart:

       "Ähnlich" and "middle": FOLDED code-unit order puts "ähnlich" with the
       a's (it folds to "ahnlich"); the UNFOLDED order this used to pin put it
       after "zebra" (U+00E4 > U+007A). This pair goes red under the old sort.
       "Zebra" and "🎙 Mic": code-unit order puts the emoji (U+D83C…) AFTER
       every letter; `localeCompare` puts symbols BEFORE letters. This pair
       goes red under a locale sort — the mutation the old fixture caught,
       which "Ähnlich" alone can no longer catch now that it folds.

     MUTATIONS: sort with `a.title.toLowerCase()` (unfolded) -> "Ähnlich" moves
     last, red; sort with `at.localeCompare(bt)` -> "🎙 Mic" moves first, red;
     and test/show-index.test.js's binary-search parity test goes red too. */
  const rows = mergeShowIndexRows(
    { shows: [cur("z", "Zebra Hour"), cur("a", "Ähnlich Podcast"), cur("m", "middle show"), cur("e", "🎙 Mic Podcast")] },
    { shows: [] }
  );
  assert.deepStrictEqual(rows.map((r) => r.title), ["Ähnlich Podcast", "middle show", "Zebra Hour", "🎙 Mic Podcast"]);
});

test("a breadth row marked in_curated is dropped, and a curated id always wins a collision", () => {
  /* Restates backend/src/catalog/breadthCatalog.ts's own dedupe rule on this
     side of the pipeline: the curated record carries the editorial note and
     the taxonomy, so keeping both would list one show twice with the poorer
     copy sometimes winning the ranking.

     MUTATION: drop the `if (show?.in_curated) continue;` line. The row count
     below becomes 3 and this fails. */
  const rows = mergeShowIndexRows(
    { shows: [cur("lex-fridman-podcast", "Lex Fridman Podcast")] },
    { shows: [
      bre(1434243584, "Lex Fridman Podcast", 2, { in_curated: true }),
      bre(999, "Something Else", 5),
    ] }
  );
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map((r) => r.id).sort(), ["999", "lex-fridman-podcast"]);
  assert.strictEqual(rows.find((r) => r.id === "lex-fridman-podcast").curated, true);
});

test("a curated row carries its breadth twin's chart_rank joined on apple_collection_id, and null without a twin", () => {
  /* P-09 data half (PKG-11a, docs/roadmap/shows-search.md). The twin is the
     `in_curated: true` breadth row the breadth loop SKIPS, so the join has to
     read every breadth row, not only the ones that ship as breadth. A curated
     show with no twin keeps the empty column. The curated `apple_collection_id`
     is a number in catalog.json and the twin's is too, but the Map is keyed by
     `String(...)`, so a string-typed id on one side still joins — pinned by
     the mixed types below. Ranking is unchanged: `popularityBand` returns 0
     for every curated row until PKG-13.

     MUTATION: replace `rankOf.get(String(show?.apple_collection_id)) ?? null`
     with `null` (drop the Map lookup). "Twinned Show" reads null and this goes
     red. */
  const rows = mergeShowIndexRows(
    { shows: [
      { show_id: "twinned-show", title: "Twinned Show", apple_collection_id: 555 },
      { show_id: "lonely-show", title: "Lonely Show", apple_collection_id: 777 },
    ] },
    { shows: [bre("555", "Twinned Show", 14, { in_curated: true })] }
  );
  assert.strictEqual(rows.find((r) => r.id === "twinned-show").chart_rank, 14);
  assert.strictEqual(rows.find((r) => r.id === "lonely-show").chart_rank, null);
  assert.ok(!rows.some((r) => r.id === "555"), "the twin itself still does not ship as a breadth row");
});

test("CH2-15: the curated chart_rank join over null, 0, \"12\", NaN, -1 and a ranked twin keeps only \"12\" and the ranked twin", () => {
  /* T1-13 (docs/roadmap/code-health-2.md): "a usable chart rank" is ONE join,
     tools/harvest-merge.mjs's rankByAppleId, shared with
     tools/build-catalog-client.mjs. The same six-row fixture is pinned in
     tools/harvest-merge.test.mjs (the helper) and
     tools/build-catalog-client.test.mjs (the other builder), so the TSV and
     the client JSON cannot disagree about which rank is usable. Every twin is
     `in_curated: true`, so only the curated rows ship and their chart_rank
     column IS the join's output.

     MUTATION: in harvest-merge.mjs's isChartRank, `Number(raw) > 0` ->
     `Number(raw) >= 0`. The 0 twin maps to 0 and this fails.
     MUTATION: build the curated rank from the raw `row.chart_rank` instead of
     rankByAppleId. "12" ships as a string, null/NaN/-1/0 ship as values, and
     this fails. */
  const ids = [101, 102, 103, 104, 105, 106];
  const breadth = { shows: [
    bre(101, "T101", null, { in_curated: true }),
    bre(102, "T102", 0, { in_curated: true }),
    bre(103, "T103", "12", { in_curated: true }),
    bre(104, "T104", NaN, { in_curated: true }),
    bre(105, "T105", -1, { in_curated: true }),
    bre(106, "T106", 7, { in_curated: true }),
  ] };
  const curated = { shows: [...ids, 107].map((id) => ({ show_id: `s${id}`, title: `S${id}`, apple_collection_id: id })) };
  const rows = mergeShowIndexRows(curated, breadth);
  const ranked = Object.fromEntries(rows.filter((r) => r.chart_rank !== null).map((r) => [r.id, r.chart_rank]));
  assert.deepStrictEqual(ranked, { s103: 12, s106: 7 });
  assert.strictEqual(rows.length, 7, "every curated row ships, ranked or not; no twin ships as breadth");
  const shared = rankByAppleId(breadth);
  for (const r of rows) {
    assert.strictEqual(r.chart_rank, shared.get(r.id.slice(1)) ?? null, `${r.id}: the builder's rank is the shared join's`);
  }
});

test("the cut drops breadth rows ranked worse than max-rank, and never drops a curated row", () => {
  /* The committed cut is BUILD_MAX_RANK — see the module header for the
     measurement that chose it. Curated rows must survive the cut regardless —
     including a curated row whose breadth twin's chart_rank (PKG-11a) is
     outside it.

     The keeper's twin (apple_collection_id 3, `in_curated`) ranks
     BUILD_MAX_RANK + 1, one outside the cut, so this fixture catches the cut
     leaking into the curated loop by EITHER route, without leaning on the
     real-data tests below:

     MUTATIONS: (a) apply the rank filter before the `in_curated`/curated split
     (or to the curated loop as well) on the catalogue row's own `chart_rank`.
     catalog.json rows carry no `chart_rank` field, so the keeper reads NaN, is
     dropped, and the first assertion fails. (b) the PKG-11a version: add
     `if ((rankByAppleId.get(String(show?.apple_collection_id)) ?? 0) > maxRank) continue;`
     to the curated loop. The keeper's joined rank is BUILD_MAX_RANK + 1, so it
     is dropped and the first assertion fails. */
  const rows = mergeShowIndexRows(
    { shows: [{ show_id: "keeper", title: "Curated Keeper", apple_collection_id: 3 }] },
    { shows: [
      bre(1, "Inside Cut", 5),
      bre(2, "Outside Cut", BUILD_MAX_RANK + 1),
      bre(3, "Curated Keeper", BUILD_MAX_RANK + 1, { in_curated: true }),
    ] },
    { maxRank: BUILD_MAX_RANK }
  );
  const keeper = rows.find((r) => r.id === "keeper");
  assert.ok(keeper, "a curated row whose twin ranks outside the cut must still survive it");
  assert.strictEqual(keeper.chart_rank, BUILD_MAX_RANK + 1, "and it keeps the twin's uncut rank");
  assert.ok(rows.some((r) => r.id === "1"));
  assert.ok(!rows.some((r) => r.id === "2"));
});

test("a breadth row with no usable chart_rank is dropped rather than guessed at", () => {
  /* Since 2026-10-07 a null chart_rank is normal: a show that left every
     chart is kept by the re-harvest merge (tools/harvest-merge.mjs) with
     `chart_rank: null`. It is past the cut by definition, so the client index
     leaves it out rather than invent a band for it (search-engine.js's
     `popularityBand` would file it last anyway); the server search still
     serves it.

     MUTATION: treat a non-finite rank as 0 and keep the row. The length
     assertion goes to 3 and this fails. */
  const rows = mergeShowIndexRows({ shows: [] }, { shows: [
    bre(1, "Has Rank", 7), bre(2, "No Rank", null), bre(3, "Bad Rank", "not a number"),
  ] });
  assert.deepStrictEqual(rows.map((r) => r.id), ["1"]);
});

test("sanitizeCell strips the characters that would break the row format", () => {
  /* A tab inside a title would add a phantom column; a newline would add a
     phantom row; both would be read back by `parseShowIndex` as a corrupt
     record, silently.

     MUTATION: change the replacement to the empty string. "A\tB" would then
     read "AB" rather than "A B" and the first assertion fails — worth pinning
     because the collapse is what keeps a title readable rather than merely
     parseable. */
  assert.strictEqual(sanitizeCell("A\tB"), "A B");
  assert.strictEqual(sanitizeCell("Two\nLines"), "Two Lines");
  assert.strictEqual(sanitizeCell("  padded  "), "padded");
  assert.strictEqual(sanitizeCell(1434243584), "1434243584");
  assert.strictEqual(sanitizeCell(null), "");
});

test("the emitted row is exactly four tab-separated columns, in the documented order", () => {
  /* THE FIELD LIST IS THE CONTRACT search-engine.js:parseShowIndex reads
     against. A reordered column is not a parse error — it is a file where
     every id is a rank and every rank is a flag, read back without complaint.

     MUTATION: swap the id and chart_rank columns. parseShowIndex then builds
     rows whose show_id is a number-as-string from the wrong field, and
     test/show-index.test.js's id-shape test goes red too. */
  const text = formatShowIndex(mergeShowIndexRows(
    { shows: [cur("curated-one", "Curated One")] },
    { shows: [bre(42, "Breadth One", 9)] }
  ));
  const lines = text.split("\n").filter(Boolean);
  assert.deepStrictEqual(lines, [
    "Breadth One\t42\t9\t0",
    "Curated One\tcurated-one\t\t1",
  ]);
  assert.ok(text.endsWith("\n"), "the file ends with exactly one newline");
});

test("a catalogue that did not parse to { shows: [...] } is refused, not written as an empty derivation", () => {
  /* tools/build-catalog-client.mjs's rule, restated here because the failure
     shape is the same and it is the bad one: an empty index would silently
     replace the search with nothing and every build would stay green.

     MUTATION: replace the two guards with `catalog?.shows ?? []`. Both throws
     below stop happening and this fails. */
  assert.throws(() => mergeShowIndexRows(null, { shows: [] }), /catalog\.json/);
  assert.throws(() => mergeShowIndexRows({ shows: [] }, {}), /catalog-breadth\.json/);
});

test("the committed data/show-index.tsv is exactly what this script produces from the committed catalogues", () => {
  /* The `--check` contract, asserted directly so a stale index is caught by
     the same suite run that would otherwise trust it. This is the test that
     turns "someone edited catalog.json" into a red build rather than a search
     index quietly describing last month's catalogue.

     MUTATION: hand-edit one line of data/show-index.tsv. Red. */
  const expected = buildShowIndex(readJson("data/catalog.json"), readJson("data/catalog-breadth.json"));
  const onDisk = fs.readFileSync(path.join(ROOT, "data", "show-index.tsv"), "utf8");
  assert.strictEqual(onDisk, expected,
    "data/show-index.tsv is stale — run: node tools/build-show-index.mjs");
});

test("the committed index carries every curated show and only in-cut breadth shows", () => {
  /* Against the real committed data, because the claim is about what actually
     ships: the curated 220 are the fallback the client already has, so losing
     one from the index would be a silent product regression the shape tests
     above cannot see.

     MUTATION: raise BUILD_MAX_RANK without rebuilding. The breadth-rank
     assertion still passes (the file is unchanged) but the parity test above
     goes red, which is the pair working as intended. */
  const curated = readJson("data/catalog.json");
  const rows = mergeShowIndexRows(curated, readJson("data/catalog-breadth.json"));
  const curatedRows = rows.filter((r) => r.curated);
  assert.strictEqual(curatedRows.length, curated.shows.length,
    "every curated show must be in the index");
  for (const r of rows) {
    /* A curated row's rank is its breadth twin's (PKG-11a) — Apple's 1-200,
       never cut — or null without a twin. */
    if (r.curated) assert.ok(r.chart_rank === null || (r.chart_rank >= 1 && r.chart_rank <= 200), `${r.title} has a rank outside 1-200`);
    else assert.ok(r.chart_rank >= 1 && r.chart_rank <= BUILD_MAX_RANK, `${r.title} is out of cut`);
  }
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, "ids are unique");
});

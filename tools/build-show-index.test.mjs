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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const cur = (show_id, title) => ({ show_id, title });
const bre = (apple_collection_id, title, chart_rank, extra = {}) =>
  ({ apple_collection_id, title, chart_rank, ...extra });

test("rows are sorted by lowercased title in CODE-UNIT order, not locale order", () => {
  /* The contract with prefixSearchShows. "Zebra" and "Ähnlich" are the pair
     that separates the two orders: code-unit puts "ähnlich" (U+00E4) AFTER
     "zebra" (U+007A); `localeCompare` puts it with the a's, before it.

     MUTATION (the one that matters): sort with
     `at.localeCompare(bt)` in mergeShowIndexRows. This goes red immediately,
     and test/show-index.test.js's binary-search parity test goes red too. */
  const rows = mergeShowIndexRows(
    { shows: [cur("z", "Zebra Hour"), cur("a", "Ähnlich Podcast"), cur("m", "middle show")] },
    { shows: [] }
  );
  assert.deepStrictEqual(rows.map((r) => r.title), ["middle show", "Zebra Hour", "Ähnlich Podcast"]);
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

test("the cut drops breadth rows ranked worse than max-rank, and never drops a curated row", () => {
  /* The committed cut is BUILD_MAX_RANK — see the module header for the
     measurement that chose it. Curated rows carry no chart_rank at all and
     must survive the cut regardless.

     MUTATION: apply the rank filter before the `in_curated`/curated split (or
     to the curated loop as well). Every curated row has `chart_rank`
     undefined, so they would all be dropped and the first assertion fails. */
  const rows = mergeShowIndexRows(
    { shows: [cur("keeper", "Curated Keeper")] },
    { shows: [bre(1, "Inside Cut", 5), bre(2, "Outside Cut", BUILD_MAX_RANK + 1)] },
    { maxRank: BUILD_MAX_RANK }
  );
  assert.ok(rows.some((r) => r.id === "keeper"), "a curated row has no chart_rank and must survive the cut");
  assert.ok(rows.some((r) => r.id === "1"));
  assert.ok(!rows.some((r) => r.id === "2"));
});

test("a breadth row with no usable chart_rank is dropped rather than guessed at", () => {
  /* chart_rank is present on all 19,787 committed breadth rows (measured,
     docs/search-plan.md §1.1). A missing one therefore means the harvest shape
     changed, and the honest answer is to leave the row out rather than invent
     a band for it — search-engine.js's `popularityBand` would file it last
     anyway, but a silently reshaped harvest should be visible as a row-count
     drop, not absorbed.

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
    if (r.curated) assert.strictEqual(r.chart_rank, null);
    else assert.ok(r.chart_rank >= 1 && r.chart_rank <= BUILD_MAX_RANK, `${r.title} is out of cut`);
  }
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, "ids are unique");
});

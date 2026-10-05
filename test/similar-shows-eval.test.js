/* #560 item 8 — "Nothing measures whether a suggestion is good." This suite is
 * the measurement for `similarShows`: a hand-reviewed eval set
 * (tools/similar-eval/eval-set.json), a scorer (tools/similar-eval/score.mjs),
 * a runner that writes the numbers and every failing pair into
 * docs/research/similar-shows-eval-2026-10.md, and FLOORS on those numbers.
 *
 * WHAT THIS PROVES, in order:
 *  1. The ranking being scored IS app.js's: the mirror in
 *     tools/similar-eval/similar-shows.mjs is app.js's `function similarShows`
 *     character for character, and running app.js's own text in a vm gives the
 *     same row for all 220 catalogue shows. Change app.js's ranking and this
 *     suite is red until the mirror is pasted over — and then the floors below
 *     say whether the change made Similar shows better or worse.
 *  2. The eval set is well-formed against the catalogue the client loads, and
 *     every `label_scope: "general"` show is a seed (the hard cases).
 *  3. The scorer's arithmetic, on a hand-computed fixture.
 *  4. The measured floors. Each is the value MEASURED on 2026-10-04 against
 *     origin/main (after catalogue PKG-07, #1037), truncated to three places —
 *     a baseline, not a target. Raise a floor in the PR that earns it.
 *  5. The committed report's generated block is what the runner produces.
 *
 * Every test names the mutation that kills it (CLAUDE.md: a green test is not
 * evidence until you have broken it). Each was run on 2026-10-04.
 *
 * Harness: no app boot. The tool modules are ESM, imported dynamically. */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const readJson = (rel) => JSON.parse(read(rel));
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const MIRROR = "tools/similar-eval/similar-shows.mjs";
const SCORE = "tools/similar-eval/score.mjs";
const RUN = "tools/similar-eval/run.mjs";
const EVAL_SET = "tools/similar-eval/eval-set.json";
const CATALOG = "data/catalog-client.json";

/* MEASURED 2026-10-04 (node tools/similar-eval/run.mjs --json), truncated to
   three places. Ceilings are the measured counts.
   The two recall floors were RE-MEASURED 2026-10-05 for the #279 drinks wave
   (PKG-36, catalogue 220 -> 229 shows), and that run lowered them. No ranking
   changed. `whiskycast` has one node, `food/drinks`, so every drinks show ties
   on `shared` and the tie-break is `show_id` order. The wave's three
   b-prefixed beer shows (`beer-in-front`, `beersmith-podcast`, `brew-strong`)
   take slots ahead of `spirits-and-distilling`. Recall drops only because
   that one expected pair is missed (149 -> 150). The single-node
   alphabetical tie-break is the finding for #560's owner. */
const FLOOR = {
  precisionAll: 0.601, // 0.6018 over the 46 seeds whose row is non-empty (0.6061 after PKG-36)
  recallAll: 0.41, // 0.4101 over all 64 seeds after PKG-36 (0.4133 at 220 shows)
  recallCurated: 0.514, // 0.5147 over the 51 curated seeds after PKG-36 (0.5186 at 220 shows)
  hitRateAll: 0.687, // 44 / 64
  coverageAll: 0.718, // 46 / 64
};
const CEILING = {
  violationsCurated: 11, // in 8 seeds: the society/law and science/storytelling magnets, history/technology
  violationsGeneral: 0,
};

/** app.js's `function similarShows` declaration, from `function` to its
 *  closing column-0 brace. Located independently of the mirror module so a
 *  broken extractor cannot make the comparison vacuously equal. */
function appSimilarShowsSource() {
  const src = read("app.js");
  const m = /^function similarShows\(show, limit = \d+\) \{\n[\s\S]*?\n\}\n/m.exec(src);
  assert.ok(m, "function similarShows(show, limit = N) could not be located in app.js");
  return m[0].trimEnd();
}

function mirrorSource() {
  const src = read(MIRROR);
  const a = src.indexOf("// BEGIN MIRROR app.js similarShows");
  const b = src.indexOf("// END MIRROR");
  assert.ok(a >= 0 && b > a, `${MIRROR} has lost its MIRROR markers`);
  return src.slice(src.indexOf("\n", a) + 1, b).trimEnd();
}

let evalCache = null;
async function measured() {
  if (!evalCache) evalCache = (await load(RUN)).runEval(ROOT);
  return evalCache;
}

test("the mirror is app.js's similarShows, character for character", () => {
  /* MUTATION (run): change `limit = 6` to `limit = 7` inside the mirror block
     (or edit app.js's function and not the mirror) -> red, both texts shown. */
  const app = appSimilarShowsSource();
  const mirror = mirrorSource();
  assert.ok(app.includes("label_scope") && app.includes(".slice(0, limit)"), "extracted text is not the ranking function");
  assert.strictEqual(
    mirror,
    app,
    `${MIRROR} has drifted from app.js. Paste app.js's current similarShows between the MIRROR markers, then rerun node ${RUN} and re-measure the floors.`
  );
});

test("the mirror ranks every catalogue show exactly as app.js's own text does", async () => {
  /* The text check above covers the function; this covers the HARNESS around
     it (the module-scoped state, the limit pass-through) by running app.js's
     extracted text in a vm and comparing all 229 rows (220 until the #279
     drinks wave, PKG-36).
     MUTATION (run): in similarShowsFor, call `similarShows(show, limit ?? 5)`
     -> red at the first show with six candidates.
     MUTATION (run 2026-10-05, PKG-36): drop one show from
     data/catalog-client.json -> red on the count, 228 !== 229. */
  const { similarShowsFor } = await load(MIRROR);
  const catalog = readJson(CATALOG);
  const ctx = vm.createContext({ state: { catalog } });
  const appFn = vm.runInContext(`${appSimilarShowsSource()}\nsimilarShows;`, ctx);
  assert.strictEqual(catalog.shows.length, 229);
  for (const show of catalog.shows) {
    const want = Array.from(appFn(show), (s) => s.show_id); // main-realm array: deepStrictEqual compares prototypes
    const got = similarShowsFor(catalog, show).map((s) => s.show_id);
    assert.deepStrictEqual(got, want, `row for ${show.show_id}`);
  }
});

test("eval set: every id is a catalogue show, no seed lists itself, expected and must_not are disjoint", () => {
  /* MUTATION (run): rename one expected id to `the-matt-walker-podcastt`
     -> red naming the seed and the unknown id. */
  const ids = new Set(readJson(CATALOG).shows.map((s) => s.show_id));
  const set = readJson(EVAL_SET);
  assert.ok(set.seeds.length >= 60, `only ${set.seeds.length} seeds`);
  const seen = new Set();
  for (const s of set.seeds) {
    assert.ok(!seen.has(s.seed), `${s.seed} is a seed twice`);
    seen.add(s.seed);
    for (const id of [s.seed, ...s.expected, ...s.must_not]) assert.ok(ids.has(id), `${s.seed}: ${id} is not in ${CATALOG}`);
    assert.ok(s.expected.length > 0, `${s.seed} has no expected shows -- recall is undefined for it`);
    assert.ok(![...s.expected, ...s.must_not].includes(s.seed), `${s.seed} lists itself`);
    assert.deepStrictEqual(s.expected.filter((id) => s.must_not.includes(id)), [], `${s.seed}: expected and must_not overlap`);
    assert.strictEqual(new Set(s.expected).size, s.expected.length, `${s.seed}: duplicate expected id`);
    assert.ok(typeof s.note === "string" && s.note.length > 0, `${s.seed} has no reviewer note`);
  }
});

test("eval set: k is similarShows' own default limit", () => {
  /* The eval scores the row the show page renders, so k must be the slot
     count app.js renders. MUTATION (run): set `"k": 5` in eval-set.json -> red. */
  const m = /^function similarShows\(show, limit = (\d+)\)/m.exec(read("app.js"));
  assert.ok(m);
  assert.strictEqual(readJson(EVAL_SET).k, Number(m[1]));
});

test("eval set: every label_scope 'general' show is a seed (the hard cases)", () => {
  /* A general show gets no row and is never a candidate (PKG-03), so it is
     where the rule costs the most recall; a 14th general show must join the
     set in the PR that marks it.
     MUTATION (run): delete the huberman-lab seed -> red. */
  const general = readJson(CATALOG).shows.filter((s) => s.label_scope === "general").map((s) => s.show_id);
  assert.strictEqual(general.length, 13, "the catalogue's general-show count moved; re-review the set");
  const seeds = new Set(readJson(EVAL_SET).seeds.map((s) => s.seed));
  assert.deepStrictEqual(general.filter((id) => !seeds.has(id)), []);
});

test("scorer: precision over what was shown, recall capped at k, violations only from must_not", async () => {
  /* Hand-computed: shown [a,b,x,y], expected [a,b,c,d,e,f,g,h] (8), must_not
     [x], k=6 -> precision 2/4, recall 2/min(8,6)=1/3, one violation (x), one
     unjudged (y). An empty row has precision null, not 0.
     MUTATION (run): in score.mjs divide recall by `expected.length` instead of
     `Math.min(expected.length, k)` -> red (0.25 != 0.333). */
  const { scoreSeed, aggregate } = await load(SCORE);
  const r = scoreSeed(["a", "b", "x", "y"], ["a", "b", "c", "d", "e", "f", "g", "h"], ["x"], 6);
  assert.strictEqual(r.precision, 0.5);
  assert.strictEqual(r.recall, 2 / 6);
  assert.deepStrictEqual(r.violations, ["x"]);
  assert.deepStrictEqual(r.unjudged, ["y"]);
  const empty = scoreSeed([], ["a"], [], 6);
  assert.strictEqual(empty.precision, null);
  assert.strictEqual(empty.recall, 0);
  const agg = aggregate([r, empty]);
  assert.strictEqual(agg.precision, 0.5, "an empty row must not drag precision");
  assert.strictEqual(agg.coverage, 0.5);
  assert.strictEqual(agg.hitRate, 0.5);
  assert.strictEqual(agg.violations, 1);
});

test(`floor: precision of the shown row >= ${FLOOR.precisionAll}`, async () => {
  /* MUTATION (run): remove `.filter(x => x.shared > 0)` from the mirror
     (unrelated shows pad every short row, alphabetically) -> red. */
  const { all } = await measured();
  assert.ok(all.precision >= FLOOR.precisionAll, `precision ${all.precision} < floor ${FLOOR.precisionAll}`);
});

test(`floor: recall@6 >= ${FLOOR.recallAll} over all seeds, >= ${FLOOR.recallCurated} over curated seeds`, async () => {
  /* MUTATION (run): change the mirror's `limit = 6` to `limit = 3` -> red.
     Re-run 2026-10-05 against the re-measured PKG-36 floors: still red. */
  const { all, curated } = await measured();
  assert.ok(all.recall >= FLOOR.recallAll, `recall ${all.recall} < floor ${FLOOR.recallAll}`);
  assert.ok(curated.recall >= FLOOR.recallCurated, `curated recall ${curated.recall} < floor ${FLOOR.recallCurated}`);
});

test(`floor: hit rate >= ${FLOOR.hitRateAll}, coverage >= ${FLOOR.coverageAll}`, async () => {
  /* MUTATION (run): change the mirror's `x.shared > 0` to `x.shared > 1`
     (only multi-node overlaps count) -> red. */
  const { all } = await measured();
  assert.ok(all.hitRate >= FLOOR.hitRateAll, `hit rate ${all.hitRate} < floor ${FLOOR.hitRateAll}`);
  assert.ok(all.coverage >= FLOOR.coverageAll, `coverage ${all.coverage} < floor ${FLOOR.coverageAll}`);
});

test(`ceiling: curated seeds show at most ${CEILING.violationsCurated} must-not shows`, async () => {
  /* MUTATION (run): drop `&& s.label_scope !== "general"` from the mirror's
     candidate filter (cbc-ideas returns to titans-of-nuclear's row) -> red. */
  const { curated } = await measured();
  assert.ok(
    curated.violations <= CEILING.violationsCurated,
    `${curated.violations} must-not shows appeared; ceiling ${CEILING.violationsCurated}`
  );
});

test("ceiling: a general seed shows no must-not show", async () => {
  /* MUTATION (run): drop the mirror's first line
     `if (show?.label_scope === "general") return [];` (cbc-ideas lists
     titans-of-nuclear on the fusion label again) -> red. */
  const { general } = await measured();
  assert.strictEqual(general.violations, CEILING.violationsGeneral, `general seeds: ${general.violations} must-not shows appeared`);
});

test("the committed report's generated block is what the runner produces", async () => {
  /* MUTATION (run): change `0.602` to `0.700` in the report's table -> red. */
  const { reportIsCurrent, REPORT_PATH } = await load(RUN);
  assert.ok(reportIsCurrent(ROOT), `${REPORT_PATH} is stale -- run node ${RUN}`);
});

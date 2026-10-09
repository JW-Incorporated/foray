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
   alphabetical tie-break is the finding for #560's owner.
   RAISED 2026-10-05 (#560 item 9, crowded-row half): equal overlap now
   prefers the candidate with fewer total taxonomy_node_ids, show_id last.
   Precision, both recalls and the curated must-not ceiling moved and are
   re-pinned to that measurement. Hit rate and coverage did not move (the
   tie-break reorders rows, it never empties or fills one), so their floors
   keep the 2026-10-04 baseline. */
const FLOOR = {
  precisionAll: 0.613, // 0.6134 after the #560-9 tie-break (0.6018 on 2026-10-04, 0.6061 after PKG-36)
  recallAll: 0.425, // 0.4257 after the #560-9 tie-break (0.4133 at 220 shows, 0.4101 after PKG-36)
  recallCurated: 0.534, // 0.5343 after the #560-9 tie-break (0.5186 at 220 shows, 0.5147 after PKG-36)
  hitRateAll: 0.687, // 44 / 64 on 2026-10-04 (45 / 64 since #547; unchanged by #560-9)
  coverageAll: 0.718, // 46 / 64
};
const CEILING = {
  violationsCurated: 9, // in 6 seeds: the society/law and science/storytelling magnets (11 in 8 before #560-9, which dropped the history/technology pair)
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
     (unrelated shows pad every short row, alphabetically) -> red.
     MUTATION (run 2026-10-05, #560-9): delete the taxonomy_node_ids length
     key from the sort in BOTH app.js and the mirror (back to the alphabetical
     tie-break, so the mirror tests stay green) -> red here, on both recalls
     and on the curated must-not ceiling (0.606 / 0.410 / 0.515 / 11). Flipping
     it to prefer MORE nodes (`b` minus `a`) -> red here and on both recalls. */
  const { all } = await measured();
  assert.ok(all.precision >= FLOOR.precisionAll, `precision ${all.precision} < floor ${FLOOR.precisionAll}`);
});

test(`floor: recall@6 >= ${FLOOR.recallAll} over all seeds, >= ${FLOOR.recallCurated} over curated seeds`, async () => {
  /* MUTATION (run): change the mirror's `limit = 6` to `limit = 3` -> red.
     Re-run 2026-10-05 against the re-measured PKG-36 floors: still red.
     MUTATION (run 2026-10-05, #560-9): the alphabetical-tie-break revert
     described on the precision floor -> red (0.410 < 0.425). */
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
  /* MUTATION (run 2026-10-05, #560-9): the alphabetical-tie-break revert
     described on the precision floor -> red (11 > 9: acquired and
     fall-of-civilizations meet on history/technology again).
     NOT THIS TEST'S KILL since #547 residue (2026-10-06): dropping
     `&& s.label_scope !== "general"` from the candidate filter. That kill
     came only from titans-of-nuclear's must-not cbc-ideas, and the two no
     longer share a node (titans-of-nuclear is engineering/energy-fusion,
     cbc-ideas philosophy/ideas + nature/earth-science). Re-run 2026-10-06
     with the filter dropped from app.js AND the mirror: still 9, green.
     (With the mirror alone, the drift pins go red, not this test.)
     The next test owns that mutation on the real catalogue. */
  const { curated } = await measured();
  assert.ok(
    curated.violations <= CEILING.violationsCurated,
    `${curated.violations} must-not shows appeared; ceiling ${CEILING.violationsCurated}`
  );
});

test("no catalogue show's Similar row offers a label_scope 'general' show (PKG-03)", async () => {
  /* PKG-03 (founder ruling 24): a general show is never a candidate. The
     must-not ceilings stopped catching a lost candidate filter on the real
     catalogue once #547 residue split cbc-ideas from titans-of-nuclear (no
     curated seed's must-not names a general show that shares one of its
     nodes), and precision ROSE without the filter (0.613 -> 0.629), so no
     floor catches it either. test/show-page.test.js pins the filter on a
     fixture; this pins it on all 229 shipped rows.
     MUTATION (run 2026-10-06): drop `&& s.label_scope !== "general"` from
     the candidate filter in app.js AND the mirror (so the two drift pins stay
     green) -> red: 47 rows list a general show, the first being omega-tau's
     (stuff-you-should-know). The only other red is the stale-report check,
     which a rerun of tools/similar-eval/run.mjs turns green again. */
  const { similarShowsFor } = await load(MIRROR);
  const catalog = readJson(CATALOG);
  const general = new Set(catalog.shows.filter((s) => s.label_scope === "general").map((s) => s.show_id));
  assert.ok(general.size > 0, "fixture assumption: the catalogue marks some show general");
  const offending = catalog.shows
    .map((show) => [show.show_id, similarShowsFor(catalog, show).map((s) => s.show_id).filter((id) => general.has(id))])
    .filter(([, ids]) => ids.length);
  assert.deepStrictEqual(offending, [], `${offending.length} rows offer a general show`);
});

test("ceiling: a general seed shows no must-not show", async () => {
  /* MUTATION (run 2026-10-06, #547 residue): drop the mirror's first line
     `if (show?.label_scope === "general") return [];` -> red (7 must-not
     shows across 4 general seeds: stuff-you-should-know lists
     materialism-podcast and mrs-bulletin-materials-news, being-an-engineer
     lists around-the-house-eric-g and gardenfork-radio,
     software-engineering-daily lists advent-of-computing, unexplainable lists
     snap-judgment and the-moth). cbc-ideas is no longer among them:
     titans-of-nuclear left the fusion label it shared. */
  const { general } = await measured();
  assert.strictEqual(general.violations, CEILING.violationsGeneral, `general seeds: ${general.violations} must-not shows appeared`);
});

test("the committed report's generated block is what the runner produces", async () => {
  /* MUTATION (run): change `0.602` to `0.700` in the report's table -> red. */
  const { reportIsCurrent, REPORT_PATH } = await load(RUN);
  assert.ok(reportIsCurrent(ROOT), `${REPORT_PATH} is stale -- run node ${RUN}`);
});

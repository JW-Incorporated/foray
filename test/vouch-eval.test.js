/* #560 item 8, the `showsWeVouchFor` half (#1042 measured `similarShows`).
 * tools/similar-eval/vouch-run.mjs runs app.js's own "Shows 4a vouches for"
 * row for every UTC day of 2026 and writes the numbers into the second
 * generated block of docs/research/similar-shows-eval-2026-10.md. This suite
 * holds those numbers.
 *
 * WHAT THIS PROVES, in order:
 *  1. The row being measured IS app.js's: the runner evaluates app.js's own
 *     declarations, and an independent extraction here gives the same 365
 *     rows. The harness's one shortcut (no session) is pinned as equivalent.
 *  2. The aggregation's arithmetic, on a hand-computed fixture, and the
 *     extractor refuses to measure a stand-in.
 *  3. The measured gates. (a) the eligible set is the whole curated catalogue
 *     (229 shows, all with an editorial_note). (b) rotation coverage over
 *     229, and the skew toward early show_ids, as ceilings. (c) row integrity.
 *     (d) Family Mode violations and (e) label_scope leakage are CEILINGS on
 *     the measured counts, never zero: showsWeVouchFor applies neither filter
 *     and this PR does not change app.js. A Family Mode filter (the routed
 *     card) drops (d) and its ceiling comes down in the same PR.
 *  4. The committed report's block is what the runner produces, and the two
 *     runners' blocks cannot overwrite each other.
 *
 * Every value MEASURED 2026-10-05 against origin/main 919f925d
 * (node tools/similar-eval/vouch-run.mjs --json). Every test names the
 * mutation that kills it (CLAUDE.md: a green test is not evidence until you
 * have broken it); each was run on 2026-10-05, app.js and data restored after.
 *
 * Harness: no app boot. The tool module is ESM, imported dynamically. */

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

const VOUCH = "tools/similar-eval/vouch-run.mjs";
const SIMILAR = "tools/similar-eval/run.mjs";
const CATALOG = "data/catalog-client.json";

const FLOOR = {
  surfaced: 229, // every eligible show appears at least once in 2026
  minAppearances: 1, // our-fake-history, strict-scrutiny, the-worlds-best-construction-podcast
  meanDistinctBranches: 7.956, // 7.9561 top-level branches per 8-slot row
};
const CEILING = {
  maxAppearances: 38, // advent-of-computing, amicus-dahlia-lithwick, ams-on-the-air (even rotation: 12.75)
  firstDecileShare: 0.232, // 0.2315 of slots go to the first 23 show_ids (even rotation: ~0.100)
  familySlots: 573, // (d) 19.6% of 2,920 slots
  familyDays: 296, // (d) days with at least one show Family Mode would hide
  scopeSlots: 205, // (e) 7.0% of 2,920 slots
  scopeDays: 152, // (e) days with at least one label_scope "general" show
};

let cache = null;
async function measured() {
  if (!cache) cache = (await load(VOUCH)).runVouchEval(ROOT);
  return cache;
}

/** app.js's `function NAME(` declaration, located independently of the
 *  runner's extractor so a broken extractor cannot make the comparison
 *  vacuously equal. */
function appFunction(name) {
  const m = new RegExp(`^function ${name}\\(.*\\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(read("app.js"));
  assert.ok(m, `function ${name} could not be located in app.js`);
  return m[0];
}

test("the measured rows are app.js's own showsWeVouchFor, day by day", async () => {
  /* MUTATION (run): in vouch-run.mjs runVouchEval, call
     `showsWeVouchFor(7, date)` instead of `showsWeVouchFor(undefined, date)`
     -> red on 2026-01-01 (7 shows, app.js renders 8). */
  const { rows, window } = await measured();
  const catalog = readJson(CATALOG);
  const ctx = vm.createContext({ state: { catalog } });
  const fn = vm.runInContext(
    `${appFunction("dayOfYearSeed")}\n${appFunction("seededShuffle")}\n${appFunction("showsWeVouchFor")}\nshowsWeVouchFor;`,
    ctx
  );
  assert.strictEqual(window.days, 365);
  assert.strictEqual(rows.length, 365);
  for (const row of rows) {
    const want = Array.from(fn(undefined, new Date(`${row.date}T00:00:00Z`)), (s) => s.show_id);
    assert.deepStrictEqual(row.ids, want, `row for ${row.date}`);
  }
});

test("the harness's no-session shortcut reads the same explicit-rated items fullPool would", () => {
  /* The runner sets state.session = null, so showHasExplicitEpisodes reads
     discover.items directly instead of fullPool() (session.json's episodes
     plus discover's). That is equivalent only while no session episode is
     rated explicit. This cannot fail on today's data; it is here so the day
     session.json gains a rating, the shortcut is revisited instead of
     silently undercounting.
     MUTATION (run): add `"explicit": true` to the first episode in
     data/session.json -> red. */
  const episodes = Object.entries(readJson("data/session.json").episodes);
  assert.ok(episodes.length > 0);
  assert.deepStrictEqual(episodes.filter(([, e]) => e && e.explicit === true).map(([id]) => id), []);
});

test("extractor: a missing app.js declaration stops the eval, naming it", async () => {
  /* MUTATION (run): make extractDeclaration `return ""` when the regex does
     not match -> red (no throw). */
  const { extractDeclaration } = await load(VOUCH);
  assert.throws(() => extractDeclaration("function other() {\n}\n", "function", "showsWeVouchFor"), /showsWeVouchFor/);
  assert.throws(() => extractDeclaration("let x = 1;\n", "let", "catalogShowIndex"), /catalogShowIndex/);
  const src = "function a(x = 1) {\n  return x;\n}\nfunction b() {\n}\n";
  assert.strictEqual(extractDeclaration(src, "function", "a"), "function a(x = 1) {\n  return x;\n}\n");
});

test("aggregation: coverage, appearances, integrity and the (d)/(e) counts on a hand-computed fixture", async () => {
  /* Catalogue a,b,c,d (d is general, b is family-unsafe), limit 2, three days:
     [a,b], [a,c], [a,a]. Surfaced a,b,c = 3/4; appearances a4 b1 c1 d0;
     day 3 is a duplicate row; day 2's late row differs (unstable);
     family slots 1 on 1 day; scope slots 0.
     MUTATION (run): in measureRows divide coverage.ratio by `rows.length`
     instead of `eligibleIds.length` -> red (1 != 0.75). */
  const { measureRows } = await load(VOUCH);
  const show = (id, extra = {}) => ({ show_id: id, taxonomy_node_ids: [`${id}-branch/leaf`], ...extra });
  const catalog = { shows: [show("a"), show("b"), show("c"), show("d", { label_scope: "general" })] };
  const r = measureRows({
    catalog,
    eligibleIds: ["a", "b", "c", "d"],
    limit: 2,
    unsafeIds: ["b"],
    rows: [
      { date: "d1", ids: ["a", "b"], lateIds: ["a", "b"] },
      { date: "d2", ids: ["a", "c"], lateIds: ["c", "a"] },
      { date: "d3", ids: ["a", "a"], lateIds: ["a", "a"] },
    ],
  });
  assert.strictEqual(r.coverage.surfaced, 3);
  assert.strictEqual(r.coverage.ratio, 0.75);
  assert.deepStrictEqual(r.coverage.never, ["d"]);
  assert.deepStrictEqual(r.coverage.appearances, { a: 4, b: 1, c: 1, d: 0 });
  assert.strictEqual(r.coverage.expected, 1.5);
  assert.deepStrictEqual(r.integrity.duplicateRows, ["d3"]);
  assert.deepStrictEqual(r.integrity.unstableDays, ["d2"]);
  assert.strictEqual(r.family.slots, 1);
  assert.strictEqual(r.family.daysWithAny, 1);
  assert.strictEqual(r.scope.slots, 0);
  assert.strictEqual(r.scope.catalogueShows, 1);
});

test("(a) the eligible set is the whole curated catalogue: all 229 shows carry an editorial_note", async () => {
  /* MUTATION (run): set one show's editorial_note to "" in
     data/catalog-client.json -> red (228 !== 229). */
  const r = await measured();
  assert.strictEqual(r.catalogueShows, 229);
  assert.strictEqual(r.eligible, r.catalogueShows, `${r.catalogueShows - r.eligible} shows fell out of the vouch row's eligible set`);
});

test(`(b) rotation: ${FLOOR.surfaced} of 229 shows surface in the year, each at least ${FLOOR.minAppearances} day`, async () => {
  /* MUTATION (run): in app.js seededShuffle, `const j = s % (i + 1)` ->
     `const j = i` (no shuffle: the same first eight show_ids every day)
     -> red (8 surfaced). */
  const { coverage } = await measured();
  assert.ok(coverage.surfaced >= FLOOR.surfaced, `${coverage.surfaced} shows surfaced; floor ${FLOOR.surfaced}. Never: ${coverage.never.join(", ")}`);
  assert.ok(coverage.min >= FLOOR.minAppearances, `a show surfaced on only ${coverage.min} days`);
});

test(`(b) skew: no show on more than ${CEILING.maxAppearances} days, the first tenth of show_ids at most ${CEILING.firstDecileShare} of slots`, async () => {
  /* Ceilings on a measured DEFECT (the LCG's low bits favour early show_ids;
     see the research note), so a fix passes and a worse skew does not.
     MUTATION (run): app.js showsWeVouchFor `limit = 8` -> `limit = 12`
     -> red on the max (more slots, more days per show). */
  const { coverage } = await measured();
  assert.ok(coverage.max <= CEILING.maxAppearances, `a show surfaced on ${coverage.max} days; ceiling ${CEILING.maxAppearances}`);
  assert.ok(
    coverage.firstDecileShare <= CEILING.firstDecileShare,
    `first-tenth share ${coverage.firstDecileShare}; ceiling ${CEILING.firstDecileShare}`
  );
});

test("(c) every row is limit distinct eligible shows, and the same set all UTC day", async () => {
  /* MUTATION (run): app.js dayOfYearSeed `.slice(0, 10)` -> `.slice(0, 13)`
     (seeded by the hour) -> red, unstable days.
     MUTATION (run): app.js seededShuffle `[a[i], a[j]] = [a[j], a[i]]` ->
     `a[i] = a[j]` -> red, duplicate rows. */
  const { integrity, limit } = await measured();
  assert.strictEqual(limit, 8, "showsWeVouchFor's default limit moved; re-measure every gate here");
  assert.deepStrictEqual(integrity.shortRows, [], "short rows");
  assert.deepStrictEqual(integrity.duplicateRows, [], "rows with a show twice");
  assert.deepStrictEqual(integrity.ineligibleRows, [], "rows with an ineligible show");
  assert.deepStrictEqual(integrity.unstableDays, [], "days whose 00:00 and 23:59 UTC rows differ");
});

test(`(c) a row spans at least ${FLOOR.meanDistinctBranches} top-level branches on average`, async () => {
  /* MUTATION (run): app.js showsWeVouchFor `limit = 8` -> `limit = 4`
     -> red (fewer slots, fewer branches; and the limit assertion above). */
  const { branches } = await measured();
  assert.ok(
    branches.meanDistinct >= FLOOR.meanDistinctBranches,
    `mean ${branches.meanDistinct} branches per row; floor ${FLOOR.meanDistinctBranches}`
  );
});

test("(d) the Family Mode predicate measured is app.js's: every explicit-rated and every comedy show is rejected", async () => {
  /* Guards the HARNESS: (d) is only meaningful if familyAllows runs with
     Family Mode ON.
     MUTATION (run): in vouch-run.mjs loadAppFunctions, make the stub
     `function familyMode() { return false; }` -> red (nothing rejected). */
  const { family } = await measured();
  const catalog = readJson(CATALOG);
  const rejected = new Set(family.catalogueIds);
  const explicit = catalog.shows.filter((s) => s.explicit === true).map((s) => s.show_id);
  const comedy = catalog.shows
    .filter((s) => (s.taxonomy_node_ids || []).some((n) => n.split("/")[0] === "comedy"))
    .map((s) => s.show_id);
  assert.strictEqual(explicit.length, 8);
  assert.deepStrictEqual(explicit.filter((id) => !rejected.has(id)), [], "explicit-rated shows Family Mode let through");
  assert.deepStrictEqual(comedy.filter((id) => !rejected.has(id)), [], "comedy shows Family Mode let through");
  const byReason = Object.values(family.byReason).reduce((a, b) => a + b, 0);
  assert.strictEqual(byReason, family.catalogueShows, "every rejected show has a reason");
});

test(`(d) ceiling: Family Mode violations at most ${CEILING.familySlots} slots on ${CEILING.familyDays} days (not zero: the row has no Family Mode filter)`, async () => {
  /* A CEILING, never a zero pin: showsWeVouchFor applies no Family Mode
     filter (routed as its own app.js card). Lower it when that card lands.
     MUTATION (run): app.js showsWeVouchFor `limit = 8` -> `limit = 12`
     -> red. MUTATION (run): delete `if (item.explicit === false) return true;`
     from app.js familySafe (clean-rated shows then fall through to the
     unrated rule and are rejected) -> red. */
  const { family } = await measured();
  assert.ok(family.slots <= CEILING.familySlots, `${family.slots} Family Mode violations; ceiling ${CEILING.familySlots}`);
  assert.ok(family.daysWithAny <= CEILING.familyDays, `${family.daysWithAny} days with a violation; ceiling ${CEILING.familyDays}`);
});

test(`(e) ceiling: label_scope "general" shows fill at most ${CEILING.scopeSlots} slots on ${CEILING.scopeDays} days`, async () => {
  /* MUTATION (run): app.js showsWeVouchFor `limit = 8` -> `limit = 12`
     -> red. */
  const { scope } = await measured();
  assert.strictEqual(scope.catalogueShows, 13, "the catalogue's general-show count moved; re-measure (e)");
  assert.ok(scope.slots <= CEILING.scopeSlots, `${scope.slots} label_scope leaks; ceiling ${CEILING.scopeSlots}`);
  assert.ok(scope.daysWithAny <= CEILING.scopeDays, `${scope.daysWithAny} days with a leak; ceiling ${CEILING.scopeDays}`);
});

test("the committed report's vouch block is what the runner produces", async () => {
  /* MUTATION (run): change `573 (19.6%)` to `500 (19.6%)` in the report's
     vouch block -> red. */
  const { reportIsCurrent, REPORT_PATH } = await load(VOUCH);
  assert.ok(reportIsCurrent(ROOT), `${REPORT_PATH} vouch block is stale -- run node ${VOUCH}`);
});

test("the vouch splice leaves the similarShows block alone, and both blocks are current", async () => {
  /* MUTATION (run): set vouch-run.mjs's END to run.mjs's
     "<!-- END GENERATED -->" -> red (the markers stop being distinct, and a
     splice that found it would cut the similarShows block). */
  const vouch = await load(VOUCH);
  const similar = await load(SIMILAR);
  assert.notStrictEqual(vouch.END, similar.END);
  assert.ok(!vouch.END.includes(similar.END) && !vouch.BEGIN.includes(similar.BEGIN), "marker strings overlap");
  const text = read(vouch.REPORT_PATH);
  const spliced = vouch.spliceReport(text, "X");
  const block = (t) => t.slice(t.indexOf(similar.BEGIN), t.indexOf(similar.END) + similar.END.length);
  assert.ok(text.indexOf(similar.END) < text.indexOf(vouch.BEGIN), "the vouch block must follow the similarShows block");
  assert.strictEqual(block(spliced), block(text));
  assert.ok(similar.reportIsCurrent(ROOT), "the similarShows block is stale");
});

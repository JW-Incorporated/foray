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
 *  3. The measured gates. The runner measures the row twice: (a), (b), (c)
 *     and (e) with Family Mode OFF, (d) with it ON. (a) the eligible set is
 *     the whole curated catalogue (229 shows, all with an editorial_note).
 *     (b) rotation coverage over 229, and the skew toward early show_ids, as
 *     ceilings. (c) row integrity. (d) Family Mode violations are ZERO since
 *     showsWeVouchFor filters with familyAllows (2026-10-06, #560), and the
 *     ON row still fills every slot. (e) label_scope leakage stays a CEILING
 *     on the measured count: the row applies no label_scope filter.
 *  4. The committed report's block is what the runner produces, and the two
 *     runners' blocks cannot overwrite each other.
 *
 * Every value MEASURED 2026-10-05 against origin/main 919f925d
 * (node tools/similar-eval/vouch-run.mjs --json), and re-measured 2026-10-06
 * against d75f456c with the Family Mode filter and the high-bit swap (the
 * 560-part card). Every test names the
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

/* Re-measured 2026-10-06 after seededShuffle took its swap from the LCG's
   high bits (#560): the (b) and (e) values below moved with the rotation. */
const FLOOR = {
  surfaced: 229, // every eligible show appears at least once in 2026 (Family Mode OFF)
  minAppearances: 2, // physiology-endurance-running (was 1 with the low-bit swap)
  /* 7.9452 since the high-bit swap (was 7.9561): the new rotation changes
     which shows share a row, and the mean moved by 0.011 of a branch.
     7.9890 since the #547 show-label residue (2026-10-06): CBC Ideas,
     Catalyst and TechSurge no longer all sit on the engineering branch
     (now philosophy+nature, engineering, business+computing), so fewer rows
     double up on it. Raised to the measured value, not lowered. */
  meanDistinctBranches: 7.989,
};
const CEILING = {
  maxAppearances: 24, // planetary-radio, sigma-nutrition-radio (even rotation: 12.75; was 38 with the low-bit swap)
  firstDecileShare: 0.097, // 0.0969 of slots go to the first 23 show_ids (even rotation: ~0.100; was 0.2315)
  familySlots: 0, // (d) was 573 (19.6% of 2,920 slots) before the 2026-10-06 filter
  familyDays: 0, // (d) was 296 days with at least one show Family Mode hides
  scopeSlots: 169, // (e) 5.8% of 2,920 slots (was 205 with the low-bit swap)
  scopeDays: 141, // (e) days with at least one label_scope "general" show (was 152)
};

/* (d) with Family Mode ON, measured 2026-10-06 after the familyAllows filter. */
const FAMILY_ON = {
  rejected: 39, // 17 comedy, 14 unrated, 8 rated explicit
  eligible: 190, // 229 - 39
  surfaced: 190, // all of them (189 with the low-bit swap: ologies-with-alie-ward never)
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

test("the measured rows are app.js's own showsWeVouchFor, day by day, in both Family Mode settings", async () => {
  /* OFF: app.js's own familyAllows with familyMode() false. ON: a
     familyAllows that rejects exactly the runner's (d) set, which the
     "(d) the Family Mode predicate measured is app.js's" test below ties to
     app.js's rule.
     MUTATION (run): in vouch-run.mjs runMode, call
     `showsWeVouchFor(7, date)` instead of `showsWeVouchFor(undefined, date)`
     -> red on 2026-01-01 (7 shows, app.js renders 8).
     MUTATION (run 2026-10-06): in vouch-run.mjs runVouchEval, build the ON
     run from `offFns` -> red (the ON rows hold rejected shows). */
  const { rows, familyRows, window, family } = await measured();
  const catalog = readJson(CATALOG);
  const unsafe = new Set(family.catalogueIds);
  const row = (familyOn) => {
    const ctx = vm.createContext({ state: { catalog }, unsafe });
    const allows = familyOn
      ? "function familyAllows(s) { return !unsafe.has(s.show_id); }"
      : `function familyMode() { return false; }\n${appFunction("familyAllows")}`;
    return vm.runInContext(
      `${allows}\n${appFunction("dayOfYearSeed")}\n${appFunction("seededShuffle")}\n${appFunction("showsWeVouchFor")}\nshowsWeVouchFor;`,
      ctx
    );
  };
  assert.strictEqual(window.days, 365);
  assert.ok(unsafe.size > 0, "the ON comparison needs a non-empty rejected set");
  for (const [label, measuredRows, fn] of [
    ["Family Mode OFF", rows, row(false)],
    ["Family Mode ON", familyRows, row(true)],
  ]) {
    assert.strictEqual(measuredRows.length, 365, label);
    for (const r of measuredRows) {
      const want = Array.from(fn(undefined, new Date(`${r.date}T00:00:00Z`)), (s) => s.show_id);
      assert.deepStrictEqual(r.ids, want, `${label}: row for ${r.date}`);
    }
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

test(`(b) rotation: ${FLOOR.surfaced} of 229 shows surface in the year, each on at least ${FLOOR.minAppearances} days`, async () => {
  /* MUTATION (run): in app.js seededShuffle, `const j = (s >>> 16) % (i + 1)`
     -> `const j = i` (no shuffle: the same first eight show_ids every day)
     -> red (8 surfaced). */
  const { coverage } = await measured();
  assert.ok(coverage.surfaced >= FLOOR.surfaced, `${coverage.surfaced} shows surfaced; floor ${FLOOR.surfaced}. Never: ${coverage.never.join(", ")}`);
  assert.ok(coverage.min >= FLOOR.minAppearances, `a show surfaced on only ${coverage.min} days`);
});

test(`(b) skew: no show on more than ${CEILING.maxAppearances} days, the first tenth of show_ids at most ${CEILING.firstDecileShare} of slots`, async () => {
  /* Ceilings at the measured values since the 2026-10-06 fix: the swap now
     comes from the LCG's high bits; the low bits favoured early show_ids
     (23.2% of slots to the first tenth; see the research note).
     MUTATION (run 2026-10-06): app.js seededShuffle, restore
     `const j = s % (i + 1)` -> red (max 38 days; first-tenth share 0.2315).
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
     MUTATION (run 2026-10-06): in vouch-run.mjs loadAppFunctions, make the
     stub `function familyMode() { return false; }` whatever the option
     -> red (nothing rejected). */
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

test(`(d) Family Mode ON: ${CEILING.familySlots} violations on ${CEILING.familyDays} days, every one of the ${FAMILY_ON.rejected} rejected shows kept out`, async () => {
  /* Zero since 2026-10-06 (#560): showsWeVouchFor filters with familyAllows,
     the same predicate the runner counts with. Before it, 573 slots on 296
     days.
     MUTATION (run 2026-10-06): drop `.filter(familyAllows)` from app.js
     showsWeVouchFor -> red (573 slots on 296 days). */
  const { family } = await measured();
  assert.strictEqual(family.catalogueShows, FAMILY_ON.rejected, "the rejected set moved; re-measure (d)");
  assert.strictEqual(family.slots, CEILING.familySlots, `${family.slots} Family Mode violations`);
  assert.strictEqual(family.daysWithAny, CEILING.familyDays, `${family.daysWithAny} days with a violation`);
  assert.strictEqual(family.distinctShown, 0);
});

test(`(d) Family Mode ON: every row is still limit distinct allowed shows, the same all day, over ${FAMILY_ON.eligible} eligible shows`, async () => {
  /* The filter runs BEFORE the sort and the shuffle, so a Family Mode row
     loses no slots and stays one set per UTC day for every visitor.
     MUTATION (run 2026-10-06): app.js showsWeVouchFor, filter after the cut
     (`seededShuffle(shows, ...).slice(0, limit).filter(familyAllows)`)
     -> red (short rows).
     MUTATION (run 2026-10-06): app.js seededShuffle, restore
     `const j = s % (i + 1)` -> red (189 of 190 surface). */
  const { familyOn, family, catalogueShows } = await measured();
  assert.strictEqual(familyOn.limit, 8);
  assert.strictEqual(familyOn.eligible, catalogueShows - family.catalogueShows, "ON eligible = catalogue minus the rejected set");
  assert.strictEqual(familyOn.eligible, FAMILY_ON.eligible);
  assert.deepStrictEqual(familyOn.integrity.shortRows, [], "short rows with Family Mode on");
  assert.deepStrictEqual(familyOn.integrity.duplicateRows, [], "rows with a show twice");
  assert.deepStrictEqual(familyOn.integrity.ineligibleRows, [], "rows with an ineligible show");
  assert.deepStrictEqual(familyOn.integrity.unstableDays, [], "days whose 00:00 and 23:59 UTC rows differ");
  assert.ok(familyOn.coverage.surfaced >= FAMILY_ON.surfaced, `${familyOn.coverage.surfaced} shows surfaced; floor ${FAMILY_ON.surfaced}`);
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
  /* MUTATION (run 2026-10-06): change `0 (0.0%), on 0 of 365 days` to
     `1 (0.0%), on 0 of 365 days` in the report's vouch block -> red. */
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

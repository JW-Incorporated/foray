/* Unit tests for search-engine.js's full-phrase show-name RESCUE in
 * scoreMatch() -- the "+8 when every query token appears in the show name"
 * block, gated on `!wouldPassGate`.
 *
 * THE BUG (filed from adversarial Fable-fleet red-team, kanban t_711dce13
 * fleet member 1; root-caused with real repro output against
 * data/discover.json): the rescue was gated on `interp.groups.length >= 2`,
 * so a single-word query -- someone typing just a show's name into the
 * topic search box, e.g. "volts" or "radiolab" -- could never reach it.
 * `interp.groups.length` is 1 for those queries, so the rescue was skipped
 * entirely, and a show-field-only hit contributes just `f += 1` per
 * scoreMatch's normal per-term scoring, never reaching the `1.2`
 * per-group qualifying bar. Result: a real, well-covered show returned a
 * flat `status: "empty"` in the topic box. 11 of 23 one-word shows in the
 * live catalogue reproduced this before the fix (Acquired, Gastropod,
 * Lingthusiasm, SpyCast, Causality, Volts, Radiolab, Unexplainable,
 * Palaeocast, FoundMyFitness, StoryCorps).
 *
 * THE FIX: loosen the gate from `interp.groups.length >= 2` to `>= 1`.
 * `wouldPassGate` is unchanged, so the rescue still only fires for items
 * that would otherwise be excluded -- multi-word queries that already
 * worked (direct show/host searches AND shows whose name happens to equal
 * a real topic/tag match, e.g. "crime junkie") are untouched, per the
 * existing comment's own "would otherwise be excluded" invariant.
 *
 * WHY A FIXTURE POOL, NOT ONLY THE LIVE CATALOGUE: a fixture pins the
 * mechanism as a known, stable claim independent of what tomorrow's
 * nightly refresh puts in data/discover.json. The live-catalogue case at
 * the bottom is the actual reproduction and must never be deleted -- it is
 * what caught the real bug.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SE = require(path.join(ROOT, "search-engine.js"));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

/* No concepts modeled at all -- every token is a bare literal with no
   tag/topic bonus available, which is exactly the shape a one-word show
   name has when the show's name isn't also a modeled topic word. */
const semantic = { concepts: {}, modifiers: {} };

function item(id, over = {}) {
  return {
    id, show: "Show", title: "Title", hook: "",
    topics: [], duration_min: 30,
    ...over,
  };
}

/* One real episode per one-word show, plus filler so corpusDF denominators
   look like a real catalogue rather than a trivially tiny one. */
const showItems = [
  item("volts-1", { show: "Volts", title: "How heat pumps actually work" }),
  item("radiolab-1", { show: "Radiolab", title: "A story about the brain" }),
  item("acquired-1", { show: "Acquired", title: "The history of a company" }),
];
const fillerItems = Array.from({ length: 500 }, (_, i) =>
  item(`filler-${i}`, {
    show: `Filler Show ${i}`, title: `Episode about something else ${i}`,
    hook: "An unrelated conversation about cooking and travel.", topics: ["other/misc"],
  }));
const pool = [...showItems, ...fillerItems];
const discover = { items: pool };
const itemTags = { tags: {} };
const ctxOf = () => ({ semantic, itemTags, discover });

function rank(query) {
  const ctx = ctxOf();
  const interp = SE.interpretQuery(query, ctx);
  return SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
}

test("a bare one-word show-name query has exactly one group (the gate this bug hit)", () => {
  /* MUTATION: change tokenize's split so "volts" produces two groups --
     this would falsely make the old `>= 2` gate look sufficient. */
  const interp = SE.interpretQuery("volts", ctxOf());
  assert.equal(interp.groups.length, 1, "a single-word query must produce exactly one group");
});

test("a single-word show-name query rescues the show's own episodes (the fix)", () => {
  /* MUTATION: revert the gate to `interp.groups.length >= 2` -- this test
     then fails because scoreMatch never reaches the rescue block for a
     one-group query, sum stays at the bare `f += 1` show-field hit, never
     crosses the 1.2 per-group bar, and searchWithRelaxation returns zero
     results for "volts" despite a real Volts episode sitting in the pool. */
  const { results } = rank("volts");
  const ids = results.map(r => r.i.id);
  assert.ok(ids.includes("volts-1"), "a bare \"volts\" query must surface the real Volts episode");
});

test("a single-word show-name query does not rescue an unrelated show", () => {
  /* MUTATION: drop the `allTokensInShow` check (rescue unconditionally) --
     this test then fails because "radiolab" would also rescue items whose
     show name does not contain "radiolab" at all. */
  const { results } = rank("volts");
  const ids = results.map(r => r.i.id);
  assert.ok(!ids.includes("radiolab-1"), "\"volts\" must not rescue an unrelated show's episodes");
  assert.ok(!ids.includes("acquired-1"), "\"volts\" must not rescue an unrelated show's episodes");
});

test("three different bare one-word show queries each rescue only their own show", () => {
  for (const [q, wantId] of [["volts", "volts-1"], ["radiolab", "radiolab-1"], ["acquired", "acquired-1"]]) {
    const { results } = rank(q);
    const ids = results.map(r => r.i.id);
    assert.ok(ids.includes(wantId), `"${q}" must rescue ${wantId}`);
  }
});

test("the rescue never fires for an item that already qualifies without it", () => {
  /* `wouldPassGate` (real topic/tag match) must short-circuit the rescue
     regardless of groups.length -- this is what keeps "crime junkie"/
     "endurance running" (existing multi-word invariant) correct, and the
     same must hold at n=1. Call scoreMatch directly and confirm `matched`
     is the plain per-group count (1), not forced to `primaryGroupCount`
     the way the rescue branch does when it actually executes.
     MUTATION: remove the `!wouldPassGate` condition (always apply the
     rescue when allTokensInShow) -- `matched` would then be forced to
     `interp.primaryGroupCount` unconditionally, which happens to also be 1
     here, so instead assert `sum` stays under the un-rescued ceiling: a
     normal single-group match tops out at (2.5+3+2+1.5+1)*1 = 10 for a
     "own"-source term hitting every field, well under any value the +8
     rescue would push it past for this fixture's weights. */
  const concepts = {
    heat: { terms: ["heat", "heatpump"], topics: ["energy/heat"], related: [] },
  };
  const ctx = { semantic: { concepts, modifiers: {} }, itemTags, discover };
  const interp = SE.interpretQuery("heat", ctx);
  const echoesQuery = item("echo", { show: "Heat Talk", title: "Heat", topics: ["energy/heat"] });
  const scored = SE.scoreMatch(echoesQuery, interp, itemTags);
  assert.equal(scored.matched, 1, "a normally-qualifying single-group item must report matched=1, not the rescue's forced primaryGroupCount override");
});

/* ---------- the live catalogue: the actual reproduction ---------- */

const liveDiscover = read("data/discover.json");
const liveItemTags = read("data/item-tags.json");
const liveSemantic = read("data/semantic-index.json");

function liveRank(query) {
  const ctx = { semantic: liveSemantic, itemTags: liveItemTags, discover: liveDiscover };
  const interp = SE.interpretQuery(query, ctx);
  return SE.searchWithRelaxation(liveDiscover.items, interp, 2, liveItemTags, () => 0.5);
}

/* The 11 one-word shows the bug report measured as flat `empty` despite
   real episodes in the pool. If any of these has since left the live
   catalogue, poolCount is 0 and the assertion is skipped for that show
   rather than failing on stale fixture data. */
const LIVE_ONE_WORD_SHOWS = [
  "Acquired", "Gastropod", "Lingthusiasm", "SpyCast", "Causality", "Volts",
  "Radiolab", "Unexplainable", "Palaeocast", "FoundMyFitness", "StoryCorps",
];

test("live catalogue: every one-word show from the bug report now returns real results", () => {
  let checked = 0;
  for (const show of LIVE_ONE_WORD_SHOWS) {
    const poolCount = liveDiscover.items.filter(i => i.show === show).length;
    if (poolCount === 0) continue;
    checked++;
    const { results } = liveRank(show);
    assert.ok(results.length > 0,
      `"${show}" (poolCount=${poolCount}) still returns zero results -- the single-token rescue gate is broken`);
  }
  assert.ok(checked >= 8, `only checked ${checked} of ${LIVE_ONE_WORD_SHOWS.length} shows -- catalogue drifted too far to be a meaningful regression check`);
});

test("live catalogue: multi-word show/host searches that already worked are unaffected", () => {
  const { results: crimeJunkie } = liveRank("crime junkie");
  const { results: lexFridman } = liveRank("lex fridman");
  assert.ok(crimeJunkie.length > 0, "\"crime junkie\" must keep returning results");
  assert.ok(lexFridman.length > 0, "\"lex fridman\" must keep returning results");
});

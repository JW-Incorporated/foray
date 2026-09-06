/* THIN ANCHORS (#209) -- "Electrical Circuit Design Dummies" returned
 * game-design and personal-finance episodes, not electronics content.
 *
 * WHAT WENT WRONG, diagnosed against the real catalogue before any fix
 * landed (kanban t_08dfdc08):
 *
 *   interpretQuery("Electrical Circuit Design Dummies", ctx) tokenizes to
 *   four primary (non-broad) groups: "electrical", "circuit", "design",
 *   "dummies". Of those, "electrical" and "circuit" are each real,
 *   specific, on-topic words with almost no footprint in the catalogue
 *   (corpusDF 0.00053 and 0 respectively -- "circuit" appears nowhere as a
 *   whole word in title/hook/topics/tags) and no concept in
 *   data/semantic-index.json models either of them, so they can only ever
 *   match by bare literal text. "design", by contrast, IS a concept term
 *   (topics: culture/design) -- but it is ALSO the literal word in three
 *   unrelated show titles that dominate the catalogue by sheer frequency:
 *   "The Game Design Round Table", "Design Matters with Debbie Millman",
 *   "Designer Notes". "dummies" matches nothing.
 *
 *   searchWithRelaxation's primary-token gate (pre-fix) was OR: an item
 *   qualifies the moment ANY primary group matches. So every item whose
 *   show name merely contains "Design" qualified on "design" alone, with
 *   zero of "electrical"/"circuit" present anywhere in the item -- and
 *   because those items are common, they filled all 10 slots, burying the
 *   two real hits ("S7E31 ... A Former Electrical Engineer's Guide to
 *   Building Wealth" -- itself off-topic, personal finance, matching only
 *   on "electrical") under a page of game-design and celebrity-interview
 *   content. Confident "ok" status, zero on-topic results.
 *
 * THE FIX, in search-engine.js: a primary group whose token has no concept
 * expansion AND a corpusDF under THIN_ANCHOR_DF (0.002, i.e. under 0.2% of
 * the catalogue) is marked `thin`. searchWithRelaxation now requires EVERY
 * thin primary group to also match, on top of (not instead of) the
 * existing OR/AND primary-token gate -- so a thin, specific word can never
 * be silently outvoted by an unrelated common word sharing the query.
 * Queries with no thin tokens are completely unaffected (thinAnchorCount
 * is 0, the added check is `0 === 0`, always true).
 *
 * WHY FIXTURES, NOT ONLY THE LIVE CATALOGUE: the live-catalogue tests in
 * the second half of this file are the actual reproduction and must never
 * be deleted -- they are what caught the real bug -- but a fixture with a
 * synthetic pool is what makes each assertion a KNOWN, STABLE claim rather
 * than one that silently stops proving anything the day the nightly
 * refresh changes what's in data/discover.json. Every test below names the
 * one-line mutation that kills it, per CLAUDE.md's testing standard.
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

/* ---------- fixture pool: a synthetic catalogue that reproduces the shape
   of the real defect under full control ---------- */

/* "design" is a real concept (see data/semantic-index.json's own "design"
   entry): terms ["design", "product-design", "architecture"], topic
   culture/design. Mirrored here so the fixture's `design` group behaves
   exactly like the real one -- concept-backed, therefore never `thin`. */
const semantic = {
  concepts: {
    design: {
      terms: ["design", "product-design", "architecture"],
      topics: ["culture/design"],
      related: [],
    },
  },
  modifiers: {},
};

function item(id, over = {}) {
  return {
    id, show: "Show", title: "Title", hook: "",
    topics: [], duration_min: 30,
    ...over,
  };
}

/* 30 items whose show name is literally "Design Talk" and nothing else
   about them is electronics-related -- the "commoner co-token" side of the
   real defect (Game Design Round Table / Design Matters / Designer Notes,
   here collapsed to one repeated show so corpusDF for "design" clears
   BROAD_DF_THRESHOLD comfortably... no: kept UNDER it deliberately, see
   below, so this exercises the THIN-anchor gate specifically and not the
   separate `broad` gate). Two genuinely on-topic circuit items are mixed
   in so a fix that over-corrects (requires an exact PHRASE, say) would
   also show up as a regression here, not just a false fix that happens to
   pass by returning empty for everything. */
const designOnlyItems = Array.from({ length: 8 }, (_, i) =>
  item(`design-only-${i}`, {
    show: `Design Talk ${i}`,
    title: `Episode ${i}: a conversation about design`,
    hook: "Design, design, design -- a show about product design.",
    topics: ["culture/design"],
  }));

const circuitItems = [
  item("circuit-1", {
    show: "Electronics Weekly", title: "Electrical circuit design for beginners",
    hook: "A gentle circuit design primer for the electrically curious.",
    topics: ["engineering/electronics"],
  }),
  item("circuit-2", {
    show: "Electronics Weekly", title: "Op-amp circuit design deep dive",
    hook: "Analog circuit design, from first principles to real boards.",
    topics: ["engineering/electronics"],
  }),
];

/* Filler so corpusDF denominators look like a real, not tiny, catalogue --
   without this every token's corpusDF is trivially high/low and the
   THIN_ANCHOR_DF comparison is not a meaningful test of the threshold.
   Sized so the two genuine circuit items sit at ~0.0012 corpusDF, safely
   under THIN_ANCHOR_DF (0.002) -- roughly the real catalogue's own
   "circuit"/"electrical" df (0-0.0005 over ~1,540 items, see the kanban
   card's diagnosis), not an arbitrary round number. */
const fillerItems = Array.from({ length: 1600 }, (_, i) =>
  item(`filler-${i}`, {
    show: `Filler Show ${i}`, title: `Episode about something else ${i}`,
    hook: "An unrelated conversation about cooking and travel.", topics: ["other/misc"],
  }));

const pool = [...designOnlyItems, ...circuitItems, ...fillerItems];
const discover = { items: pool };
const itemTags = { tags: {} };
const ctxOf = () => ({ semantic, itemTags, discover });

function rank(query) {
  const ctx = ctxOf();
  const interp = SE.interpretQuery(query, ctx);
  return SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
}

test("a thin, unmodeled token (\"circuit\") is marked thin and a modeled common one (\"design\") is not", () => {
  /* MUTATION: delete `!hasConceptExpansion &&` from the `thin` computation
     -- "design" (concept-backed) would then also read thin whenever its
     corpusDF happened to dip under THIN_ANCHOR_DF, which is not what this
     test is pinning (it is pinning the CONCEPT-COVERAGE half of the
     condition, independent of df). */
  const interp = SE.interpretQuery("electrical circuit design", ctxOf());
  const byToken = Object.fromEntries(interp.groups.map(g => [g.token, g]));
  assert.ok(byToken.circuit.thin, "\"circuit\" has no concept and near-zero corpusDF -- must be thin");
  assert.ok(byToken.electrical.thin, "\"electrical\" has no concept and near-zero corpusDF -- must be thin");
  assert.ok(!byToken.design.thin, "\"design\" is concept-backed -- must never be thin regardless of its df");
});

test("a query result must contain EVERY thin primary token, not just the commonest one", () => {
  /* MUTATION: revert the `x.thinMatched !== interp.thinAnchorCount` filter
     in searchWithRelaxation back to plain OR (delete the line) -- this
     test then fails because the eight design-only items (matching only on
     "design") would qualify and, matching more terms via the concept's own
     three terms, could plausibly rank at or above the two genuine circuit
     items depending on scoring, but at minimum WOULD be included in
     `results` at all, which the assertion below forbids. */
  const { results } = rank("electrical circuit design");
  const ids = results.map(r => r.i.id);
  assert.ok(!ids.some(id => id.startsWith("design-only-")),
    "a design-only item (no electrical/circuit content) must not qualify -- thin tokens were outvoted");
  for (const id of ids) {
    assert.ok(id.startsWith("circuit-"), `unexpected result ${id} for a thin-anchored query`);
  }
});

test("the same query with only thin tokens present (no commoner co-token) still returns its genuine matches", () => {
  /* MUTATION: change the thin-gate comparison from `!==` to `===` (invert
     it) -- a query with NO thin tokens (thinAnchorCount 0) would then
     require thinMatched !== 0, i.e. impossible, so nothing would ever
     qualify. Catches the sign of the gate, not just its presence. */
  const { results } = rank("circuit");
  const ids = results.map(r => r.i.id).sort();
  assert.deepEqual(ids, ["circuit-1", "circuit-2"],
    "a bare thin-token query must still surface its real, on-topic matches");
});

test("a query with no thin tokens at all is completely unaffected by the gate", () => {
  /* MUTATION: make `thin` always true (drop both conditions) -- "design"
     alone would then also require itself to match (trivially true) but a
     multi-primary-token query where every primary IS concept-backed and
     common would start requiring things it never used to, which this
     fixture's own "design" query would not catch on its own (single
     group), so this specifically checks thinAnchorCount reads 0. */
  const interp = SE.interpretQuery("design", ctxOf());
  assert.equal(interp.thinAnchorCount, 0, "a fully concept-backed query must never carry thin anchors");
  const { results } = rank("design");
  assert.ok(results.length >= 8, "the ordinary design query must keep its normal recall");
});

/* ---------- the live catalogue: the actual reproduction ---------- */

const liveDiscover = read("data/discover.json");
const liveItemTags = read("data/item-tags.json");
const liveSemantic = read("data/semantic-index.json");
const liveSession = read("data/session.json");
const liveValidated = read("data/validated-links.json");

/* Mirrors app.js's fullPool()/tools/test-search.mjs's copy -- see
   test/search-bar-exposure.test.js's header for why this is copied rather
   than imported: the thing that must never be copied is the matcher, and
   it is not. */
function liveFullPool() {
  const p = [];
  const seen = new Set();
  for (const id of Object.keys(liveSession.episodes)) {
    const ep = liveSession.episodes[id];
    const v = liveValidated?.episodes?.[id];
    const src = v ? { ...ep, artwork_url: v.artwork_url || ep.artwork_url || null } : ep;
    p.push({
      id, show: src.show, title: src.title,
      apple_collection_id: src.apple_collection_id,
      duration_min: src.duration_min ?? null,
      topics: src.topics || [],
      hook: src.hook || src.summary || src.title,
    });
    seen.add(id);
  }
  for (const it of liveDiscover.items) if (!seen.has(it.id)) p.push(it);
  return p;
}
const livePool = liveFullPool();

function liveRank(query) {
  const ctx = { semantic: liveSemantic, itemTags: liveItemTags, discover: liveDiscover };
  const interp = SE.interpretQuery(query, ctx);
  return SE.searchWithRelaxation(livePool, interp, 2, liveItemTags, () => 0.5).results;
}

/* Off-topic branches the pre-fix bug actually surfaced for this exact
   query, on the real catalogue -- see the reproduction in the kanban card
   diagnosis. A regression here is exactly what shipped to Joey. */
const OFF_TOPIC_BRANCHES = ["gaming/design", "business/careers", "economics/markets", "culture/design"];

test('Joey\'s exact query, "Electrical Circuit Design Dummies", returns no game-design/finance/celebrity-design content', () => {
  /* MUTATION: revert search-engine.js's thin-anchor gate (delete the
     `x.thinMatched !== interp.thinAnchorCount` filter line) -- this is the
     literal bug report reproduced: pre-fix this returns "ok" with 10
     picks, at least one from gaming/design and one from
     business/careers+economics/markets (the "Former Electrical Engineer's
     Guide to Building Wealth" episode, matching only on the word
     "electrical" used in a finance context). */
  const results = liveRank("Electrical Circuit Design Dummies");
  const branches = results.map(r => SE.branchOf(r.i));
  for (const b of OFF_TOPIC_BRANCHES) {
    assert.ok(!branches.includes(b), `off-topic branch "${b}" resurfaced for the electrical-circuit-design query`);
  }
});

test("near-variants of Joey's query (\"electrical circuit design\", \"circuit design\") are also free of the off-topic flood", () => {
  for (const query of ["electrical circuit design", "circuit design"]) {
    const results = liveRank(query);
    const branches = results.map(r => SE.branchOf(r.i));
    for (const b of OFF_TOPIC_BRANCHES) {
      assert.ok(!branches.includes(b), `"${query}": off-topic branch "${b}" present`);
    }
  }
});

test("\"circuit\" alone (thin, no concept) never pulls in the gaming/design flood that used to ride in on a co-token", () => {
  const results = liveRank("circuit");
  const branches = results.map(r => SE.branchOf(r.i));
  assert.ok(!branches.includes("gaming/design"), "bare \"circuit\" must not surface gaming/design content");
});

test("a genuinely on-topic query for the catalogue's real design coverage (\"design\", bare) is unaffected by the thin-anchor gate", () => {
  /* Not a thin-anchor case at all -- single primary group, itself
     concept-backed, so thinAnchorCount is 0 and this must behave exactly
     as before the fix. Guards against an over-broad THIN_ANCHOR_DF that
     would start treating "design" itself as thin and regress the
     battery's own "design" case (tools/test-search.mjs). */
  const ctx = { semantic: liveSemantic, itemTags: liveItemTags, discover: liveDiscover };
  const interp = SE.interpretQuery("design", ctx);
  assert.equal(interp.thinAnchorCount, 0);
  const results = liveRank("design");
  assert.ok(results.length > 0, "the ordinary \"design\" query must keep returning results");
});

/* Spot-check other specific, real-world-phrased queries on unrelated
   topics, per the card's Phase 2 step 3: this must be a systemic fix, not
   a hardcoded patch for one query string. Each pairs a thin, catalogue-
   sparse anchor with a common, unrelated co-token the way "circuit"/
   "design" did, so a regression of the same shape would be caught here
   too. */
const SYSTEMIC_SPOT_CHECKS = [
  /* "tuning" is a common word across music/instrument content and
     unrelated "fine-tuning" (ML) usage; "carburetor" is specific and
     catalogue-thin. A fix scoped only to "circuit"/"design" by name would
     not touch this pair at all. */
  "carburetor tuning basics",
  /* "solder" thin/unmodeled; "joint" common across medicine (joint pain)
     and comedy. */
  "solder joint guide",
  /* "transistor" thin; "amplifier"/"history" broad. */
  "transistor history explained",
];

/* Kanban t_dda8ca5b (filed from Fable-fleet red-team t_711dce13): the
   documented "far below rare but real" framing for THIN_ANCHOR_DF implies
   a wide safety margin above the cutoff, but a real word can sit right
   next to it. "ornithology" is corpusDF ~0.0021 -- ~0.0001 over the 0.002
   line -- and carries no concept expansion, so thin=false and it gets
   none of the #209 protection: a broad co-token ("history") can carry the
   whole query while "ornithology" itself contributes to none of the top
   picks. This is NOT a bug -- classifyResults' honesty floor still reports
   `sparse`, not a false-confident `ok`/`rich` set -- this test pins that
   honest-degrade behaviour so a future THIN_ANCHOR_DF retune is forced to
   notice this boundary case rather than silently changing its shape. */
test("boundary case just above THIN_ANCHOR_DF (\"ornithology\", corpusDF ~0.0021): thin=false, and status honestly degrades to sparse rather than faking a confident match", () => {
  /* MUTATION: this is a documentation/pin test, not a correctness gate --
     if this starts failing because THIN_ANCHOR_DF's calibration moved or
     the catalogue's df for "ornithology" shifted enough to cross 0.002 in
     either direction, that is expected and worth a fresh look (see the
     kanban card), not an automatic revert. What it must never regress to
     is `thin=true` with unrelated `status=ok`/`rich` -- i.e. a confident-
     looking result set built entirely from the broad co-token. */
  const ctx = { semantic: liveSemantic, itemTags: liveItemTags, discover: liveDiscover };
  const query = "Ornithology History Explained";
  const interp = SE.interpretQuery(query, ctx);
  const byToken = Object.fromEntries(interp.groups.map(g => [g.token, g]));
  /* Only assert while "ornithology" is still sitting in the JUST-ABOVE-cutoff
     window this test exists to pin (0.002 <= df < 0.003, i.e. within 50% of
     THIN_ANCHOR_DF above the line). If a catalogue refresh drops it below
     0.002 (it would then correctly read thin=true -- a different case, not
     a regression) or pushes it well clear of the boundary (no longer the
     scenario this test documents), skip rather than assert something this
     test was never designed to check. */
  if (!byToken.ornithology || byToken.ornithology.df < 0.002 || byToken.ornithology.df >= 0.003) {
    return; // catalogue snapshot moved ornithology's df away from the just-above-cutoff boundary window
  }
  assert.ok(!byToken.ornithology.thin,
    "this pins the CURRENT boundary shape: corpusDF just above 0.002 reads thin=false, unprotected");
  const results = liveRank(query);
  const cls = SE.classifyResults(results, {});
  assert.notEqual(cls.status, "ok",
    "an unprotected boundary token being fully outvoted by a broad co-token must never present as a confident 'ok' match");
  assert.notEqual(cls.status, "rich",
    "an unprotected boundary token being fully outvoted by a broad co-token must never present as a confident 'rich' match");
});

test("spot-check: other thin-anchor-shaped queries do not fabricate relevance from a common co-token", () => {
  for (const query of SYSTEMIC_SPOT_CHECKS) {
    const ctx = { semantic: liveSemantic, itemTags: liveItemTags, discover: liveDiscover };
    const interp = SE.interpretQuery(query, ctx);
    const results = liveRank(query);
    const thinTokens = interp.groups.filter(g => g.thin).map(g => g.token);
    if (!thinTokens.length) continue; // this catalogue snapshot may not make every candidate thin; only check where it applies
    for (const r of results) {
      const text = [r.i.title, r.i.hook, r.i.show, (r.i.topics || []).join(" ")].join(" ").toLowerCase();
      const hasAnyThinToken = thinTokens.some(t => new RegExp("\\b" + t).test(text));
      assert.ok(hasAnyThinToken, `${query}: result ${r.i.id} matched with no sign of its thin anchor(s) [${thinTokens.join(",")}]`);
    }
  }
});

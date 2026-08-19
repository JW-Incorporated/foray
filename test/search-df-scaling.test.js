/* Unit tests for search-engine.js's document-frequency SCALE -- `tagCount` vs
 * `tagDF`, the three threshold fractions, and `dfMultiplier` (#275).
 *
 * WHAT WENT WRONG, AND WHY IT NEEDS A SUITE OF ITS OWN
 * `tagDF` returned an absolute count and `interpretQuery` compared it against
 * absolute thresholds (`df > 60` deleted a term from the expansion, `df > 25` cut
 * its weight to 0.4x) while `scoreMatch` bucketed a multiplier at 10 and 30 --
 * and `corpusDF`, ten lines away in the same module, was already a fraction. So
 * half of this module's df logic was scale-free and half was not, and the
 * scale-bound half retuned itself every night as the catalogue grew. Over five
 * real nightly snapshots of `data/item-tags.json` (878 -> 1,561 entries,
 * 2026-07-19 -> 2026-08-18) that moved 52 terms across the expansion threshold
 * and 125 across the score multiplier, with no code change and nobody deciding
 * anything.
 *
 * THE DEFECT IS AN INVARIANCE FAILURE, SO THESE ARE INVARIANCE TESTS. A fixture
 * asserting "term X is dropped" pins today's behaviour and says nothing about
 * drift -- it is exactly the kind of assertion that stayed green through a month
 * of silent retuning. What has teeth is comparing the SAME CORPUS AT TWO SIZES:
 *
 *   GROWTH   duplicate every entry k times. Composition is unchanged by
 *            construction, so a bucket that moves has moved for no reason at all.
 *   SUBSET   keep a proportional share of the entries. This is #274's mobile
 *            bundle, where an absolute count made the app rank differently from
 *            the website.
 *
 * Both are checked WITH A WITNESS: each also computes the pre-#275 absolute rule
 * and asserts that it really does move. Without the witness a green run cannot
 * tell "invariant" from "the fixture is too small to cross anything", which is
 * the vacuity this repo keeps rediscovering -- three §6 collision assertions in
 * tools/test-search.mjs were vacuous for weeks, and one test here passed with the
 * whole mechanism it covered deleted until the witness was added.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT CLAIM, because measuring it showed the
 * claim is false: that a query's STATUS is invariant under growth. It is not, and
 * not because of df -- `RICH_MIN` is a count of bar-clearing results, so
 * duplicating the corpus duplicates the clearers and a sparse query goes "ok" on
 * arithmetic that has nothing to do with this issue. What IS invariant, and what
 * this suite and tools/test-search.mjs §10 pin between them, is the
 * INTERPRETATION: the expansion, the weights and the multiplier tier.
 *
 * WHERE THE REAL-BUNDLE VERSION LIVES: tools/mobile/prepare-webdir.test.mjs. That
 * file owns the refusal to trim `data/item-tags.json`, so it owns the measurement
 * behind it -- against the real slice, which is topically skewed and therefore
 * still moves buckets that proportional subsetting does not. The tests here are
 * about the arithmetic; that one is about the bundle.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SE = require(path.join(ROOT, "search-engine.js"));

/* A tag map of `n` entries in which the first `hits` carry `term`. The filler tag
   is a word no threshold and no concept cares about. */
function tagMap(n, term, hits) {
  const tags = {};
  for (let k = 0; k < n; k++) tags["it" + k] = k < hits ? [term] : ["zzfiller"];
  return { tags };
}
const ctxOf = (itemTags, extra) => ({ itemTags, ...extra });

/* ---------- the two quantities, and which one is a fraction ---------- */

test("tagCount is the absolute count and tagDF is that count over the tag map", () => {
  /* The split #275 introduces. `tagCount` is what test/search-matcher.test.js
     pins the shared-matcher behaviour on, because counting is the mechanism
     there; `tagDF` is what every THRESHOLD reads.

     KILLED BY: `function tagDF(term, ctx) { return tagCount(term, ctx); }` --
     dropping the division, which is the pre-#275 state exactly. */
  const ctx = ctxOf(tagMap(8, "jazz", 2));
  assert.equal(SE.tagCount("jazz", ctx), 2);
  assert.equal(SE.tagDF("jazz", ctx), 0.25);
  assert.equal(SE.tagCount("nothing", ctx), 0);
  assert.equal(SE.tagDF("nothing", ctx), 0);
});

test("tagDF's denominator is the TAG MAP, not the pool it is searched against", () => {
  /* The load-bearing choice, and the one a tidying pass would get wrong.
     `corpusDF` divides by `discover.items.length` because it counts items;
     `tagDF` counts entries in the tag map and must divide by the size of the map
     it walked. It is also the only denominator under which subsetting the map is
     safe (see below): a trimmed map scales numerator and denominator together,
     while `discover.items.length` would not move at all and every fraction would
     collapse.

     KILLED BY: `/ (ctx.discover?.items?.length || 1)`, and by any constant. The
     fixture is built so the two denominators cannot agree -- 4 tag entries
     against a 20-item discover. */
  const itemTags = tagMap(4, "jazz", 1);
  const discover = { items: Array.from({ length: 20 }, (_, k) => ({ id: "d" + k, title: "t", show: "s", topics: [] })) };
  const ctx = ctxOf(itemTags, { discover });
  assert.equal(SE.tagDF("jazz", ctx), 0.25);
  assert.notEqual(SE.tagDF("jazz", ctx), 1 / 20);
});

test("an empty or absent tag map is 0, not NaN or Infinity", () => {
  /* A NaN comparison is false on BOTH branches, so `df > TAG_DF_TOO_BROAD` and
     `df > TAG_DF_COMMON` would both miss and every term would silently keep full
     weight -- a failure with no error message anywhere. app.js fetches the map
     over the network, so the empty case is reachable in the product rather than
     theoretical.

     THIS IS A CAN'T-FAIL-TODAY TEST AND IT IS WRITTEN DELIBERATELY (CLAUDE.md
     "A green test is not evidence"): the shipped map is never empty, so nothing in
     the product exercises this path, and it is the only thing standing between a
     failed fetch and a search that silently keeps every broad term at full weight.
     It does fail on the mutation below, which is the property that matters.

     KILLED BY: `return tagCount(term, ctx) / ctx._dfTotal` without the guard. */
  for (const ctx of [ctxOf({ tags: {} }), ctxOf({}), {}]) {
    const df = SE.tagDF("jazz", ctx);
    assert.equal(df, 0, `got ${df}`);
    assert.ok(Number.isFinite(df));
  }
});

test("tagDF caches the map size per ctx and does not leak between ctxs", () => {
  /* `Object.keys().length` is O(entries) and query time calls tagDF once per
     expansion term, so the size is cached on the ctx -- the same pattern
     `_dfMemo` and `_corpusDfMemo` already use, with the same hazard: a cache that
     outlives its corpus reports the wrong denominator.

     KILLED BY: hoisting `_dfTotal` to module scope, which makes the third
     assertion return the large ctx's fraction. */
  const small = ctxOf(tagMap(4, "jazz", 1));
  const large = ctxOf(tagMap(40, "jazz", 1));
  assert.equal(SE.tagDF("jazz", small), 0.25);
  assert.equal(SE.tagDF("jazz", large), 0.025);
  assert.equal(SE.tagDF("jazz", small), 0.25);
  assert.equal(small._dfTotal, 4);
});

/* ---------- the ladder is fractions, ordered, and shared with BROAD_DF_THRESHOLD ---------- */

test("the three tag-df thresholds are ordered fractions and the top one IS BROAD_DF_THRESHOLD", () => {
  /* Not decoration. The whole defect was a threshold on the wrong scale, so "is
     this number a fraction" is the property that regressed, and it is checkable
     without knowing which fraction is right. Ordering matters too: with
     TAG_DF_COMMON above TAG_DF_TOO_BROAD the 0.4x branch is unreachable and the
     demotion silently stops existing.
     The identity with BROAD_DF_THRESHOLD is asserted rather than left as a
     coincidence, because it is the ARGUMENT for the value -- a token too common to
     anchor a query is too common to expand into -- and the two drifting apart
     again by an accident of tuning is the shape of this issue.

     WHAT THE PINNED IDENTITY DOES NOT CLAIM: that the two cuts are interchangeable.
     They read different populations (corpusDF over the discover pool, tagDF over the
     tag map) and corpusDF runs a few points higher, so at a shared value the
     expansion cut is looser than the anchor cut -- `engineering` is `broad` as a
     token at 12.3% corpusDF and survives expansions at 6.3% tagDF. The assertion
     forbids the two DRIFTING APART SILENTLY, not splitting them: splitting is
     legitimate, and it means editing this line and saying why in search-engine.js.
     WHAT NOTHING HERE PINS, said plainly because this suite reads every threshold
     back from the engine: the VALUES. Retuning TAG_DF_COMMON to 0.05 passes all ten
     tests in this file. The ceiling on that cut is a product judgement and its guard
     is tools/test-search.mjs's "parenting" case, which is where a value belongs.

     KILLED BY: restoring any of 60 / 25 / 30 / 10; by swapping TAG_DF_COMMON and
     TAG_DF_TOO_BROAD; and by retuning TAG_DF_TOO_BROAD away from
     BROAD_DF_THRESHOLD without saying so. */
  const { TAG_DF_TOO_BROAD: broad, TAG_DF_COMMON: common, TAG_DF_RARE: rare } = SE;
  for (const [name, v] of Object.entries({ broad, common, rare })) {
    assert.ok(v > 0 && v < 1, `${name} = ${v} is not a fraction of the catalogue`);
  }
  assert.ok(rare < common, `TAG_DF_RARE ${rare} must sit below TAG_DF_COMMON ${common}`);
  assert.ok(common < broad, `TAG_DF_COMMON ${common} must sit below TAG_DF_TOO_BROAD ${broad}`);
  assert.equal(broad, SE.BROAD_DF_THRESHOLD);
});

test("dfMultiplier tiers on the fraction, and scoreMatch reads it rather than its own ternary", () => {
  /* Two claims, and the second has a history. The tiers were an inline ternary in
     scoreMatch AND a copy of that ternary in tools/test-search.mjs -- the #249
     shape, an oracle reimplementing its subject. Sharing the function is worth
     nothing unless scoreMatch actually calls it, so this drives a real scoreMatch
     with two interpretations identical except for `df` and demands the ratio.

     KILLED BY: re-inlining any tier in scoreMatch (the ratio assertions fail),
     and by comparing `df` against 10/30 again -- every fraction is under 10, so
     all three tiers collapse to 1.35 and both ratios become 1. */
  const { TAG_DF_RARE: rare, TAG_DF_COMMON: common } = SE;
  assert.equal(SE.dfMultiplier(0), 1.35);
  assert.equal(SE.dfMultiplier(rare), 1.35);
  assert.equal(SE.dfMultiplier(rare + 1e-9), 1);
  assert.equal(SE.dfMultiplier(common), 1);
  assert.equal(SE.dfMultiplier(common + 1e-9), 0.75);
  assert.equal(SE.dfMultiplier(1), 0.75);

  const item = { id: "x", title: "a jazz history", show: "s", hook: "", topics: [] };
  const interp = (df) => ({
    groups: [{ token: "jazz", terms: new Map([["jazz", { w: 1, source: "own" }]]), broad: false, df, hasConceptExpansion: true }],
    filters: [], topicBoosts: new Set(), hasPrimary: true, properNounQuery: false, primaryGroupCount: 1,
  });
  const at = (df) => SE.scoreMatch(item, interp(df), { tags: {} }).sum;
  assert.ok(at(0) > 0, "the fixture must actually score, or the ratios below are 0/0");
  assert.ok(Math.abs(at(0) / at(common) - 1.35) < 1e-9, `boost tier not applied by scoreMatch: ${at(0)} vs ${at(common)}`);
  assert.ok(Math.abs(at(common) / at(1) - 1 / 0.75) < 1e-9, `penalty tier not applied by scoreMatch: ${at(common)} vs ${at(1)}`);
});

/* ---------- the expansion buckets, reached through interpretQuery ---------- */

/* A one-concept semantic index whose concept carries the query token plus one
   expansion term, so `interpretQuery` produces exactly one prunable term and the
   bucket it landed in is readable off the result. The token itself is never
   pruned (`info.w >= 1` short-circuits), which is why these read the EXPANSION
   term and not the token. */
const oneConcept = { concepts: { c: { terms: ["jazz", "bebop"], related: [], topics: [] } } };
function expansionWeight(entries, hits) {
  const itemTags = tagMap(entries, "bebop", hits);
  const ctx = { semantic: oneConcept, itemTags, discover: { items: [] } };
  return SE.interpretQuery("jazz", ctx).groups[0].terms.get("bebop");
}

test("interpretQuery drops, demotes or keeps an expansion term by FRACTION of the tag map", () => {
  /* The three buckets, addressed by fraction rather than by count, on a 200-entry
     map so every threshold is crossable with entries to spare. Full weight for a
     concept's own term is 0.6 (see addTerm) and the demotion is 0.4x of that.

     KILLED BY: `df > 60` / `df > 25`, and the direction is worth stating exactly,
     because "the absolute rule is simply unreachable here" would be a weak reason and
     it is not the reason. On a 200-entry map the absolute rule UNDER-reacts: 21 hits
     is 10.5% of the map and must drop, but 21 is not over 60, so the term comes back
     at full weight and the first assertion goes red on a value, not on an absence.
     Same for 5 of 200 against `> 25`. Restoring either threshold fails here. */
  const { TAG_DF_TOO_BROAD: broad, TAG_DF_COMMON: common } = SE;
  const above = (f) => Math.floor(f * 200) + 1;
  const below = (f) => Math.max(0, Math.ceil(f * 200) - 1);

  assert.equal(expansionWeight(200, above(broad)), undefined, "a term over TAG_DF_TOO_BROAD must leave the expansion");
  const demoted = expansionWeight(200, above(common));
  assert.ok(demoted, "a term between the two thresholds must stay in the expansion");
  assert.ok(Math.abs(demoted.w - 0.6 * 0.4) < 1e-9, `expected 0.4x of 0.6, got ${demoted.w}`);
  const kept = expansionWeight(200, below(common));
  assert.ok(Math.abs(kept.w - 0.6) < 1e-9, `expected full 0.6, got ${kept.w}`);

  /* THE BOUNDARIES THEMSELVES, and they were unpinned until a mutation round asked.
     Both cuts are strict (`>`), inherited from `df > 60` / `df > 25`, and no real term
     sits at exactly 0.02 or 0.10 of the live map -- that needs counts of 31.22 and
     156.1 -- so `>` -> `>=` changed nothing measurable and survived all ten tests
     here AND the 123-check battery. A threshold whose boundary no test can see is a
     threshold with a free variable in it.
     The fixture is 200 entries so both cuts land on whole numbers: 4/200 is exactly
     TAG_DF_COMMON and 20/200 is exactly TAG_DF_TOO_BROAD. AT the cut is the LOWER
     bucket, on both.

     KILLED BY: `df >= TAG_DF_COMMON` (the first assertion) and
     `df >= TAG_DF_TOO_BROAD` (the second). */
  assert.ok(Math.abs(expansionWeight(200, Math.round(common * 200)).w - 0.6) < 1e-9,
    "a term exactly AT TAG_DF_COMMON keeps full weight -- the cut is strict");
  const atBroad = expansionWeight(200, Math.round(broad * 200));
  assert.ok(atBroad, "a term exactly AT TAG_DF_TOO_BROAD stays in the expansion -- the cut is strict");
  assert.ok(Math.abs(atBroad.w - 0.6 * 0.4) < 1e-9, `a term exactly at TAG_DF_TOO_BROAD is demoted, not dropped: got ${atBroad.w}`);
});

test("the same COMPOSITION at a different size lands in the same bucket", () => {
  /* Scale invariance where the defect lived, as an equality between two corpora
     that differ only in size. 30 of 200 and 300 of 2,000 are the same corpus; the
     pre-#275 rule called the first "full weight" and the second "dropped".

     KILLED BY: the pre-#275 rule, and it takes BOTH of its lines, which is worth
     stating rather than implying. Restoring `df > 60` / `df > 25` alone leaves this
     green -- every df here is a fraction under 0.2, so both cuts pass everything at
     full weight and the pairs still agree. It is the COUNT plus the absolute cut that
     splits them: substitute `absoluteBucket(tagCount(...))` (defined below, for the
     real-repo witness) and 30-of-200 against 300-of-2,000 disagree. A "KILLED BY"
     that names two mutations where one is required is the overclaim this file exists
     to avoid, so: the mutation is the revert, not either half of it. */
  for (const share of [0.005, 0.02, 0.05, 0.2]) {
    const small = expansionWeight(200, Math.round(share * 200));
    const large = expansionWeight(2000, Math.round(share * 2000));
    assert.deepEqual(small, large, `share ${share} tiers differently at 200 and at 2,000 entries`);
  }
});

test("a PROPORTIONAL subset of the tag map tiers identically, which is what an absolute count could not do", () => {
  /* #274's mobile bundle, reduced to its arithmetic. Trimming the tag map to the
     items the app bundles scales every COUNT by the trim ratio, so the website
     and the app disagreed: `war` 72 -> 24, deleted from the expansion on the web
     and at full weight on the phone. A fraction of the map's own size cancels the
     ratio exactly, so a proportional subset is indistinguishable.
     PROPORTIONAL is the whole precondition, and it is why this is a fixture and
     not a real-bundle test: the real slice is topically skewed, so it still moves
     some buckets, and that measurement lives in
     tools/mobile/prepare-webdir.test.mjs where the refusal to trim lives.

     KILLED BY: any absolute threshold. The witness below asserts the absolute rule
     really does split these pairs, so this cannot pass by being too small to
     matter. */
  for (const [entries, hits] of [[1500, 180], [1500, 90], [1500, 30]]) {
    const whole = ctxOf(tagMap(entries, "bebop", hits));
    const third = ctxOf(tagMap(entries / 3, "bebop", hits / 3));
    assert.equal(SE.tagDF("bebop", whole), SE.tagDF("bebop", third));
    assert.equal(SE.dfMultiplier(SE.tagDF("bebop", whole)), SE.dfMultiplier(SE.tagDF("bebop", third)));
    /* THE WITNESS: the counts these fractions came from are three times apart, and
       the absolute rule tiers at least one of them differently. */
    assert.equal(SE.tagCount("bebop", whole), hits);
    assert.equal(SE.tagCount("bebop", third), hits / 3);
    const absBucket = (n) => (n > 60 ? "drop" : n > 25 ? "0.4x" : "full");
    assert.notEqual(absBucket(hits), absBucket(hits / 3),
      `the absolute rule agrees at ${hits} and ${hits / 3}, so this pair witnesses nothing`);
  }
});

/* ---------- the real repo, at 1x / 2x / 4x, with a witness ---------- */

/* Every term tagDF can be called with: the concept vocabulary plus ALIASES (a
   query token reaches tagDF as itself, and an alias is added as a term). Read
   from data/, not hand-listed, so the coverage cannot silently shrink. */
function realVocabulary() {
  const semantic = JSON.parse(fs.readFileSync(path.join(ROOT, "data/semantic-index.json"), "utf8"));
  const v = new Set();
  for (const c of Object.values(semantic.concepts ?? {})) for (const t of c.terms ?? []) v.add(t);
  for (const [k, vs] of Object.entries(SE.ALIASES)) { v.add(k); vs.forEach((x) => v.add(x)); }
  return [...v];
}
/* k copies of a map under suffixed ids. Composition is identical by construction:
   every term's SHARE is exactly preserved, so a bucket that moves has moved on the
   denominator alone. */
function duplicated(tags, k) {
  const out = {};
  for (let n = 0; n < k; n++) for (const [id, t] of Object.entries(tags)) out[n ? `${id}--grow${n}` : id] = t;
  return { tags: out };
}
/* The pre-#275 rule, kept here as the WITNESS and nowhere else in this suite.
   Note what is NOT here: a local copy of the CURRENT rule. This suite re-derived
   `df > TOO_BROAD ? "drop" : df > COMMON ? "0.4x" : "full"` from the constants until
   review pointed out that reading the constants and rewriting the comparison is the
   #249 shape one level up -- swap the two branches in interpretQuery and a local copy
   would agree with the mistake. It calls SE.expansionBucket now. */
const absoluteBucket = (n) => (n > 60 ? "drop" : n > 25 ? "0.4x" : "full");
const absoluteMultiplier = (n) => (n <= 10 ? 1.35 : n <= 30 ? 1 : 0.75);

test("REAL REPO: growing the catalogue without changing it moves no bucket, and the absolute rule moved hundreds", () => {
  /* THE ASSERTION #275 EXISTS TO MAKE, and the one nothing in this repo made
     before: search quality must not change because the catalogue got bigger.
     Real tags, real vocabulary, and the corpus at three sizes that differ only in
     size -- so every expansion bucket and every score multiplier must be
     identical across all three. Under the absolute thresholds they are not.
     Measured on the FULL 1,561-entry map against the 1,366-term vocabulary,
     duplication moved 137 expansion buckets and 206 multipliers at 2x and 284 and
     494 at 4x. That is what "search quality changes silently every night" was,
     reproduced from the data rather than argued.

     RUN ON EVERY SECOND ENTRY, NOT THE WHOLE MAP, and the reason is runtime rather
     than doubt: tagCount is O(entries) per term, and the whole map at 1x + 2x + 4x
     is ~11 map-passes over 1,366 terms -- five minutes of CI for a claim that is
     scale-free by nature. Every second entry is a real 780-entry slice, so the
     three sizes are ~780 / ~1,560 / ~3,120 and the middle one is today's
     catalogue: the span brackets where the catalogue actually is rather than
     sitting under it. Going smaller than this is what a first draft did, and it
     broke the WITNESS rather than the claim -- at a 260-entry base the absolute
     rule moved only 12 buckets, because a sixth of every count clears 60 far less
     often, and a witness that weak cannot tell invariance from vacuity. The
     full-map figures above are quoted in search-engine.js and reproducible with
     tools/test-search.mjs.

     THE WITNESS IS NOT DECORATION. Without it this passes on an empty vocabulary,
     on a slice too small to cross any threshold, and on a tagDF that returns a
     constant -- three ways this repo has already gone green while asserting
     nothing.

     KILLED BY, and split by WHICH assertion kills it, because the two halves of this
     test catch different things and conflating them is how the first version of this
     comment overclaimed:
       the invariance assertions -- restoring any absolute threshold in
         interpretQuery or dfMultiplier, and dividing by any CONSTANT other than 1.
       the denominator assertions above -- `tagDF` returning `tagCount` undivided,
         and dividing by `discover.items.length` (which is `|| 1` here, so it reduces
         to the undivided case). Neither of those is caught by invariance, measured,
         for the reason the paragraph above the loop gives. */
  const itemTags = JSON.parse(fs.readFileSync(path.join(ROOT, "data/item-tags.json"), "utf8"));
  const terms = realVocabulary();
  const all = Object.entries(itemTags.tags);
  assert.ok(terms.length > 500, `vocabulary collapsed to ${terms.length} terms`);
  assert.ok(all.length > 600, `real tag map is only ${all.length} entries -- too small to be measuring anything`);
  const slice = Object.fromEntries(all.filter((_, k) => k % 2 === 0));

  const base = { itemTags: duplicated(slice, 1) };
  const baseline = new Map(terms.map((t) => {
    const df = SE.tagDF(t, base);
    return [t, [SE.expansionBucket(df), SE.dfMultiplier(df), SE.tagCount(t, base)]];
  }));
  assert.ok([...baseline.values()].some(([b]) => b !== "full"), "no term in the slice is even common enough to be demoted");

  /* THE DENOMINATOR, PINNED HERE AND NOT ONLY IN THE UNIT TEST AT THE TOP OF THIS
     FILE, because a mutation round found that INVARIANCE IS THE WRONG INSTRUMENT for
     the most obvious mutation of all. Make `tagDF` return the undivided count again
     and this test still passes: on a raw count `expansionBucket` answers "drop" for
     every n >= 1 and "full" only at 0, `dfMultiplier` answers 1.35 only at 0, and
     both of those are invariant under duplication BY CONSTRUCTION -- so movedExp and
     movedMul stay empty while the witnesses below still fire, and the flagship test
     of this change goes green on the defect it exists to catch. Measured, at 2x:
     movedExp 0, movedMul 0, witnesses 60 and 142.
     So the fraction is asserted directly, on the same corpus, for every term the
     slice actually covers. That is what turns the KILLED BY below into a claim about
     this test rather than about the file. */
  const sliceSize = Object.keys(slice).length;
  const covered = terms.filter((t) => SE.tagCount(t, base) > 0);
  assert.ok(covered.length > 50, `only ${covered.length} vocabulary terms appear in the slice at all`);
  for (const t of covered) {
    assert.equal(SE.tagDF(t, base), SE.tagCount(t, base) / sliceSize,
      `tagDF("${t}") is not its tagCount over the ${sliceSize} entries of the map it walked`);
  }

  for (const k of [2, 4]) {
    const grown = { itemTags: duplicated(slice, k) };
    assert.equal(Object.keys(grown.itemTags.tags).length, Object.keys(slice).length * k);

    const movedExp = [], movedMul = [], wasExp = [], wasMul = [];
    for (const t of terms) {
      const df = SE.tagDF(t, grown);
      const n = SE.tagCount(t, grown);
      const [wasBucket, wasMult, baseN] = baseline.get(t);
      if (SE.expansionBucket(df) !== wasBucket) movedExp.push(t);
      if (SE.dfMultiplier(df) !== wasMult) movedMul.push(t);
      if (absoluteBucket(baseN) !== absoluteBucket(n)) wasExp.push(t);
      if (absoluteMultiplier(baseN) !== absoluteMultiplier(n)) wasMul.push(t);
    }
    assert.deepEqual(movedExp, [], `at ${k}x, ${movedExp.length} term(s) changed expansion bucket on catalogue SIZE alone: ${movedExp.slice(0, 12).join(", ")}`);
    assert.deepEqual(movedMul, [], `at ${k}x, ${movedMul.length} term(s) changed score multiplier on catalogue SIZE alone: ${movedMul.slice(0, 12).join(", ")}`);
    assert.ok(wasExp.length > 20, `the absolute rule moved only ${wasExp.length} expansion buckets at ${k}x -- this test can no longer tell invariance from vacuity`);
    assert.ok(wasMul.length > 20, `the absolute rule moved only ${wasMul.length} multipliers at ${k}x -- witness too weak`);
  }
});

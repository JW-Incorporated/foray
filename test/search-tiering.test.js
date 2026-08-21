/* Unit tests for search-engine.js's rich/sparse/empty tiering -- classifyResults,
 * the relative strong bar, and the ranking prefix the narrow branch shows (#216).
 *
 * WHY THIS EXISTS, GIVEN tools/test-search.mjs ALREADY EXERCISES classifyResults
 * The battery runs whole queries against the live catalogue, which makes it a bad
 * net for this particular mechanism in one specific way: the disagreement #216
 * reports only reaches the PAGE on a query whose status is sparse or single-show,
 * and on main's pool today no such query has the disagreement at all. Measured
 * over every query the battery exercises (`node tools/test-search.mjs --tiering`,
 * 2026-08-18):
 * the inversion is live on five queries -- "nuclear fusion energy" (15 results),
 * "true crime cold case" (13), "plane crashes", "video games", "train history" (1
 * each) -- and every one of them is status "ok", where classifyResults passes the
 * whole `results` array through and the bar filters nothing. So the battery can
 * assert the defect is fixed only by asserting something that is currently true
 * anyway, and the issue's own witness needs a curation change (PR #211's
 * `music/jazz` on sticky-notes--gershwin-rhapsody) that is not on main.
 *
 * The witness therefore lives HERE, as the fixture the issue itself published,
 * with its real numbers. Fixtures also let the bar's scale-invariance be pinned,
 * which no live pool can do: it needs the same result shape at two different
 * absolute scales, and a catalogue only ever has one.
 *
 * WHAT THE BATTERY COVERS THAT THIS CANNOT: the coupling. Every fixture below is
 * hand-sorted, so these tests assume the comparator rather than checking it. If
 * searchWithRelaxation's sort changed, `strongPrefix` would still be a prefix of
 * whatever it was handed and every test here would stay green. That claim is
 * tools/test-search.mjs §9, over the live pool.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SE = require(path.join(ROOT, "search-engine.js"));

/* One row of searchWithRelaxation's output. `show` defaults to the id so that
   fixtures are multi-show by default -- diversify() caps at PER_SHOW_CAP per
   show, and a fixture that accidentally shared a show would be measuring the
   cap instead of the tiering. Fixtures are written in the comparator's own
   order (matched desc, then sum desc); classifyResults assumes that. */
const row = (id, matched, sum, show = id) =>
  ({ i: { id, show, topics: [] }, sum, matched, primaryMatched: matched });
const ids = (r) => r.picks.map((p) => p.i.id);

/* ---------- the defect #216 reports ---------- */

test("the shown set never drops a result the ranking places above one it keeps (#216)", () => {
  /* The issue's own measured example, verbatim: query "the history of jazz" with
     PR #211's `music/jazz` added to the Gershwin episode. raw1 matched BOTH
     query concepts and the comparator ranked it second; raw2 matched one and was
     shown in its place, because the bar (9.300 * 0.5 = 4.650) reads `sum` alone.
     Reproduced end-to-end against the live pool before the fix and it agreed to
     three decimals, which is why these numbers are used rather than round ones.

     KILLED BY: restoring `const candidates = (sparse || singleShow) ? strong :
     results` -- i.e. the defect itself. Also killed by the issue's first
     suggestion, a per-`matched`-tier bar: tier matched=2 tops out at 9.300, so
     its bar is still 4.650 and raw1 is still evicted. That is the measurement
     that ruled that option out, and this is where it is pinned. */
  const results = [
    row("gershwin-rhapsody", 2, 9.300),
    row("john-williams-a-composers-life", 2, 4.275),
    row("smartless--sting", 1, 5.400),
  ];
  const out = SE.classifyResults(results);
  assert.equal(out.status, "sparse");
  assert.deepEqual(ids(out), ["gershwin-rhapsody", "john-williams-a-composers-life", "smartless--sting"]);
});

test("prefix closure spans middle tiers, not just the top matched tier (#216)", () => {
  /* The other suggestion in #216 -- admit anything whose `matched` equals
     results[0].matched -- fixes the case above only because raw1 happens to sit
     in the top tier. Here the sub-bar result is one tier DOWN from the top and
     one tier UP from a clearer, which is the same defect with the tiers shifted.

     KILLED BY: `strong.concat(results.filter(x => x.matched === results[0].matched))`
     in place of strongPrefix -- "b" has matched=2 against a top tier of 3, so a
     top-tier rule leaves it out. */
  const results = [row("a", 3, 10), row("b", 2, 4.0), row("c", 1, 5.5)];
  const out = SE.classifyResults(results);
  assert.deepEqual(ids(out), ["a", "b", "c"]);
});

test("a sub-bar result ranked below every strong match stays out", () => {
  /* The fix is a prefix, not an amnesty. bar = 5; "a" and "c" clear it, so the
     prefix ends at "c" and admits "b" on the way. "d" ranks below every clearer
     and is still evicted -- the honest remaining limit, pinned so that widening
     it later is a deliberate act.

     KILLED BY: `return results.slice()` in strongPrefix, and by any `>= bar ||`
     amnesty that has no upper index. */
  const results = [row("a", 2, 10), row("b", 2, 4.9), row("c", 1, 6), row("d", 1, 1.0)];
  const out = SE.classifyResults(results);
  assert.deepEqual(ids(out), ["a", "b", "c"]);
  assert.equal(out.status, "sparse");
});

/* ---------- what the fix deliberately does NOT change ---------- */

test("a prefix-admitted result does not count toward RICH_MIN, so status cannot flip", () => {
  /* Five results clear the bar (5.0) and one sub-bar result sits inside the
     prefix, making six candidates. Six is RICH_MIN, and the status must still be
     sparse: `sparse` counts bar-CLEARERS, which is what makes this change
     provably status-neutral for every input. If it counted candidates instead,
     this query would flip to "ok", the candidate set would widen from the prefix
     to the whole `results` array, and "filler" -- ranked last, at a fifth of the
     bar -- would reach the page. That is the padding-vs-honesty failure the
     tiering exists to prevent, arriving through the fix for #216.

     KILLED BY: `const sparse = strongPrefix(results, bar).length < RICH_MIN`,
     which is the most plausible wrong way to write this change. */
  const results = [
    row("a", 2, 10), row("b", 2, 4.9),
    row("c", 1, 6), row("d", 1, 5.5), row("e", 1, 5.2), row("f", 1, 5.0),
    row("filler", 1, 1.0),
  ];
  const out = SE.classifyResults(results);
  assert.equal(out.status, "sparse");
  assert.deepEqual(ids(out), ["a", "b", "c", "d", "e", "f"]);
});

test("a prefix longer than the page falls back to the bar-clearers, so none is truncated out", () => {
  /* Found by review, and it is the #216 defect committed by the fix for #216.
     diversify() truncates at `cap` while the prefix is unbounded, so a long
     prefix does not just widen the answer -- it pushes bar-clearers off the end.
     Here: one top-tier result, twelve sub-bar results in the tier below it, and
     one genuine clearer beneath those. Unbounded, this returned status "sparse"
     over TEN picks, nine of them sub-bar, with "clearer2" gone -- padding, in the
     branch whose whole job is to refuse to pad.
     The bound is `prefix.length <= cap`, so this falls back to the clearers and
     matches main exactly.

     KILLED BY: dropping the `prefix.length <= cap` guard. */
  const results = [
    row("top", 3, 10),
    ...Array.from({ length: 12 }, (_, k) => row("sub" + k, 2, 4.9)),
    row("clearer2", 1, 6),
  ];
  const out = SE.classifyResults(results);
  assert.equal(out.status, "sparse");
  assert.deepEqual(ids(out), ["top", "clearer2"]);
});

test("a single-show answer keeps the bar-clearers, so the per-show cap cannot promote filler", () => {
  /* Also found by review, and the reason the two halves of the narrow branch are
     treated differently. When every clearer is one show, diversify()'s per-show
     cap DEFERS that show's own episodes, so any cross-show result in the
     candidate set is promoted over them -- the "Texas" leak dated 2026-07-30 in
     classifyResults' comment. Widening this half to the prefix handed it exactly
     the sub-bar cross-show results the leak is made of: measured, "texas" landed
     at rank 2, above five strong episodes of the show being searched for.
     Note the shows are set explicitly here. `row` defaults `show` to `id`, which
     made `singleShow` false in every other fixture in this file -- so before this
     test the branch had no coverage anywhere, in either suite. That gap is what
     let the regression above go green.

     FOUR CLEARERS, NOT SIX, AND THAT IS THE WHOLE TEST. The first version of this
     fixture had six, which is RICH_MIN, so `sparse` was false, so `widen` was
     false whatever the single-show guard said -- and the mutation that deletes
     that guard SURVIVED. The guard is only reachable when a query is sparse AND
     single-show, which is the state "how bbq works" was in before the catalogue
     grew, so the fixture has to be in it too. Caught by re-running the mutation
     round after the fix rather than by reading the fix.

     KILLED BY: dropping the `!singleShow` guard, which puts "texas" at index 1,
     above three strong episodes of the show being searched for. */
  const results = [
    row("bbq1", 2, 10, "bbqcentral"),
    row("texas", 2, 4.0, "casefile"),
    row("bbq2", 1, 6, "bbqcentral"), row("bbq3", 1, 5.8, "bbqcentral"),
    row("bbq4", 1, 5.4, "bbqcentral"),
  ];
  const out = SE.classifyResults(results);
  assert.equal(out.status, "sparse");
  assert.deepEqual(ids(out), ["bbq1", "bbq2", "bbq3", "bbq4"]);
});

test("the strong bar stays relative: the same shape at a tenth of the scale tiers the same", () => {
  /* Scale-invariance is the property that lets one rule cover both scoreMatch's
     ~2..16 range and the zero-content-token case, where `sum` comes from
     rankFallback at ~0..1 (a bare "comedy" or "something short"). The two
     fixtures differ by exactly 10x and must classify identically, including
     which result falls below the bar.

     KILLED BY: any absolute bar. `const bar = 4.65` leaves the big fixture
     alone and turns the small one empty, which is precisely the silent breakage
     the relative bar exists to avoid -- and the reason #216 must not be "fixed"
     by making the bar absolute. */
  const small = [row("a", 1, 0.9), row("b", 1, 0.6), row("c", 1, 0.2)];
  const big = [row("a", 1, 9.0), row("b", 1, 6.0), row("c", 1, 2.0)];
  const outSmall = SE.classifyResults(small);
  const outBig = SE.classifyResults(big);
  assert.equal(outSmall.status, outBig.status);
  assert.deepEqual(ids(outSmall), ids(outBig));
  /* And specifically: "c" is sub-bar in both and ranked below every clearer, so
     neither shows it. Without this the test would pass on two empty results. */
  assert.deepEqual(ids(outBig), ["a", "b"]);
});

test("fewer than two bar-clearing results is honestly empty", () => {
  /* The floor #216 must not lower. Only "a" clears a bar of 5, so the honest
     answer is nothing at all rather than a two-item list.
     The widening cannot reach this floor even by accident: a lone clearer can
     only ever be results[0], since results[0] clears by construction, so a
     one-clearer query always has a one-item prefix.

     KILLED BY: strongPrefix returning all results, which turns this into a
     two-item answer built on one strong match.
     NOT killed by lowering the guard itself to `strong.length < 1`, and that was
     measured rather than assumed -- the mutation survives. It is an equivalent
     mutation: by the paragraph above the prefix is one item, so diversify returns
     one pick and classifyResults' closing `picks.length < 2` guard returns empty
     regardless. Recorded here and beside the line in search-engine.js, because a
     "KILLED BY" claim nobody checked is worse than no claim. */
  const out = SE.classifyResults([row("a", 1, 10), row("b", 1, 2)]);
  assert.equal(out.status, "empty");
  assert.deepEqual(out.picks, []);
});

test("RICH_MIN bar-clearers is ok, one fewer is sparse", () => {
  /* Pins the sparse/ok boundary on the clearer count, and pins that the wide
     branch really is wide: at "ok" the sub-bar "filler" is a candidate, because
     `results` is passed whole. That asymmetry between the branches is deliberate
     -- see classifyResults' comment on sub-bar backfill breaking up an
     echo-chamber top-10 -- and it is what makes the prefix necessary only in the
     narrow branch.

     KILLED BY: moving RICH_MIN, and by narrowing the wide branch to the prefix
     (which would drop "filler" from the ok case). */
  const clearers = (n) => Array.from({ length: n }, (_, k) => row("c" + k, 1, 10 - k * 0.5));
  const withFiller = (n) => [...clearers(n), row("filler", 1, 1.0)];
  assert.equal(SE.classifyResults(withFiller(SE.RICH_MIN)).status, "ok");
  assert.equal(SE.classifyResults(withFiller(SE.RICH_MIN - 1)).status, "sparse");
  assert.ok(ids(SE.classifyResults(withFiller(SE.RICH_MIN))).includes("filler"));
  assert.ok(!ids(SE.classifyResults(withFiller(SE.RICH_MIN - 1))).includes("filler"));
});

/* ---------- the prefix itself, directly ---------- */

test("strongPrefix is exported and is the shortest prefix holding every clearer", () => {
  /* Asserted on the helper as well as through classifyResults, because
     tools/test-search.mjs §9 asserts the live-pool coupling against this same
     function -- an oracle and its subject must share the mechanism, which is the
     lesson tools/test-search.mjs records about reimplementing the matcher.
     Three claims, which together determine the set uniquely: it is a prefix, it
     holds every clearer, and it ENDS at a clearer (so it is the shortest such
     prefix).

     KILLED BY: `results.slice()` (fails the third), `results.filter(...)` (fails
     the first, since the returned array is not contiguous), `slice(0, last)`
     (fails the second). */
  const results = [row("a", 2, 10), row("b", 2, 4.9), row("c", 1, 6), row("d", 1, 1.0)];
  const bar = results[0].sum * SE.STRONG_RATIO;
  const prefix = SE.strongPrefix(results, bar);
  assert.deepEqual(prefix, results.slice(0, 3));
  assert.ok(results.every((x, k) => x.sum < bar || k < prefix.length), "every clearer is inside the prefix");
  assert.ok(prefix[prefix.length - 1].sum >= bar, "the prefix ends at a clearer");
});

test("strongPrefix is total and never empty, even against a bar nothing clears", () => {
  /* A list where everything clears is returned whole -- the common case on a rich
     query, and the claim that the prefix does not truncate a good result set.
     The third assertion is the one that needs explaining. classifyResults always
     passes a bar that results[0] clears, so from its side the loop's `last = 0`
     seed is unobservable and seeding `last = -1` is an EQUIVALENT MUTATION: it
     survives every test that goes through classifyResults, which is how it was
     caught -- by mutation, not by reading. Pinned here from outside that
     guarantee, on a bar nothing clears, because "never returns an empty
     candidate set" is a contract worth having whether or not today's only caller
     can violate its precondition.

     KILLED BY: seeding `last = -1`, which returns [] for the third case. */
  const all = [row("a", 1, 10), row("b", 1, 9), row("c", 1, 8)];
  assert.deepEqual(SE.strongPrefix(all, 5), all);
  assert.deepEqual(SE.strongPrefix(all, 9.5), [all[0]]);
  assert.deepEqual(SE.strongPrefix(all, 99), [all[0]]);
});

/* ---------- #301: the top result's own score is the whole hazard surface ---------- */

/* "meditation" on the 2026-08-21 pool, verbatim from the live ranker
   (`node tools/test-search.mjs --tiering` plus a per-result dump through the same
   harness): nine results, all matched=1, bar 4.050, two clearers, status sparse,
   two picks. Shows are set explicitly because four of the nine really are one
   show, and a fixture that spread them would be measuring a pool the ranker
   never returns. */
const MEDITATION = () => [
  row("huberman--meditation-to-focus", 1, 8.100, "huberman-lab"),
  row("ten-percent--ims-founders", 1, 5.400, "ten-percent-happier"),
  row("ten-percent--youre-gonna-be-alright", 1, 3.375, "ten-percent-happier"),
  row("ten-percent--self-help-without-other-people", 1, 3.375, "ten-percent-happier"),
  row("ten-percent--stop-fixing-yourself", 1, 3.375, "ten-percent-happier"),
  row("huberman--access-your-creativity", 1, 3.375, "huberman-lab"),
  row("philosophize-this--marcus-aurelius", 1, 2.700, "philosophize-this"),
  row("engines--1612", 1, 2.025, "engines-of-our-ingenuity"),
  row("engines--1617", 1, 2.025, "engines-of-our-ingenuity"),
];

test("improving the top result can empty a query, and that is #301 rather than a bug this suite fixes", () => {
  /* THIS TEST ASSERTS A DEFECT ON PURPOSE. It is the reproduction #301 asks for,
     pinned so the hazard is loud instead of silent, and it is NOT a statement
     that this is the behaviour anyone wants. If you change the grader so that
     improving one item can no longer delete its query's answer, THIS TEST MUST
     FAIL: read it, delete it, lower this suite's floor in
     test/suite-integrity.test.js from 13 to 12 in the same PR, and say so in
     #301. A green run here means the perverse incentive is still live -- the
     pipeline is still rewarded for leaving a thin topic's single best episode
     mislabelled.

     The numbers are PR #300's, measured: labelling Huberman's meditation episode
     `health/meditation` took it 8.100 -> 12.150 (+50%), the bar 4.050 -> 6.075,
     and Ten Percent Happier's 5.400 -- whose own relevance did not change, and
     which is a genuine mindfulness episode rather than a ranker false positive --
     fell out of the strong set. One clearer left, so `strong.length < 2` returns
     empty. Coverage went UP and the answer went to nothing.

     +34% would have been enough -- a bar of 5.427 leaves 5.400 out -- and the
     real edit was +50%.

     KILLED BY (both run, both fail this test):
       - `if (strong.length < 1)` plus `if (picks.length < 1)` -- direction 3 in
         the issue. Returns sparse with one pick instead of empty, so the
         `deepEqual([])` fails. It also turns two live battery checks red:
         "warriors" and "basketball" start answering with their lone coincidental
         match (an Ancients episode on Scotland's first warriors; a Freakonomics
         episode on depression that mentions basketball in passing).
       - `const bar = Math.min(results[0].sum, results[1] ? 2 * results[1].sum :
         results[0].sum) * STRONG_RATIO` -- direction 1, capping the bar's rise.
         The runner-up then clears by construction, so `after` stays sparse. It
         costs the honest-empty floor: "basketball" answers with the depression
         episode, and the battery says so. */
  const before = SE.classifyResults(MEDITATION());
  assert.equal(before.status, "sparse");
  assert.deepEqual(ids(before), ["huberman--meditation-to-focus", "ten-percent--ims-founders"]);

  const improved = MEDITATION();
  improved[0] = row("huberman--meditation-to-focus", 1, 12.150, "huberman-lab");
  const after = SE.classifyResults(improved);
  const fixed = "if this now returns an answer, #301 has been FIXED: delete this test, drop the floor to 12, and close the issue";
  assert.equal(after.status, "empty", fixed);
  assert.deepEqual(after.picks, [], fixed);

  /* Stated as the property it violates, so a failure names the mechanism rather
     than a status string. */
  assert.ok(after.picks.length < before.picks.length,
    "improving the best match reduced the pick count -- #301");
});

test("a result the ranking keeps below the top one cannot evict a bar-clearer, however much it improves (#301)", () => {
  /* The bound on #301, and the reason it is a hazard rather than a catastrophe:
     the bar reads `results[0].sum` and nothing else, so the only dangerous edit is
     one that raises the score of the result the ranking already places first.
     Improving anything the comparator still ranks BELOW that result can add it to
     the answer, reorder the answer, or flip the status up to "ok" -- it can never
     empty the query and never drop a result that clears the bar. That is what
     makes "improve the single best episode of a thin topic" the one curation move
     to think twice about, and it is the claim both robust-statistic options in
     #301 would have to give up.

     WHY "A BAR-CLEARER" AND NOT "A RESULT", which is where the first version of
     this test was wrong and the sweep said so: on `TIERED`, promoting the
     matched=1 result scoring 9 into the top tier at 9.99 takes the answer from
     three picks to two. What it loses is the 2.5 -- a SUB-BAR result that #216's
     widening was showing only because it sat between two clearers, and the
     promotion moves it out from between them. That is the widening's own rule
     working, not the bar evicting anything, so the assertion is about the
     clearers. Asserting the raw pick count instead would have pinned #216's
     widening as if it were #301's bound.

     "BELOW THE TOP ONE" IS LOAD-BEARING, not hedging. An improvement large enough
     to overtake results[0] makes the improved item results[0], and then the
     defect above is simply about it instead: on the fixture below, raising the
     runner-up from 5.400 to 20 empties the query. The sweep therefore raises a
     same-tier result only as far as the top score, and goes ABOVE it only for
     results in a LOWER `matched` tier, which the comparator keeps below the top
     however they score -- that is the case the bar must ignore, and the case a
     careless `Math.max(...results.map(x => x.sum))` would get wrong.

     Swept over two shapes, each row raised in its own matched tier and in the tier
     above (a topic label raises `matched` as well as `sum`, which is exactly what
     PR #300 did, so a sweep that only moved `sum` would miss the realistic edit).
     130 improvements; the counter at the bottom pins that.

     WHAT THIS TEST CAN AND CANNOT CATCH, and the line between them is provable
     rather than a measurement that might change. The assertion is about results
     that clear `results[0].sum * STRONG_RATIO`. Three of the four bar rewrites #301
     considers -- second-best, median, and the direction-1 clamp -- all anchor on a
     value that is at most the top score, so each produces a bar at most today's.
     A LOWER bar cannot evict anything, so none of them can be caught here, by
     construction and not by luck. They are caught where their cost really is, which
     is the honest-empty floor: the #301 test above and "fewer than two bar-clearing
     results is honestly empty" both go red on all three, and the battery goes red
     on the live pool.
     What this test is for is the other direction -- a rewrite that lets a result the
     ranking places BELOW the top one push the bar UP:

     KILLED BY: `const bar = Math.max(...results.map(x => x.sum)) * STRONG_RATIO`,
     which reads like a tidy-up of the line it replaces and is not one. It hands the
     bar to whichever result scores most, including one the comparator ranks below a
     clearer, and `TIERED` is the fixture where those differ. Before `TIERED` existed
     this mutation passed every unit test and all 123 battery checks -- found by
     review, not by this file.

     WHY BOTH FIXTURES, since only one carries that mutation. `MEDITATION` is the
     live shape the defect was measured on, so the property is swept over real
     numbers and not only over a shape built to break something; it also covers the
     single-tier case, where `Math.max(...)` and `results[0].sum` agree and the sweep
     must stay green. `TIERED` is the two-tier case. An earlier version had a third,
     `MEDIAN_SENSITIVE`, built to catch the median rewrite; it was deleted once the
     paragraph above showed no clearer-based assertion can catch that rewrite at all. */
  const sort = (rs) => rs.slice().sort((a, b) => b.matched - a.matched || b.sum - a.sum);
  /* `matched` dominates the comparator, so the two matched=1 rows stay below the
     matched=2 pair however high they score -- and 9 outscores the top result
     without being it, which is the only way to tell `results[0].sum` from
     `Math.max(...)`. The runner-up sits at 2.5, under half the top score, so the
     direction-1 clamp is ACTIVE here rather than a no-op; raising it to 9.99 takes
     the clamped bar 2.5 -> 5 and evicts the 4. Two clearers of the real bar (10
     and 9) with the 2.5 admitted between them, so this is also the only fixture
     where the #216 prefix actually widens. */
  const TIERED = () => [
    row("t-top", 2, 10), row("t-second", 2, 2.5),
    row("t-lower-tier-big", 1, 9), row("t-lower-tier-small", 1, 4),
  ];
  /* One line of classifyResults repeated on purpose, the same way the strongPrefix
     test below repeats it: the assertion is about which results CLEAR THE BAR, and
     a bar the test computes for itself is what makes a changed bar rule visible
     here instead of silently redefining the claim. If a future fix changes the
     rule, this test is meant to go red and be re-argued. */
  const clearersOf = (out, rows) => out.picks.filter((p) => p.sum >= rows[0].sum * SE.STRONG_RATIO).map((p) => p.i.id);
  let swept = 0;
  for (const fixture of [MEDITATION, TIERED]) {
    const base = SE.classifyResults(fixture());
    const baseClearers = clearersOf(base, fixture());
    const top = fixture()[0].sum;
    const topTier = fixture()[0].matched;
    for (let k = 1; k < fixture().length; k++) {
      const belowTopTier = fixture()[k].matched < topTier;
      /* Above `top` only where the comparator keeps the row below results[0]
         anyway; at or under `top` otherwise, per the paragraph above. */
      const targets = [top * 0.28, top * 0.45, top * 0.59, top * 0.6, top * 0.9, top * 0.999, top]
        .concat(belowTopTier ? [top * 1.1, top * 2, top * 4] : []);
      for (const target of targets) {
        for (const bumpTier of [0, 1]) {
          const rows = fixture();
          if (target <= rows[k].sum) continue;
          /* A promotion that would carry the row past the top tier while it also
             outscores the top result is the overtake case, not this one. */
          if (bumpTier && target > top && rows[k].matched + 1 >= topTier) continue;
          rows[k] = row(rows[k].i.id, rows[k].matched + bumpTier, target, rows[k].i.show);
          const out = SE.classifyResults(sort(rows));
          const what = `${rows[k].i.id} raised to ${target.toFixed(3)} (matched +${bumpTier})`;
          assert.notEqual(out.status, "empty", `improving ${what} emptied the query -- #301's bound is broken`);
          const shown = ids(out);
          for (const id of baseClearers) {
            assert.ok(shown.includes(id), `improving ${what} dropped ${id}, which clears the bar -- #301's bound is broken`);
          }
          swept++;
        }
      }
    }
  }
  /* Without this the loops could sweep nothing and the test would pass green,
     which is the failure mode this suite's header is about. Exact, not a floor:
     dropping either fixture changes it. */
  assert.equal(swept, 130, `swept ${swept} improvements, expected 130`);
});

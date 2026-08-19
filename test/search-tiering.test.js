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
     Note this floor cannot be reached through the widening even by accident: a
     lone clearer can only ever be results[0], since results[0] clears by
     construction, so a one-clearer query always has a one-item prefix.

     KILLED BY: `strong.length < 1`, and by strongPrefix returning all results
     with the floor moved onto the prefix. */
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

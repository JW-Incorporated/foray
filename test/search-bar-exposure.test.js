/* Unit test for the one half of #301 that is a PROPERTY rather than an accepted
 * defect, checked against the real catalogue: improving a result the ranking keeps
 * BELOW the top one must never empty its query and never drop a bar-clearer.
 *
 * WHY THIS IS A SEPARATE SUITE FROM test/search-tiering.test.js
 * That file is fixtures, by its own header, and it says why: fixtures are the only
 * place a score distribution can be held still while one number moves. What
 * fixtures cannot do is prove the distribution is REALISTIC. #301's whole subject
 * is what a curation edit does to a live query, and every quantity in it -- how far
 * the runner-up sits below the top, how many results share a `matched` tier, how
 * long the ranking is -- comes from the catalogue and moves every night. So the
 * bound is asserted twice: on fixtures, where it is exact and mutation-checked, and
 * here, over `data/*.json` through the same ranker the app calls.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT, because measuring it showed the
 * claim would be false or unstable:
 *
 *   THE DEFECT ITSELF. #301 is live: "meditation" returns two picks and a +34%
 *   improvement to its top result returns none. Asserting that here would be a
 *   tripwire on correct behaviour -- the day the catalogue gains a third strong
 *   meditation episode the exposure goes away and a passing test would go red for
 *   the best possible reason. tools/test-search.mjs records that failure mode three
 *   times ("assert the behaviour, never the count"), so the live numbers live in the
 *   PR and in classifyResults' comment, and the reproduction is a fixture.
 *
 *   THE PICK COUNT. On a long ranking #216's `prefix.length <= cap` fallback is
 *   reachable, and there an improvement legitimately shortens the answer: the
 *   widening stops and the honest clearers are what remain. A raw count would report
 *   that ruling as this defect. Hence "no clearer disappears" instead.
 *
 *   ANYTHING ON A TRUNCATED ANSWER, before OR after. Where `picks.length` reaches
 *   DEFAULT_CAP the page is full, so an improved result entering it pushes another
 *   out by `cap` and PER_SHOW_CAP rather than by the bar. Those runs keep the
 *   never-empty half only.
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

const discover = read("data/discover.json");
const itemTags = read("data/item-tags.json");
const semantic = read("data/semantic-index.json");
const session = read("data/session.json");
const validated = read("data/validated-links.json");

/* Mirrors app.js's fullPool() and tools/test-search.mjs's copy of it: the real
   client searches session.episodes + discover.items, deduped, and searching
   discover.items alone misses 27 session episodes including several top-scoring
   ones. This is a third copy of ~20 lines of plumbing and that is the lesser evil
   -- the thing that must never be copied is the MATCHER, and it is not: every
   score, bar and status below comes from search-engine.js itself. */
function fullPool() {
  const pool = [];
  const seen = new Set();
  for (const id of Object.keys(session.episodes)) {
    const ep = session.episodes[id];
    const v = validated?.episodes?.[id];
    const src = v ? { ...ep, artwork_url: v.artwork_url || ep.artwork_url || null } : ep;
    pool.push({
      id, show: src.show, title: src.title,
      apple_collection_id: src.apple_collection_id,
      duration_min: src.duration_min ?? null,
      topics: src.topics || [],
      hook: src.hook || src.summary || src.title,
    });
    seen.add(id);
  }
  for (const item of discover.items) if (!seen.has(item.id)) pool.push(item);
  return pool;
}
const pool = fullPool();

function rank(query) {
  const ctx = { semantic, itemTags, discover };
  const interp = SE.interpretQuery(query, ctx);
  return SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5).results;
}

/* NOT the battery's whole query list, and chosen rather than copied. Each ranking
   here costs ~230 ms and each result swept costs a re-classification, so the list is
   the queries that can actually exercise the bar, one line of reason each. (The
   battery's own list is in tools/test-search.mjs, which is a script on
   DENIED_PREFIXES; nothing here can read it.)

   SPARSE, so the bar decides what reaches the page and the answer is short enough
   for a dropped clearer to be visible rather than a `cap` artefact:
     "the history of jazz", "meditation", "politics", "nba", "stock market"
   HONESTLY EMPTY today, one coincidental match each -- they hold the "an already
   empty query may stay empty" edge that a naive version of this test got wrong:
     "warriors", "basketball"
   RANKING DISAGREES WITH THE SCORES (the --tiering report lists an inversion), so
   `results[0].sum` and `Math.max(...)` are different numbers and the sweep can tell
   a top-anchored bar from a max-anchored one:
     "plane crashes", "world war 2", "video games", "true crime cold case",
     "train history"
   LONG AND RICH, where the answer is truncated and only the never-empty half
   applies -- kept so the suite covers the branch where `candidates` is the whole
   result array:
     "comedy", "true crime", "how bbq works" */
const QUERIES = [
  "the history of jazz", "meditation", "politics", "nba", "stock market",
  "warriors", "basketball",
  "plane crashes", "world war 2", "video games", "true crime cold case",
  "train history",
  "comedy", "true crime", "how bbq works",
];

test("on the live catalogue, improving a result ranked below the top one never empties a query or drops a clearer (#301)", () => {
  /* The live half of test/search-tiering.test.js's bound. Same sweep shape: each
     non-top result raised toward and (where the comparator keeps it below the top
     regardless, i.e. in a lower `matched` tier) past the top score, in its own tier
     and in the tier above, because a topic label raises `matched` too.

     KILLED BY, run on 2026-08-21 rather than reasoned:
       - `const bar = Math.max(...results.map(x => x.sum)) * STRONG_RATIO`. Red on
         "the history of jazz", where the top-ranked result scores 5.250 and the
         highest-scoring one 5.400, so raising the latter moves a bar that must not
         move: at 21.000 the query empties.
       - `const bar = (results[1] ? results[1].sum : results[0].sum) * STRONG_RATIO`
         -- the second-best anchor. Red on "basketball".
     SURVIVED HERE, AND CAUGHT ON FIXTURES INSTEAD, which is the honest division of
     labour between this suite and test/search-tiering.test.js: the direction-1 clamp
     and the median anchor. Both need a shape where the clamped or median bar sits
     just under a clearer, and no query on today's pool is in that state within this
     sweep's reach. Fixtures are built to be in it; that is what they are for. A
     reader looking for the mutation coverage of those two should look there and not
     conclude from a green run here that nothing pins them.

     Measured here on 2026-08-21: 15 queries, 0 violations (the swept count is
     asserted at the bottom). Both of the exclusions in the header were found by
     THIS suite going red on correct behaviour -- an already-empty query staying
     empty, and "stock market" losing a clearer to the per-show cap -- which is the
     reason it exists next to the fixtures rather than instead of them.

     THE FIRST 8 NON-TOP RESULTS ONLY, at six target scores. The bar is set by
     results[0], so the sweep's job is to vary the OTHER end of a comparison with one
     moving part; the 9th result of "comedy" (186 of them) adds runtime, not
     evidence, and the sparse queries #301 actually bites are shorter than that
     anyway. Each extra result costs every query a full re-classification, which is
     where this suite's runtime goes. */
  const cap = SE.DEFAULT_CAP;
  const sort = (rs) => rs.slice().sort((a, b) => b.matched - a.matched || b.sum - a.sum);
  const barOf = (rs) => rs[0].sum * SE.STRONG_RATIO;
  let swept = 0;
  let truncated = 0;
  for (const query of QUERIES) {
    const results = rank(query);
    assert.ok(results.length > 0, `"${query}" returned nothing, so it is testing nothing`);
    const base = SE.classifyResults(results);
    /* "warriors" and "basketball" are honestly empty on today's pool -- one
       coincidental match each -- and an improvement that leaves them under the bar
       leaves them empty. The claim is that a query WITH an answer keeps one, so
       they contribute the clearer half of the sweep and not the never-empty half.
       They are kept in the list rather than dropped from it because which queries
       are in this state is a property of the catalogue, not of the code. */
    const hadAnswer = base.status !== "empty";
    /* Only meaningful where the page is not full -- see the header. */
    const pinnable = base.picks.length < cap;
    if (!pinnable) truncated++;
    const baseClearers = base.picks.filter((p) => p.sum >= barOf(results)).map((p) => p.i.id);
    const top = results[0].sum;
    const topTier = results[0].matched;
    for (let k = 1; k < Math.min(results.length, 9); k++) {
      const belowTopTier = results[k].matched < topTier;
      const targets = [top * 0.45, top * 0.9, top * 0.999, top]
        .concat(belowTopTier ? [top * 1.1, top * 4] : []);
      for (const target of targets) {
        for (const bumpTier of [0, 1]) {
          if (target <= results[k].sum) continue;
          /* An improvement that both overtakes the top result and joins its tier
             makes the improved item results[0]; that is the defect's own case, not
             this bound. Same exclusion as the fixture sweep. */
          if (bumpTier && target > top && results[k].matched + 1 >= topTier) continue;
          const rows = results.slice();
          rows[k] = { ...rows[k], sum: target, matched: rows[k].matched + bumpTier };
          const out = SE.classifyResults(sort(rows));
          const what = `"${query}": ${results[k].i.id} raised to ${target.toFixed(3)} (matched +${bumpTier})`;
          if (hadAnswer) {
            assert.notEqual(out.status, "empty", `${what} emptied the query -- #301's bound is broken`);
          }
          /* Both sides have to be un-truncated, not just the base. Measured on
             "stock market": promoting the matched=2 runner-up to matched=3 makes it
             results[0], which LOWERS the bar (3.949 * 0.5 against 8.775 * 0.5),
             flips the status to "ok", and hands diversify the whole 57-result pool
             -- so the page fills to 10 and the third Odd Lots episode is deferred by
             PER_SHOW_CAP with no room left to backfill. The query got richer and one
             clearer left the page: the per-show cap and `cap` decided that, not the
             bar, and #301 is a claim about the bar. */
          if (pinnable && out.picks.length < cap) {
            const shown = out.picks.map((p) => p.i.id);
            for (const id of baseClearers) {
              assert.ok(shown.includes(id), `${what} dropped ${id}, which clears the bar -- #301's bound is broken`);
            }
          }
          swept++;
        }
      }
    }
  }
  /* Non-vacuity, and the reason it is a floor rather than the measured 492: the
     catalogue grows nightly, so the exact count is not a claim anybody can keep
     true. What must stay true is that this ran over real rankings -- and that at
     least some of them were short enough for the clearer half to apply, which the
     second assertion is for. Both would go to zero together if the pool failed to
     load, which is the failure this catches. */
  assert.ok(swept >= 400, `swept only ${swept} improvements over ${QUERIES.length} queries`);
  assert.ok(truncated < QUERIES.length, "every query filled the page, so the clearer assertion never ran");
});

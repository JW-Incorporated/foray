/* PKG-35 (docs/roadmap/corpus.md §3): #279 drinks-wave candidate list. The
   four tests are the card's, with its fixed strings. The suite never reads
   data/: buildWave gets small in-memory stubs shaped like the real files
   (catalog-breadth.json rows, breadth-transcript-yield.json rows,
   dai-classification.json `shows` keyed by String(apple id)). No network,
   no database, no credential. Each test names the one-line mutation in
   wave-candidates.mjs that turns it red. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildWave, drinksFilter } from "./wave-candidates.mjs";

function breadthRow(overrides) {
  return {
    apple_collection_id: null,
    title: "Synthetic Wine Show",
    feed_url: "https://breadth.example/feed",
    apple_genre: "Food",
    chart_rank: 1,
    in_curated: false,
    tier: "breadth",
    ...overrides,
  };
}

/* (a) Mutation: drop "brewing" from DRINK_WORDS -> "Basic Brewing Radio"
   stops matching (no other word in it is on the list). "WhiskyCast" also
   pins the camelCase split in drinksFilter: mutation `return
   DRINKS_RE.test(String(title ?? ""))` (no splitCamel) -> it stops matching. */
test("drinksFilter matches the fixed drinks titles", () => {
  for (const title of ["WhiskyCast", "Basic Brewing Radio", "The Wine Show"]) {
    assert.equal(drinksFilter(title), true, title);
  }
});

/* (b) Mutation: replace the boundary groups with plain alternation
   (`new RegExp("(" + DRINK_WORDS.join("|") + ")", "i")`) -> "Imagine" matches
   gin, "Forum" matches rum, "Meadows" matches mead. */
test("drinksFilter does not match drink words inside other words", () => {
  for (const title of ["Imagine This", "Forum Daily", "Meadows of Heaven"]) {
    assert.equal(drinksFilter(title), false, title);
  }
});

/* (c) Row 1 has dai_prior false and 2 timed episodes; row 2 has dai_prior
   true and 50; row 3 has no DAI entry (null) and 9. The order must be
   false, null, true regardless of timed count. Mutation: compareWaveRows
   sorts by timed only (delete the `tier` lines) -> the 50-episode DAI row
   leads. */
test("dai_prior false sorts before null before true, ahead of timed episodes", () => {
  const breadth = {
    shows: [
      breadthRow({ apple_collection_id: 2, title: "Big Wine DAI", feed_url: "https://b.example/2" }),
      breadthRow({ apple_collection_id: 1, title: "Small Beer Clean", feed_url: "https://b.example/1" }),
      breadthRow({ apple_collection_id: 3, title: "Unknown Cider", feed_url: "https://b.example/3" }),
    ],
  };
  const yields = {
    shows: [
      { apple_collection_id: 1, feed_url: "https://b.example/1", episodes_with_timed_transcript: 2 },
      { apple_collection_id: 2, feed_url: "https://b.example/2", episodes_with_timed_transcript: 50 },
      { apple_collection_id: 3, feed_url: "https://b.example/3", episodes_with_timed_transcript: 9 },
    ],
  };
  const dai = { shows: { 1: { dai: false }, 2: { dai: true, ad_inflation: { verdict: "injected" } } } };
  const rows = buildWave({ breadth, yields, dai, catalog: { shows: [] } });
  assert.deepEqual(
    rows.map((r) => [r.apple_collection_id, r.dai_prior, r.timed_transcript_episodes]),
    [
      [1, false, 2],
      [3, null, 9],
      [2, true, 50],
    ],
  );
  assert.equal(rows[2].dai_measured, "injected");
  assert.equal(rows[1].dai_measured, null);
});

/* (d) Show 10 has a shows.jsonl row (itunes_id as pg's string), show 11 has
   none. english is true for 10 and null for 11, never true by default.
   Mutation: englishOf returns true for a missing row (`if (!showsRow) return
   true;`) -> show 11 reads true.
   The same fixture pins the PR #289 correction: show 12's breadth row says
   in_curated false (stale, as breadth does for PR #289's seven) while
   data/catalog.json carries its feed under another scheme, case and a
   trailing slash. Mutation: `in_curated: show.in_curated === true` (trust
   breadth) -> show 12 reads false; comparing raw feed URLs in indexBy
   (`const feed = String(feedOf(row) ?? "")`) does the same. */
test("english is null when no shows.jsonl row exists; in_curated comes from data/catalog.json", () => {
  const breadth = {
    shows: [
      breadthRow({ apple_collection_id: 10, title: "Corpus Wine Hour", feed_url: "https://c.example/10" }),
      breadthRow({ apple_collection_id: 11, title: "Orphan Gin Talk", feed_url: "https://c.example/11" }),
      breadthRow({ apple_collection_id: 12, title: "Curated Cider Chat", feed_url: "http://C.example/12/", in_curated: false }),
    ],
  };
  const catalog = { shows: [{ show_id: "curated-cider-chat", apple_collection_id: 999, feed_url: "https://c.example/12" }] };
  const shows = [{ itunes_id: "10", feed_url_normalized: "c.example/10", language: "en", timed_transcript_episodes: 4 }];
  const rows = buildWave({ breadth, yields: { shows: [] }, dai: { shows: {} }, shows, catalog });
  const byId = new Map(rows.map((r) => [r.apple_collection_id, r]));
  assert.equal(byId.get(10).english, true);
  assert.equal(byId.get(10).timed_transcript_episodes, 4);
  assert.equal(byId.get(11).english, null);
  assert.equal(byId.get(12).in_curated, true);
  assert.equal(byId.get(12).curated_show_id, "curated-cider-chat");
  assert.equal(byId.get(10).in_curated, false);
  assert.equal(buildWave({ breadth, catalog: { shows: [] } })[0].english, null);
});

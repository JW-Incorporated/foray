/* Tests for the breadth prioritiser (#114).
   Run: node --test tools/segments/

   WHY THESE TESTS AND NOT OTHERS. #313's lesson was that its politeness layer
   had three file headers describing it in detail and no test at all, and that
   both real bugs lived exactly there. This file's equivalent soft spot is the
   SHRINKAGE and the SAMPLING: both are a few characters of arithmetic that
   still produce a plausible-looking ranked list when they are wrong, so no
   amount of eyeballing the output catches them. A tranche ranked on unsmoothed
   rates looks fine and chases a sample of one; an explore arm drawn with the
   sort-by-random trick looks fine and is not uniform, which silently destroys
   the only unbiased estimate in the run.

   Each test names the one-line mutation that makes it fail, and each was run
   against that mutation before being committed (CLAUDE.md § "A green test is
   not evidence until you have broken it"). */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RATE_PRIOR_STRENGTH,
  SHOW_PRIOR_STRENGTH,
  capByHost,
  daiRatesFrom,
  eligibleShows,
  hostHitRate,
  hostKeyOf,
  hostPriors,
  hostTimedFraction,
  rankShows,
  rng,
  scoreShow,
  stratifiedTranche,
  sweptFeedUrls,
  trancheCatalog,
  usableEpisodeCount,
} from "./rank-breadth.mjs";

/** A swept show record, in the shape sweep-transcripts.mjs writes. */
const show = (feed_url, { total = 100, timed = 0, status = "ok", dai = null, title = null } = {}) => ({
  show_id: `s-${feed_url}`,
  title,
  feed_url,
  status,
  dai_suspected: dai,
  episodes_total: total,
  episodes_with_transcript: timed,
  episodes_with_timed_transcript: timed,
});

const index = (shows) => ({ shows });

/* -------------------------------------------------------------- host keys */

/* MUTATION: return `new URL(u).host` instead of the last two labels. Each
   platform's evidence then splits across its subdomains — buzzsprout alone
   appears as `rss.`, `feeds.` and `www.` — so every platform looks like a
   sample of one or two and shrinkage pulls all of them back to the global
   rate. The ranking silently degenerates into ranking by episode_count.
   Verified failing. */
test("one platform is one prior, whatever subdomain the feed is on", () => {
  assert.equal(hostKeyOf("https://feeds.buzzsprout.com/995575.rss"), "buzzsprout.com");
  assert.equal(hostKeyOf("https://rss.buzzsprout.com/995575.rss"), "buzzsprout.com");
  assert.equal(hostKeyOf("https://www.omnycontent.com/d/playlist/x.rss"), "omnycontent.com");
  assert.equal(hostKeyOf("https://anchor.fm/s/abc/podcast/rss"), "anchor.fm");
});

/* MUTATION: drop the try/catch and let `new URL` throw. One malformed
   `feed_url` in a 19,000-row catalogue then aborts the whole ranking run.
   Verified failing. */
test("an unparseable feed url is a bucket, not an exception", () => {
  assert.equal(hostKeyOf("not a url"), "unknown");
  assert.equal(hostKeyOf(null), "unknown");
  assert.equal(hostKeyOf(undefined), "unknown");
});

/* ----------------------------------------------------------------- priors */

/* MUTATION: remove the `if (s.status !== "ok") continue` guard. Feeds that
   404'd or timed out then count as shows that DO NOT transcribe, so a platform
   with many dead feeds is scored as a platform that does not publish
   transcripts — a fact about our URL list read as a fact about the publisher.
   Verified failing. */
test("a failed feed is evidence about a URL, not about the platform", () => {
  const priors = hostPriors(
    index([
      show("https://rss.example.com/a", { timed: 50 }),
      show("https://rss.example.com/b", { status: "error" }),
      show("https://rss.example.com/c", { status: "error" }),
    ]),
  );
  assert.equal(priors.shows, 1);
  assert.equal(priors.hosts.get("example.com").shows, 1);
  assert.equal(priors.hosts.get("example.com").shows_with_timed, 1);
});

/* MUTATION: count a hit on `episodes_with_transcript > 0` rather than
   `episodes_with_timed_transcript > 0`. Prose transcripts cannot anchor a
   segment (ADR-0007), so a platform that ships nothing but `text/plain` would
   be ranked as a top target and every request spent on it returns something
   no downstream lane can use. Verified failing. */
test("only TIMED transcripts count as a hit", () => {
  const prose = { ...show("https://rss.example.com/a"), episodes_with_transcript: 90, episodes_with_timed_transcript: 0 };
  const priors = hostPriors(index([prose]));
  assert.equal(priors.hits, 0);
  assert.equal(priors.hosts.get("example.com").shows_with_timed, 0);
});

/* MUTATION: set SHOW_PRIOR_STRENGTH to 0 (or drop the `strength *
   global_hit_rate` term). This is THE load-bearing line: a host seen once, and
   hitting once, then scores 1.0 and outranks a host measured at 10-of-12, so
   the entire tranche chases a sample of one. The unsmoothed numbers are 1.000
   vs 0.833; the smoothed ones must be the other way round. Verified failing.

   THE FIXTURE'S SHAPE IS PART OF THE TEST, and the first version of it was
   wrong in a way worth recording. It contained only the two hosts, so the
   global hit rate was 11/13 = 0.85, and shrinking toward 0.85 pulled the 1-of-1
   host UP to 0.87 while pulling the 10-of-12 host DOWN to 0.84 — the 1-of-1
   still won, with the shrinkage working exactly as designed. Shrinkage is
   toward the POPULATION, so it only demotes a lucky singleton when the
   population is mostly misses. The real catalogue's global rate is 12.3%, so
   the misses below are the realistic condition and not padding: solid scores
   0.62 against lucky's 0.26 there. A fixture that omits them tests a world
   this ranker does not run in. */
test("a 1-of-1 host does not outrank a 10-of-12 host", () => {
  const shows = [show("https://a.lucky.com/f", { timed: 5, total: 10 })];
  for (let i = 0; i < 12; i++) shows.push(show(`https://a.solid.com/${i}`, { timed: i < 10 ? 80 : 0, total: 100 }));
  // The rest of the catalogue, which is overwhelmingly misses (measured: 27 of
  // 219 curated shows carry a timed transcript).
  for (let i = 0; i < 90; i++) shows.push(show(`https://a.quiet${i}.com/f`, { timed: 0, total: 100 }));
  const priors = hostPriors(index(shows));

  assert.ok(SHOW_PRIOR_STRENGTH > 0, "shrinkage strength must be positive or nothing below holds");
  assert.ok(priors.global_hit_rate < 0.2, "fixture must resemble the real catalogue's miss-heavy population");
  assert.equal(priors.hosts.get("lucky.com").shows_with_timed / priors.hosts.get("lucky.com").shows, 1);
  assert.ok(
    hostHitRate(priors, "solid.com") > hostHitRate(priors, "lucky.com"),
    `solid ${hostHitRate(priors, "solid.com")} must beat lucky ${hostHitRate(priors, "lucky.com")}`,
  );
});

/* MUTATION: return 0 (or 1) for a host with no observations instead of the
   global rate. Returning 0 means no unmeasured platform can ever enter the
   exploit arm, so the ranking can only ever re-harvest hosts we have already
   swept and the catalogue's other 6,000 shows on unmeasured platforms stay
   permanently invisible. Verified failing. */
test("a platform we have never read scores exactly the global rate", () => {
  const priors = hostPriors(index([show("https://a.known.com/1", { timed: 10 }), show("https://a.known.com/2")]));
  assert.equal(hostHitRate(priors, "never-seen.example"), priors.global_hit_rate);
  assert.equal(hostTimedFraction(priors, "never-seen.example"), priors.global_timed_fraction);
});

/* MUTATION: average the within-show timed fraction over ALL shows rather than
   over hitting shows only. Every platform's fraction is then dragged toward
   zero by its misses, which double-counts the miss (it is already in
   hostHitRate) and flattens the difference between a platform that transcribes
   its whole back catalogue and one that transcribes three episodes.
   Verified failing. */
test("the within-show fraction is averaged over hitting shows, not all shows", () => {
  const priors = hostPriors(
    index([
      show("https://a.host.com/1", { timed: 100, total: 100 }),
      show("https://a.host.com/2", { timed: 0, total: 100 }),
      show("https://a.host.com/3", { timed: 0, total: 100 }),
    ]),
  );
  // One hitting show at 1.0, shrunk toward a global that is also 1.0.
  assert.equal(priors.hosts.get("host.com").rate_sum, 1);
  assert.equal(hostTimedFraction(priors, "host.com"), 1);
  assert.ok(RATE_PRIOR_STRENGTH > 0);
});

/* ---------------------------------------------------------------- scoring */

/* MUTATION: drop the `Math.min(v, 5000)` clamp, or return `v` for a
   non-finite/zero count. Apple's `episode_count` is a claim; a null becomes
   NaN, and NaN sorts unpredictably in `rankShows`, so a handful of malformed
   rows scatter through the ranked list at arbitrary positions.
   Verified failing. */
test("episode_count is clamped and never produces NaN", () => {
  assert.equal(usableEpisodeCount(null), 1);
  assert.equal(usableEpisodeCount(undefined), 1);
  assert.equal(usableEpisodeCount("nope"), 1);
  assert.equal(usableEpisodeCount(0), 1);
  assert.equal(usableEpisodeCount(-5), 1);
  assert.equal(usableEpisodeCount(120), 120);
  assert.equal(usableEpisodeCount(9_999_999), 5000);
});

/* MUTATION: drop `episodes` from the product in `scoreShow`. The score becomes
   a per-episode probability, so a 12-episode show on a good platform ties with
   a 2,000-episode show on the same platform — and the request budget is spent
   per FEED, which is exactly the quantity the multiplication accounts for.
   Verified failing. */
test("expected yield scales with the show's episode count", () => {
  const priors = hostPriors(index([show("https://a.good.com/1", { timed: 90, total: 100 })]));
  const small = scoreShow({ feed_url: "https://a.good.com/x", episode_count: 10 }, priors);
  const large = scoreShow({ feed_url: "https://a.good.com/y", episode_count: 1000 }, priors);
  assert.ok(large.expected_timed > small.expected_timed * 50, `${large.expected_timed} vs ${small.expected_timed}`);
});

/* MUTATION: rank on `expected_anchorable` instead of `expected_timed`, i.e.
   apply the DAI haircut to the ORDER rather than reporting it. That bakes in
   the assumption that the ad-inflation scan will never reclassify anything,
   and AD_FREE_SHOWS is already three measured counterexamples. This test pins
   that anchorability is REPORTED and not silently folded into the rank.
   Verified failing. */
test("the DAI haircut is reported alongside the score, not folded into it", () => {
  const priors = hostPriors(index([show("https://a.good.com/1", { timed: 90, total: 100, dai: true })]));
  const dai = daiRatesFrom(index([show("https://a.good.com/1", { timed: 90, total: 100, dai: true })]));
  const s = scoreShow({ feed_url: "https://a.good.com/x", episode_count: 100 }, priors, { daiRates: dai });
  assert.ok(s.expected_timed > 0);
  assert.ok(s.expected_anchorable < s.expected_timed, "the haircut must actually cut");
  const noDai = scoreShow({ feed_url: "https://a.good.com/x", episode_count: 100 }, priors);
  assert.equal(noDai.expected_timed, s.expected_timed, "the rank quantity must not depend on the DAI table");
  assert.equal(noDai.expected_anchorable, null);
});

/* ------------------------------------------------------------ eligibility */

/* MUTATION: dedupe on `apple_collection_id` instead of `feed_url`, or drop the
   `.toLowerCase()`. 187 breadth rows are the same feed charting under two
   genres with two Apple ids; sweeping one twice is a wasted polite request and
   a duplicated row in the yield denominator. Verified failing. */
test("the pool is deduped on the feed URL and excludes curated and swept feeds", () => {
  const pool = eligibleShows(
    [
      { apple_collection_id: 1, feed_url: "https://h.example/a" },
      { apple_collection_id: 2, feed_url: "https://H.EXAMPLE/a" }, // same feed, second chart
      { apple_collection_id: 3, feed_url: "https://h.example/b", in_curated: true },
      { apple_collection_id: 4, feed_url: null },
      { apple_collection_id: 5, feed_url: "https://h.example/c" },
    ],
    { alreadySweptFeeds: new Set(["https://h.example/c"]) },
  );
  assert.deepEqual(pool.map((s) => s.apple_collection_id), [1]);
});

/* MUTATION: skip errored shows when building `sweptFeedUrls`. A feed that
   timed out three times is then re-queued in every future tranche, so the
   dead tail of the catalogue is re-hammered forever — three requests per
   tranche per dead feed, aimed at hosts that already failed to answer.
   Verified failing. */
test("a feed that failed still counts as swept, so it is not re-hammered", () => {
  const urls = sweptFeedUrls(index([show("https://a.dead.com/x", { status: "error" })]));
  assert.ok(urls.has("https://a.dead.com/x"));
});

/* ------------------------------------------------------------------- caps */

/* MUTATION: remove the `n >= hostCap` branch. The ranked head becomes 300
   shows on one platform (measured: the real catalogue's top 300 are all
   omnycontent.com), so the tranche prices exactly one host and discovers
   nothing about the other platforms in the catalogue. Verified failing. */
test("the exploit arm is capped per platform and keeps rank order", () => {
  const priors = hostPriors(index([show("https://a.big.com/1", { timed: 90, total: 100 })]));
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push({ apple_collection_id: `big-${i}`, feed_url: "https://a.big.com/f", episode_count: 1000 - i });
  for (let i = 0; i < 10; i++) pool.push({ apple_collection_id: `sml-${i}`, feed_url: "https://a.small.com/f", episode_count: 500 - i });
  const ranked = rankShows(pool, priors);
  const { head } = capByHost(ranked, { exploit: 6, hostCap: 3 });

  assert.equal(head.length, 6);
  assert.equal(head.filter((r) => r.score.host_key === "big.com").length, 3);
  assert.equal(head.filter((r) => r.score.host_key === "small.com").length, 3);
  // Rank order preserved within a host: the cap skips, it does not reorder.
  const bigIds = head.filter((r) => r.score.host_key === "big.com").map((r) => r.show.apple_collection_id);
  assert.deepEqual(bigIds, ["big-0", "big-1", "big-2"]);
});

/* MUTATION: return only the below-the-cut rows from `capByHost` as `rest`,
   dropping the capped-out ones. The explore arm is then drawn from a pool with
   the dominant platform's best shows deliberately removed, so the one
   "unbiased population estimate" in the entire run is biased against exactly
   the platform we most need a second read on. Verified failing. */
test("rows skipped by the cap stay eligible for the random arm", () => {
  const priors = hostPriors(index([show("https://a.big.com/1", { timed: 90, total: 100 })]));
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push({ apple_collection_id: `big-${i}`, feed_url: "https://a.big.com/f", episode_count: 1000 - i });
  const ranked = rankShows(pool, priors);
  const { head, rest } = capByHost(ranked, { exploit: 8, hostCap: 2 });
  assert.equal(head.length, 2);
  assert.equal(rest.length, 8, "the other 8 must remain in the sampling pool");
});

/* ------------------------------------------------------------- the sample */

/* MUTATION: use `Math.random` in `stratifiedTranche`. A killed run then
   resumes onto a DIFFERENT random sample, so the two halves cannot be pooled
   and the explore estimate is unrecoverable after any interruption — the exact
   failure the checkpointing elsewhere in this pipeline exists to prevent.
   Verified failing. */
test("the same seed always produces the same tranche", () => {
  const priors = hostPriors(index([show("https://a.h.com/1", { timed: 10 })]));
  const pool = Array.from({ length: 60 }, (_, i) => ({ apple_collection_id: i, feed_url: `https://a.h${i % 6}.com/f`, episode_count: 100 }));
  const ranked = rankShows(pool, priors);
  const opts = { exploit: 10, explore: 10, seed: "fixed", hostCap: 5 };
  const a = stratifiedTranche(ranked, opts).map((e) => `${e.arm}:${e.show.apple_collection_id}`);
  const b = stratifiedTranche(ranked, opts).map((e) => `${e.arm}:${e.show.apple_collection_id}`);
  assert.deepEqual(a, b);
  const c = stratifiedTranche(ranked, { ...opts, seed: "other" }).map((e) => `${e.arm}:${e.show.apple_collection_id}`);
  assert.notDeepEqual(a, c, "a different seed must give a different sample");
});

/* MUTATION: make `rng` ignore its seed (`let a = 0` regardless of input).
   Every tranche then draws the identical sample, so tranche 2's explore arm
   re-measures tranche 1's explore arm and the run learns nothing new.
   Verified failing. */
test("rng is seeded, bounded, and different seeds diverge", () => {
  const a = rng("one"), b = rng("one"), c = rng("two");
  const draw = (f) => Array.from({ length: 20 }, () => f());
  const A = draw(a);
  assert.deepEqual(A, draw(b));
  assert.notDeepEqual(A, draw(c));
  for (const v of A) assert.ok(v >= 0 && v < 1, `${v} out of range`);
});

/* MUTATION: replace the partial Fisher-Yates with `tail.slice().sort(() =>
   next() - 0.5).slice(0, take)`, the sort-by-random trick, or drop the `i +`
   offset from the swap index. Both still return `take` distinct rows and both
   are non-uniform, so the explore arm quietly stops being a population sample
   while continuing to look exactly like one. This test rejects a sampler whose
   inclusion probabilities are skewed. Verified failing on both mutations. */
test("the explore arm is a uniform sample, not merely a random-looking one", () => {
  const priors = hostPriors(index([show("https://a.h.com/1", { timed: 10 })]));
  // One host, identical scores: rank order is then the tiebreak, so any
  // non-uniformity in the sampler shows up as a skew over these 8 rows.
  const pool = Array.from({ length: 8 }, (_, i) => ({ apple_collection_id: `p${i}`, feed_url: "https://a.h.com/f", episode_count: 100 }));
  const ranked = rankShows(pool, priors);

  const counts = new Map(pool.map((p) => [p.apple_collection_id, 0]));
  const TRIALS = 4000;
  for (let s = 0; s < TRIALS; s++) {
    const t = stratifiedTranche(ranked, { exploit: 0, explore: 3, seed: `seed-${s}`, hostCap: Infinity });
    const drawn = t.filter((e) => e.arm === "explore").map((e) => e.show.apple_collection_id);
    assert.equal(new Set(drawn).size, 3, "a sample must not repeat a row");
    for (const id of drawn) counts.set(id, counts.get(id) + 1);
  }
  const expected = (TRIALS * 3) / 8;
  for (const [id, n] of counts) {
    assert.ok(
      n > expected * 0.85 && n < expected * 1.15,
      `${id} drawn ${n} times, expected ~${expected} — the sampler is not uniform`,
    );
  }
});

/* MUTATION: draw the explore arm from `ranked` rather than from the rows the
   head did not take. The arms then overlap, the same feed is swept twice, and
   the "independent" explore estimate is contaminated with the shows we
   deliberately selected as winners. Verified failing. */
test("the two arms are disjoint", () => {
  const priors = hostPriors(index([show("https://a.h.com/1", { timed: 10 })]));
  const pool = Array.from({ length: 40 }, (_, i) => ({ apple_collection_id: i, feed_url: `https://a.h${i % 4}.com/f`, episode_count: 100 + i }));
  const ranked = rankShows(pool, priors);
  const entries = stratifiedTranche(ranked, { exploit: 10, explore: 10, seed: "x", hostCap: 4 });
  const exploit = new Set(entries.filter((e) => e.arm === "exploit").map((e) => e.show.apple_collection_id));
  const explore = entries.filter((e) => e.arm === "explore").map((e) => e.show.apple_collection_id);
  assert.equal(explore.length, 10);
  for (const id of explore) assert.ok(!exploit.has(id), `${id} is in both arms`);
});

/* MUTATION: emit `id` instead of `show_id`, or omit `feed_url`, from
   `trancheCatalog`. sweep-transcripts.mjs filters on `feed_url` and keys its
   checkpoint on `show_id ?? apple_collection_id`, so a renamed field produces
   either "NO_SHOWS: yielded zero shows with a feed_url" or a checkpoint that
   cannot resume. Verified failing. */
test("the tranche is in the shape sweep-transcripts.mjs actually reads", () => {
  const cat = trancheCatalog([
    { show: { apple_collection_id: 42, title: "T", feed_url: "https://a.h.com/f", episode_count: 9 }, score: { host_key: "h.com", expected_timed: 1 }, arm: "exploit" },
  ]);
  assert.equal(cat.shows.length, 1);
  assert.equal(cat.shows[0].show_id, "42");
  assert.equal(cat.shows[0].feed_url, "https://a.h.com/f");
  assert.equal(cat.shows[0].arm, "exploit");
  assert.ok(cat.shows.every((s) => s.feed_url), "every row must survive the sweep's feed_url filter");
});

/* MUTATION: rank ascending, or drop the tiebreak chain. An ascending sort
   spends the whole budget on the catalogue's worst shows while every log line
   still reads like a normal run. Verified failing. */
test("ranking is descending and total", () => {
  const priors = hostPriors(index([show("https://a.h.com/1", { timed: 50, total: 100 })]));
  const pool = [
    { apple_collection_id: "b", feed_url: "https://a.h.com/f", episode_count: 10 },
    { apple_collection_id: "a", feed_url: "https://a.h.com/f", episode_count: 1000 },
    { apple_collection_id: "c", feed_url: "https://a.h.com/f", episode_count: 10 },
  ];
  const ranked = rankShows(pool, priors);
  assert.equal(ranked[0].show.apple_collection_id, "a");
  // Equal scores AND equal episode counts fall back to the id, so the file is
  // byte-stable across runs.
  assert.deepEqual(ranked.slice(1).map((r) => r.show.apple_collection_id), ["b", "c"]);
});

/* MUTATION: add `await fetch(url)` — bare or qualified — anywhere in
   rank-breadth.mjs. The header spends a paragraph on why a ranker with a
   network path would be a second, unthrottled route into publishers' hosts,
   outside the shared politeness gate, and until this test existed that
   paragraph was the only thing enforcing it. The sibling report has the same
   guard; this one was the gap a reviewer found. Verified failing against both
   `fetch(` and `globalThis.fetch(`. */
test("the ranker has no network path at all", () => {
  const src = readFileSync(new URL("./rank-breadth.mjs", import.meta.url), "utf8");
  assert.deepEqual(src.match(/(?<!\w)fetch\s*\(/g), null);
  assert.deepEqual(src.match(/(?<!\w)(?:request|get)\s*\(\s*["'`]?https?:/g), null);
  assert.equal(/politeness\.mjs/.test(src), false, "nothing to be polite about — it makes no requests");
  // Only node builtins. A transitive import is a transitive network path.
  const imports = [...src.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:fs", "node:url", "node:path"]);
});

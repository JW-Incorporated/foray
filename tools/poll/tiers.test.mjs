/* Cadence tiers for the S-10 watchlist poller (tools/poll/tiers.mjs, PKG-05).
   Run:
   node --test tools/poll/tiers.test.mjs

   Every test names the one-line mutation that turns it red; each was applied to
   tiers.mjs, confirmed changed on disk, and seen to fail this suite. The rules
   under test are stated in tiers.mjs's header; ADR-0001 names the tiers. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TIER_INTERVAL_MS,
  TIERS,
  tierFromMeanGapDays,
  seedTier,
  correctTier,
  applySuccess,
  applyFailure,
  nextDueAt,
} from "./tiers.mjs";

const DAY_S = 86_400;
const DAY_MS = 86_400_000;
const NOW_MS = Date.UTC(2026, 9, 1); // 2026-10-01T00:00:00Z, fixed so no test reads the clock
const NOW_S = NOW_MS / 1000;

/** Publish times (ms) whose consecutive gaps are exactly `gapsDays`. */
const timesFromGaps = (gapsDays, start = NOW_MS - 365 * DAY_MS) => {
  const out = [start];
  for (const g of gapsDays) out.push(out[out.length - 1] + g * DAY_MS);
  return out;
};

const fresh = (over = {}) => ({ consecutiveFailures: 0, tier: "daily", state: "active", firstNotFoundAtMs: null, ...over });

test("gap thresholds map to the tiers at their edges", () => {
  // MUTATION: `if (gapDays <= 4) return "daily";` -> `< 4` -> 4 maps to weekly.
  assert.equal(tierFromMeanGapDays(0.5), "hourly");
  assert.equal(tierFromMeanGapDays(0.51), "several_daily");
  assert.equal(tierFromMeanGapDays(1.5), "several_daily");
  assert.equal(tierFromMeanGapDays(1.51), "daily");
  assert.equal(tierFromMeanGapDays(4), "daily");
  assert.equal(tierFromMeanGapDays(4.01), "weekly");
  for (const bad of [null, undefined, Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(tierFromMeanGapDays(bad), "weekly", `gap ${bad} must be weekly`);
  }
});

test("seedTier reads unix seconds, not ms", () => {
  // MUTATION: drop `/ DAY_S` from the meanGapDays expression -> meanGapDays ~174,545, weekly.
  const oldest = NOW_S - 210 * DAY_S;
  const newest = oldest + 200 * DAY_S;
  const r = seedTier({ episodeCount: 100, oldestItemPubdate: oldest, newestItemPubdate: newest }, NOW_MS);
  assert.ok(Math.abs(r.meanGapDays - 200 / 99) < 1e-9, `meanGapDays ${r.meanGapDays}`);
  assert.equal(r.tier, "daily");

  // The same history mistakenly passed as ms is a 1000x longer gap: not ~2.02, so not daily.
  const asMs = seedTier(
    { episodeCount: 100, oldestItemPubdate: oldest * 1000, newestItemPubdate: newest * 1000 },
    NOW_MS,
  );
  assert.ok(Math.abs(asMs.meanGapDays - 200 / 99) > 1, `ms inputs gave ${asMs.meanGapDays}`);
  assert.equal(asMs.tier, "weekly");

  // No usable history -> meanGapDays null, weekly.
  for (const bad of [
    { episodeCount: 1, oldestItemPubdate: oldest, newestItemPubdate: newest },
    { episodeCount: 100, oldestItemPubdate: newest, newestItemPubdate: oldest },
    { episodeCount: 100, oldestItemPubdate: null, newestItemPubdate: null },
  ]) {
    assert.deepEqual(seedTier(bad, NOW_MS), { tier: "weekly", meanGapDays: null });
  }
});

test("curated shows are never slower than daily", () => {
  // MUTATION: delete the `if (watchReasons.some(...)) tier = fasterTier(tier, "daily");` line -> weekly.
  const noHistory = { episodeCount: null, oldestItemPubdate: null, newestItemPubdate: null };
  assert.equal(seedTier(noHistory, NOW_MS).tier, "weekly");
  assert.equal(seedTier({ ...noHistory, watchReasons: ["curated"] }, NOW_MS).tier, "daily");
  assert.equal(seedTier({ ...noHistory, watchReasons: ["curation_candidate"] }, NOW_MS).tier, "daily");
  assert.equal(seedTier({ ...noHistory, watchReasons: ["changed_in_dump"] }, NOW_MS).tier, "weekly");
  // The lift never SLOWS a faster show: a curated hourly show stays hourly.
  const hourlyHistory = { episodeCount: 49, oldestItemPubdate: NOW_S - 13 * DAY_S, newestItemPubdate: NOW_S - DAY_S };
  assert.equal(seedTier({ ...hourlyHistory, watchReasons: ["curated"] }, NOW_MS).tier, "hourly");
});

test("a 24-month-stale show is weekly whatever its history", () => {
  // MUTATION: delete the `nowMs / 1000 - newestItemPubdate > STALE_AFTER_S` line -> hourly.
  const history = (newestAgoDays) => ({
    episodeCount: 49,
    oldestItemPubdate: NOW_S - (newestAgoDays + 12) * DAY_S,
    newestItemPubdate: NOW_S - newestAgoDays * DAY_S,
    watchReasons: ["curated"],
  });
  assert.equal(seedTier(history(731), NOW_MS).tier, "weekly");
  assert.equal(seedTier(history(729), NOW_MS).tier, "hourly");
});

test("correctTier needs three intervals", () => {
  // MUTATION: `MIN_OBSERVATIONS = 4` -> `3` -> three times return a tier.
  assert.equal(correctTier(timesFromGaps([1, 1])), null);
  assert.equal(correctTier([]), null);
  assert.equal(correctTier(null), null);
  assert.equal(correctTier(timesFromGaps([1, 1, 1])), "several_daily");
});

test("correctTier uses the lower-middle median", () => {
  // MUTATION: `gaps[Math.floor((gaps.length - 1) / 2)]` -> the mean of gaps, or
  // `gaps[Math.floor(gaps.length / 2)]` (upper-middle) -> weekly in the even case.
  // One long hiatus does not drag a regular show to weekly (the mean, 9.75 d, would).
  // Input order does not matter: the times are shuffled.
  const hiatus = timesFromGaps([3, 3, 3, 30]);
  assert.equal(correctTier([hiatus[3], hiatus[0], hiatus[4], hiatus[2], hiatus[1]]), "daily");
  // Even number of gaps where lower-middle (3 d) and upper-middle (5 d) differ.
  assert.equal(correctTier(timesFromGaps([1, 5, 3, 30])), "daily");
  // Odd number of gaps: the true middle.
  assert.equal(correctTier(timesFromGaps([0.25, 0.25, 30])), "hourly");
});

test("five failures land in backoff; applySuccess restores weekly and clears the 404 clock", () => {
  // MUTATION: `FAILURES_TO_BACKOFF = 5` -> `6` -> still daily after five failures.
  let s = fresh();
  for (let i = 1; i <= 4; i++) {
    s = applyFailure(s, { status: 503, nowMs: NOW_MS + i });
    assert.equal(s.tier, "daily", `failure ${i} must not yet back off`);
  }
  const prev = s;
  const snapshot = { ...s };
  s = applyFailure(prev, { status: 404, nowMs: NOW_MS + 5 });
  assert.deepEqual(prev, snapshot, "applyFailure must not mutate its input");
  assert.equal(s.consecutiveFailures, 5);
  assert.equal(s.tier, "backoff");
  assert.equal(s.firstNotFoundAtMs, NOW_MS + 5);
  assert.equal(s.state, "active");

  const input = { ...s };
  const ok = applySuccess(s);
  assert.deepEqual(s, input, "applySuccess must not mutate its input");
  assert.notEqual(ok, s);
  assert.deepEqual(ok, { consecutiveFailures: 0, tier: "weekly", state: "active", firstNotFoundAtMs: null });
  // Out of a non-backoff tier, success leaves the tier alone.
  assert.equal(applySuccess(fresh({ tier: "hourly", consecutiveFailures: 2 })).tier, "hourly");
});

test("410 is dead at once; 404 is dead at day 30, not day 29", () => {
  // MUTATION: `nowMs - next.firstNotFoundAtMs >= NOT_FOUND_DEAD_AFTER_MS` -> `>` -> active at day 30.
  assert.equal(applyFailure(fresh(), { status: 410, nowMs: NOW_MS }).state, "dead");
  assert.equal(applyFailure(fresh(), { status: 500, nowMs: NOW_MS }).state, "active");

  const first = applyFailure(fresh(), { status: 404, nowMs: NOW_MS });
  assert.equal(first.firstNotFoundAtMs, NOW_MS);
  assert.equal(first.state, "active");
  const day29 = applyFailure(first, { status: 404, nowMs: NOW_MS + 29 * DAY_MS });
  assert.equal(day29.firstNotFoundAtMs, NOW_MS, "the 404 clock starts at the FIRST 404");
  assert.equal(day29.state, "active");
  assert.equal(applyFailure(first, { status: 404, nowMs: NOW_MS + 30 * DAY_MS }).state, "dead");
});

test("nextDueAt adds the interval and throws RangeError on an unknown tier", () => {
  // MUTATION: `return lastPolledAtMs + TIER_INTERVAL_MS[tier];` -> `return lastPolledAtMs;`.
  assert.deepEqual(TIERS, ["hourly", "several_daily", "daily", "weekly", "backoff"]);
  assert.ok(Object.isFrozen(TIER_INTERVAL_MS) && Object.isFrozen(TIERS));
  assert.equal(nextDueAt("hourly", NOW_MS), NOW_MS + 3_600_000);
  assert.equal(nextDueAt("several_daily", NOW_MS), NOW_MS + 6 * 3_600_000);
  assert.equal(nextDueAt("daily", NOW_MS), NOW_MS + DAY_MS);
  assert.equal(nextDueAt("weekly", NOW_MS), NOW_MS + 7 * DAY_MS);
  assert.equal(nextDueAt("backoff", NOW_MS), NOW_MS + 3 * DAY_MS);
  assert.throws(() => nextDueAt("dead", NOW_MS), { name: "RangeError", message: "unknown tier: dead" });
  assert.throws(() => nextDueAt("toString", NOW_MS), RangeError);
});

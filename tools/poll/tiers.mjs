/* Cadence tiers for the S-10 watchlist poller (PKG-05, docs/roadmap/shows-search.md).

   WHAT THIS IS FOR. ADR-0001 (docs/adr/0001-feed-polling-strategy.md) picks a
   cadence-derived polling tier per feed — `hourly` / `several_daily` /
   `daily` / `weekly` / `backoff` — instead of polling every feed on one clock.
   This module is the pure arithmetic of that choice: seed a tier from the dump's
   pubdates, correct it from observed publish times, move it on success and
   failure, and say when a feed is next due. It does no I/O and imports nothing
   (not even `node:` modules); the dry-run (PKG-08) and the live path (PKG-10)
   both call it.

   THE RULES, so a port can reproduce them exactly:
   - TIER_INTERVAL_MS: hourly 1 h, several_daily 6 h, daily 24 h, weekly 7 d,
     backoff 3 d. "Faster" means a smaller interval. `dead` is a STATE, not a
     tier: a dead feed keeps its last tier and is simply never selected.
   - tierFromMeanGapDays: gap <= 0.5 d -> hourly, <= 1.5 -> several_daily,
     <= 4 -> daily, else weekly. Every edge is inclusive. A gap that is null,
     NaN, infinite or <= 0 -> weekly (no evidence buys no speed).
   - seedTier: dump pubdates are UNIX SECONDS (tools/shows/filter.mjs reads them
     as `now - newest * 1000`). meanGapDays = ((newest - oldest) / 86_400) /
     max(1, episodeCount - 1), only when both pubdates are finite, newest >
     oldest and episodeCount >= 2; otherwise null. Then a `curated` or
     `curation_candidate` watch reason lifts the tier to at least daily; then a
     show whose newest item is more than 730 days old is weekly regardless —
     curated or not.
   - correctTier: fewer than 4 observed publish times (3 intervals) -> null.
     Otherwise the gaps between sorted times, in days; the median is the
     LOWER-middle gap (index floor((n - 1) / 2) of the sorted gaps), so one
     long hiatus cannot drag a regular show to weekly.
   - applySuccess / applyFailure: pure, return a new state object. Five
     consecutive failures -> backoff; a success out of backoff -> weekly (the
     next correction re-earns speed) and clears the 404 clock. 410 is dead at
     once; 404 is dead once 30 days (inclusive) have passed since the first 404
     of the current failure run. The caller decides which to call: any 2xx or
     304 is a success.
   - nextDueAt: lastPolledAtMs + TIER_INTERVAL_MS[tier]; an unknown tier throws
     RangeError. */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAY_S = 86_400;

export const TIER_INTERVAL_MS = Object.freeze({
  hourly: HOUR_MS,
  several_daily: 6 * HOUR_MS,
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
  backoff: 3 * 24 * HOUR_MS,
});

export const TIERS = Object.freeze(Object.keys(TIER_INTERVAL_MS));

const FAST_REASONS = ["curated", "curation_candidate"];
const STALE_AFTER_S = 730 * DAY_S;
const MIN_OBSERVATIONS = 4;
const FAILURES_TO_BACKOFF = 5;
const NOT_FOUND_DEAD_AFTER_MS = 30 * DAY_MS;

/** The faster (smaller-interval) of two known tiers. */
function fasterTier(a, b) {
  return TIER_INTERVAL_MS[a] <= TIER_INTERVAL_MS[b] ? a : b;
}

export function tierFromMeanGapDays(gapDays) {
  if (typeof gapDays !== "number" || !Number.isFinite(gapDays) || gapDays <= 0) return "weekly";
  if (gapDays <= 0.5) return "hourly";
  if (gapDays <= 1.5) return "several_daily";
  if (gapDays <= 4) return "daily";
  return "weekly";
}

export function seedTier(
  { episodeCount, oldestItemPubdate, newestItemPubdate, watchReasons = [] },
  nowMs = Date.now(),
) {
  let meanGapDays = null;
  if (
    Number.isFinite(oldestItemPubdate) &&
    Number.isFinite(newestItemPubdate) &&
    newestItemPubdate > oldestItemPubdate &&
    Number.isFinite(episodeCount) &&
    episodeCount >= 2
  ) {
    meanGapDays = (newestItemPubdate - oldestItemPubdate) / DAY_S / Math.max(1, episodeCount - 1);
  }
  let tier = tierFromMeanGapDays(meanGapDays);
  if (watchReasons.some((r) => FAST_REASONS.includes(r))) tier = fasterTier(tier, "daily");
  if (Number.isFinite(newestItemPubdate) && nowMs / 1000 - newestItemPubdate > STALE_AFTER_S) tier = "weekly";
  return { tier, meanGapDays };
}

export function correctTier(observedPublishedAtMs) {
  if (!Array.isArray(observedPublishedAtMs) || observedPublishedAtMs.length < MIN_OBSERVATIONS) return null;
  const sorted = [...observedPublishedAtMs].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / DAY_MS);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor((gaps.length - 1) / 2)];
  return tierFromMeanGapDays(median);
}

export function applySuccess(state) {
  return {
    ...state,
    consecutiveFailures: 0,
    firstNotFoundAtMs: null,
    state: "active",
    tier: state.tier === "backoff" ? "weekly" : state.tier,
  };
}

export function applyFailure(state, { status, nowMs }) {
  const next = { ...state, consecutiveFailures: state.consecutiveFailures + 1 };
  if (next.consecutiveFailures >= FAILURES_TO_BACKOFF) next.tier = "backoff";
  if (status === 410) next.state = "dead";
  if (status === 404) {
    if (next.firstNotFoundAtMs == null) next.firstNotFoundAtMs = nowMs;
    if (nowMs - next.firstNotFoundAtMs >= NOT_FOUND_DEAD_AFTER_MS) next.state = "dead";
  }
  return next;
}

export function nextDueAt(tier, lastPolledAtMs) {
  if (!Object.hasOwn(TIER_INTERVAL_MS, tier)) throw new RangeError("unknown tier: " + tier);
  return lastPolledAtMs + TIER_INTERVAL_MS[tier];
}

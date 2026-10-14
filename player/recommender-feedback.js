/* Local listening observations for the recommender (RV-17, #1380).
 *
 * FOUNDER, 2026-10-14 (issue #1380, recorded in docs/DECISIONS.md): "We also
 * need to consider user feedback, in the form of liking/ disliking shows, what
 * shows they follow, what % of an episode was listened to when they stopped
 * listening to it, etc."
 *
 * WHAT THIS IS. Pure functions that turn what is ALREADY on the device into
 * per-show observations `{ n, obs }` for `shrink(prior, obs, n)` and the
 * outcome buckets for `updateMix` in player/recommender.js (RV-16). The plan is
 * docs/roadmap/recommender-v1.md, card RV-17, decisions D2 and D5.
 *
 * WHAT THIS IS NOT, and the reason it is a separate file. It reads no storage,
 * writes no key, sends nothing and logs nothing: the caller reads the stored
 * values and hands them in as plain objects. That is the whole privacy
 * argument of D5, checked against docs/legal/privacy-policy.md: the rows for
 * the interests, history, saved and per-episode position keys all answer "No"
 * under "Sent", so a weighting computed in memory from them, writing no new
 * key and transmitting nothing, needs no new disclosure. The suite greps this
 * source for the browser storage, event and network names so that stays true.
 *
 * FOLLOWS ARE OFF. The policy row for the followed-shows map (the key keeps its
 * older "starred" name) promises that following a show "never changes what 4a
 * surfaces to you elsewhere". `useFollows` therefore defaults to false and
 * nothing in the app may pass true until RV-24's wording is approved and that
 * sentence changes (docs/legal/ is founder-governed). The code path exists so
 * the switch is one argument, not a new module, on the day it is allowed.
 *
 * DARK. Nothing on a live path imports this module; RV-27 (parked, behind
 * `RECOMMENDER_PRIOR = false`) is the only planned caller.
 */

/** Seconds before the end that count as "the outro": a stop in them is a
    complete listen (credits, trailers for other shows, a closing ad). */
export const OUTRO_MARGIN_SEC = 60;

/** Under this many seconds a listen is a bounce whatever the episode's length:
    the listener heard the cold open and left. */
export const BOUNCE_FLOOR_SEC = 120;

/** Bucket edges as fractions of the effective length. Apple Podcasts reports an
    "engaged" listener at 20 minutes or 40% of an episode (Apple Podcasts for
    Creators, "Podcast analytics"); the 0.4 edge is that anchor, 0.1 marks the
    bounce, and 0.9 of the EFFECTIVE length (outro removed) is a completion. */
export const BOUNCE_FRACTION = 0.1;
export const ENGAGED_FRACTION = 0.4;
export const COMPLETE_FRACTION = 0.9;

/** The buckets, worst to best. RV-16's `updateMix` takes these names. */
export const BUCKETS = Object.freeze(["bounce", "sampled", "engaged", "complete"]);

/** A saved episode, and (only when follows are allowed) a followed show, are
    each one observation at this value on the 1-5 rating scale. */
export const SAVED_OBS = 4.5;
export const FOLLOW_OBS = 4.5;

/** Residual -> rating scale: `obs = 3 + RESIDUAL_SCALE * residual`, clamped to
    [1, 5]. Residuals run from about -0.8 (a bounce on a short episode) to about
    +0.42 (a complete hour-plus episode), so 2.5 maps +/-0.8 onto +/-2. */
export const RESIDUAL_SCALE = 2.5;

const DAY_MS = 86_400_000;

const finitePositive = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;
const finiteNonNegative = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * The part of an episode a listener is expected to hear: the duration less the
 * outro margin, but never less than 90% of it (a 5-minute episode keeps 4.5
 * minutes, not 4).
 * @param {number} durationSec
 * @param {{outroMarginSec?: number}} [opts]
 * @returns {number} seconds, or 0 for a duration that is not a positive number
 */
export function effectiveLength(durationSec, { outroMarginSec = OUTRO_MARGIN_SEC } = {}) {
  if (!finitePositive(durationSec)) return 0;
  return Math.max(durationSec - outroMarginSec, durationSec * 0.9);
}

/**
 * How far into the effective length a stop at `positionSec` is, capped at 1.
 * @returns {number|null} null when either number is unusable
 */
export function completionFraction(positionSec, durationSec, opts) {
  const eff = effectiveLength(durationSec, opts);
  if (!eff || !finiteNonNegative(positionSec)) return null;
  return Math.min(1, positionSec / eff);
}

/**
 * The bucket a stop falls in.
 *   complete  >= 0.9 of the effective length (a stop inside the outro margin)
 *   bounce    < 0.1 of it, or under 120 s of listening whatever the length
 *   sampled   < 0.4
 *   engaged   < 0.9
 * A trailer-length episode heard to its end is complete, not a bounce: the
 * absolute floor is about leaving early, and that listener did not.
 * @returns {"bounce"|"sampled"|"engaged"|"complete"|null}
 */
export function completionBucket(positionSec, durationSec, opts) {
  const f = completionFraction(positionSec, durationSec, opts);
  if (f === null) return null;
  if (f >= COMPLETE_FRACTION) return "complete";
  if (f < BOUNCE_FRACTION || positionSec < BOUNCE_FLOOR_SEC) return "bounce";
  if (f < ENGAGED_FRACTION) return "sampled";
  return "engaged";
}

/**
 * The completion a listener of an episode this long typically reaches: a fixed
 * vendor-benchmark table (<= 30 min 0.8; 31-60 min 0.7; over 60 min 0.58) until
 * 4a has enough of its own listening to fit one.
 * @param {number} durationMin
 */
export function lengthExpectedCompletion(durationMin) {
  if (!(durationMin > 30)) return 0.8;
  if (durationMin <= 60) return 0.7;
  return 0.58;
}

/**
 * How much better (positive) or worse (negative) than the length-expected
 * curve a listen went.
 * @param {number} bucketValue  the completion fraction of the effective length (0-1)
 * @param {number} durationMin
 */
export function completionResidual(bucketValue, durationMin) {
  return bucketValue - lengthExpectedCompletion(durationMin);
}

/** A residual on the 1-5 rating scale, around 3. */
export function residualToObs(residual) {
  return clamp(3 + RESIDUAL_SCALE * residual, 1, 5);
}

/* A stored position is either a number of seconds or the per-episode position
   row itself (`{ seconds, duration, updated_at, source }`, built by
   position-store.js makePositionRecord); the row's own duration stands in when
   the caller has none. */
function positionOf(v) {
  if (finiteNonNegative(v)) return { seconds: v, duration: null, updatedAt: null };
  if (v && typeof v === "object" && finiteNonNegative(v.seconds)) {
    return {
      seconds: v.seconds,
      duration: finitePositive(v.duration) ? v.duration : null,
      updatedAt: typeof v.updated_at === "string" ? Date.parse(v.updated_at) : null,
    };
  }
  return null;
}

const nowMs = (now) => (now instanceof Date ? now.getTime() : finiteNonNegative(now) ? now : null);

/**
 * Per-show observations from what the device already holds.
 *
 * @param {object} device  plain values the CALLER read; this module reads nothing
 * @param {Object<string, number|object>} [device.positions]  episode id -> seconds
 *   (or the stored position row), the per-episode position family
 * @param {Object<string, number>} [device.durations]  episode id -> seconds
 * @param {string[]} [device.history]  the picked/played episode id list
 * @param {Object<string, object>} [device.saved]  the saved-episodes map (id -> snapshot)
 * @param {Object<string, object>} [device.starred]  the followed-shows map (show key -> record)
 * @param {Date|number} [device.now]  the caller's clock
 * @param {object} opts
 * @param {(episodeId: string, snapshot?: object) => string|null} opts.showKeyOf
 *   the caller's episode -> show mapping; an episode it cannot place is dropped
 * @param {boolean} [opts.useFollows=false]  D5: stays false until RV-24 lands
 * @param {number} [opts.resumeWindowDays=7]  a bounce or sample stopped inside
 *   this window may still be resumed, so it is pending, not evidence
 * @returns {Object<string, {n: number, obs: number, outcomes: object[]}>}
 *   `obs` is the mean of the observations on the 1-5 scale; `n` their count
 */
export function observationsFromDevice(
  { positions = {}, durations = {}, history = [], saved = {}, starred = {}, now = null } = {},
  { showKeyOf, useFollows = false, resumeWindowDays = 7 } = {},
) {
  if (typeof showKeyOf !== "function") throw new TypeError("observationsFromDevice needs opts.showKeyOf");
  const out = {};
  const add = (showKey, outcome) => {
    if (!showKey) return;
    const row = (out[showKey] ??= { n: 0, obs: 0, outcomes: [], _sum: 0 });
    row.outcomes.push(outcome);
    if (typeof outcome.value === "number") {
      row.n += 1;
      row._sum += outcome.value;
    }
  };
  const t = nowMs(now);
  const windowMs = Math.max(0, resumeWindowDays) * DAY_MS;

  /* Listens: every episode with a stored position and a known duration. */
  const listened = new Set();
  for (const [id, raw] of Object.entries(positions ?? {})) {
    const p = positionOf(raw);
    if (!p) continue;
    const dur = finitePositive(durations?.[id]) ? durations[id] : p.duration;
    const bucket = completionBucket(p.seconds, dur);
    if (!bucket) continue;
    listened.add(id);
    const fraction = completionFraction(p.seconds, dur);
    const residual = completionResidual(fraction, dur / 60);
    const recent = t !== null && Number.isFinite(p.updatedAt) && t - p.updatedAt < windowMs;
    const pending = recent && (bucket === "bounce" || bucket === "sampled");
    const outcome = { kind: "listen", episode_id: id, bucket, fraction: round3(fraction), residual: round3(residual) };
    if (pending) outcome.pending = true;
    else outcome.value = round3(residualToObs(residual));
    add(showKeyOf(id), outcome);
  }

  /* Picked but no position on record: kept for the record, not counted. A
     missing row is not evidence of a bounce (a refused write, a play on the
     other engine, or one that has not reached its first save yet). */
  for (const id of Array.isArray(history) ? history : []) {
    if (typeof id !== "string" || listened.has(id)) continue;
    add(showKeyOf(id), { kind: "picked", episode_id: id });
  }

  for (const [id, snap] of Object.entries(saved ?? {})) {
    add(showKeyOf(id, snap), { kind: "saved", episode_id: id, value: SAVED_OBS });
  }

  if (useFollows === true) {
    for (const showKey of Object.keys(starred ?? {})) {
      add(showKey, { kind: "followed", show_key: showKey, value: FOLLOW_OBS });
    }
  }

  for (const row of Object.values(out)) {
    row.obs = row.n ? round3(row._sum / row.n) : 3;
    delete row._sum;
  }
  return out;
}

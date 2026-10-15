/* Completion and follow payload builders for the recommender (RV-28, #1380).
 *
 * FOUNDER, 2026-10-14 (issue #1380, recorded in docs/DECISIONS.md): "We also
 * need to consider user feedback, in the form of liking/ disliking shows, what
 * shows they follow, what % of an episode was listened to when they stopped
 * listening to it, etc."
 *
 * WHAT THIS IS. Pure functions that build the payloads RV-27 will log, shaped
 * to the dark contract RV-23 added to backend/src/types/events.ts (plan:
 * docs/roadmap/recommender-v1.md, card RV-28, decision D6):
 *
 *   finishedPayload  -> the episode context plus the four OPTIONAL completion
 *                       fields of FinishedPayloadSchema: percent, eff_len_sec,
 *                       censored, resumed.
 *   followPayload    -> ShowFollowPayloadSchema: show_id, episodes_played?,
 *   unfollowPayload     topics.
 *
 * WHAT THIS IS NOT. It emits nothing: no logEvent, no storage, no network. The
 * caller reads the player's state and hands it in; the caller logs. Nothing on
 * a live path imports this module; RV-27 (parked, behind
 * `RECOMMENDER_PRIOR = false`) is the only planned caller, and the
 * show_followed / show_unfollowed types stay unemitted until the founder
 * applies the RV-23 migration and approves RV-24's privacy wording (#1163).
 *
 * THE REQUIRED `finished` FIELDS ARE THE CALLER'S. FinishedPayloadSchema keeps
 * its existing required `percent_complete` (0..1, raw position over duration)
 * and `source` ("observed" | "manual_stopgap"). They are not built here:
 * RV-27 merges this builder's fields into the row app.js already writes, e.g.
 * `{ ...existingFinishedPayload, ...finishedPayload(args) }`. The suite pins
 * that this builder's completion keys are exactly the contract's optional
 * fields, so the merge cannot overwrite a required one.
 *
 * FOLLOWS STAY OUT OF THE WEIGHTING. Building a follow payload is not using a
 * follow: follow-weighting stays off (DECISIONS 2026-10-14; `useFollows`
 * defaults to false in player/recommender-feedback.js and in the backend's
 * interest learning) until the followed-shows policy sentence changes.
 */

import { effectiveLength } from "./recommender-feedback.js";

/** The upper bound of `percent`: only a replay (a position past the real
    duration) passes 1, as Apple's completion does, but no further than the
    contract's max (events.ts, 1.2). */
export const PERCENT_CAP = 1.2;

/** Why a stop was not the listener's own. A censored stop is not a skip and
    not a bounce (research §2.3): the observation is right-censored. */
export const CENSOR_REASONS = Object.freeze(["backgrounded", "route_lost", "foray_transition", "app_closed"]);

/** The completion fields this module adds to a `finished` row; the suite
    pins them to FinishedPayloadSchema's optional fields. */
export const COMPLETION_FIELDS = Object.freeze(["percent", "eff_len_sec", "censored", "resumed"]);

const finiteNonNegative = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const round2 = (x) => Math.round(x * 100) / 100;
const round1 = (x) => Math.round(x * 10) / 10;
const nonEmptyString = (x) => typeof x === "string" && x.length > 0;
const stringList = (xs) => (Array.isArray(xs) ? xs.filter(nonEmptyString) : []);

function censorFlag(censorReason) {
  if (censorReason === null || censorReason === undefined) return false;
  if (!CENSOR_REASONS.includes(censorReason)) {
    throw new RangeError(`unknown censor_reason ${JSON.stringify(censorReason)}; expected one of ${CENSOR_REASONS.join(", ")} or null`);
  }
  return true;
}

/**
 * The `finished` completion payload for a stop at `position_sec`.
 *   percent      position / effective length (outro margin trimmed, see
 *                effectiveLength), two decimals; capped at 1 while the
 *                position is within the episode, at PERCENT_CAP past its
 *                real duration (a replay)
 *   eff_len_sec  that effective length, one decimal
 *   censored     true when the stop had a CENSOR_REASON, false for null
 *   resumed      true when this listen resumed an earlier position
 * @param {{episode_slug: string, show?: string, topics?: string[],
 *   position_sec: number, duration_sec: number, resumed?: boolean,
 *   censor_reason?: string|null}} args
 * @returns {object|null} null when the slug is missing, the duration is not a
 *   positive number or the position is not a non-negative number: the
 *   contract's eff_len_sec must be positive and percent cannot be decided
 * @throws {RangeError} for a censor_reason that is not in CENSOR_REASONS
 */
export function finishedPayload({
  episode_slug, show, topics, position_sec, duration_sec, resumed = false, censor_reason = null,
} = {}) {
  const censored = censorFlag(censor_reason);
  if (!nonEmptyString(episode_slug)) return null;
  const eff = effectiveLength(duration_sec);
  if (!eff || !finiteNonNegative(position_sec)) return null;
  const effLen = round1(eff);
  if (!(effLen > 0)) return null;
  const payload = { episode_slug };
  if (nonEmptyString(show)) payload.show = show;
  payload.topics = stringList(topics);
  /* Inside the episode a stop reads at most 1 (a stop in the outro margin is
     a completed listen); only a position past the real duration, a replay,
     may pass 1, as events.ts gives the field. */
  const ratio = position_sec / eff;
  payload.percent = round2(position_sec <= duration_sec ? Math.min(1, ratio) : Math.min(PERCENT_CAP, ratio));
  payload.eff_len_sec = effLen;
  payload.censored = censored;
  payload.resumed = resumed === true;
  return payload;
}

function showFollow({ show_id, episodes_played, topics } = {}) {
  if (!nonEmptyString(show_id)) return null;
  const payload = { show_id };
  if (finiteNonNegative(episodes_played)) payload.episodes_played = Math.floor(episodes_played);
  payload.topics = stringList(topics);
  return payload;
}

/**
 * The `show_followed` payload. `episodes_played` (optional) is how many of
 * the show's episodes the listener had played; `topics` are the show's
 * taxonomy node ids.
 * @param {{show_id: string, episodes_played?: number, topics?: string[]}} args
 * @returns {{show_id: string, episodes_played?: number, topics: string[]}|null}
 *   null without a show id
 */
export function followPayload(args) {
  return showFollow(args);
}

/**
 * The `show_unfollowed` payload, the same shape. An unfollow after 3 or more
 * played episodes is the strong negative (research §2.2), so episodes_played
 * is an integer whenever the caller knows it; an unusable count is omitted,
 * never sent as a string or a fraction.
 */
export function unfollowPayload(args) {
  return showFollow(args);
}

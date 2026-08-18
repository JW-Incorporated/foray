/* Playback speed — the ladder, the labels, and the stored value (founder
   request, 2026-08-17: "add play speed options, for example 1.5x ... copy what
   speeds are commonly used on other podcast apps").

   This module answers three small questions purely — which speeds exist, what
   one is called, and what the next one is — so the decision table is readable in
   one screen and testable without a player. `player/queue-manager.js` owns
   APPLYING a rate across a Foray; `player/client.js` owns the button. Same split
   `seam-gap.js` keeps: the rule here, the clock and the DOM elsewhere.

   ── THE STOPS ARE COPIED, NOT INVENTED ────────────────────────────────────

   What the major apps actually offer, checked 2026-08-17:

     Apple Podcasts   1x, 1.25x, 1.5x, 1.75x, 2x were the app's only four
                      presets for a decade. iOS 26 widened the RANGE to
                      0.5x-3x with a 0.1x dial, on top of tappable presets.
     Spotify          0.5x, 0.8x, 1x, 1.2x, 1.5x, 2x, 3x (up to 3.5x). Discrete
                      stops, no custom increments — and, notably, the speed does
                      not carry between episodes, which is the top complaint
                      about it.
     YouTube          0.25x, 0.5x, 0.75x, 1x, 1.25x, 1.5x, 1.75x, 2x. A 0.25
                      ladder, which is where the four Apple presets come from.
     Pocket Casts     0.5x-3x, 0.1x increments, plus +/- buttons.
     Overcast         a continuous 0.5x-3x slider (plus Smart Speed, which is
                      silence trimming rather than a rate).
     Audible          0.5x-3.5x continuous.

   **The convergent DISCRETE set is a 0.25 ladder, and the four stops every one
   of these apps has above 1x are 1.25 / 1.5 / 1.75 / 2.** So the ladder is
   0.25-wide, runs `0.75, 1, 1.25, 1.5, 1.75, 2`, and does two things beyond
   Apple's classic four: it starts at 1x (the identity has to be reachable) and
   it carries exactly ONE stop below it.

   WHY ONE STOP BELOW 1x AND NOT THREE. Every app on that list offers slowing
   down, so leaving it out would be inventing rather than copying — but 0.5x and
   0.25x are language-learning and transcription speeds, not listening speeds,
   and a Foray's own segments are 30-240 s of ordinary conversational English.
   One stop covers the case that actually happens (a dense passage, a heavy
   accent, a listener whose second language this is) and keeps the cycle short
   enough to be a single control. 0.75x rather than Spotify's 0.8x because it is
   on the ladder: a set with one off-ladder member reads as arbitrary, and 0.75
   is the value Apple's dial, YouTube and Pocket Casts all land on.

   ── WHY 2x IS THE TOP, WHICH IS A FORAY-SPECIFIC ANSWER ────────────────────

   Half these apps go to 3x or 3.5x and we deliberately do not, because a Foray
   pays a cost per SEAM that a single episode does not. Every cross-episode seam
   is a fresh media load, and a hidden-page load has been measured at 5.1-11.1 s
   against a 20 s deadline (`html-audio-backend.js`
   §LOAD_SETTLE_TIMEOUT_HIDDEN_MS) — crossing which does not mean "slow", it
   means the segment is DROPPED (#224). Rate does not make any one load slower,
   but it multiplies how many of them a listener meets per wall minute: at 3x a
   listener hits the product's weakest path three times as often as the numbers
   we have were gathered at. 2x doubles that exposure, which is a known cost for
   a speed people genuinely use; 3x trebles it for a speed few do. Revisit when a
   seam on a real phone is measured, not before.

   ── THE LADDER IS DISCRETE ON PURPOSE, NOT FOR WANT OF A SLIDER ────────────

   Overcast and Pocket Casts prove a continuous control is buildable. Four
   reasons it is the wrong one HERE, in descending order of how much they matter:

     1. THIS IS A CAR PRODUCT. `docs/brief/04_VOICE_AUDIO_SPEC.md` calls the
        hands-free surface the thing that must be flawless first, and styles.css
        sizes the transport for it ("Big targets — this is still a car product").
        A slider needs sustained precise aim; a cycle button needs one tap
        anywhere on 48 px. The lock screen and a car head unit cannot render a
        rate slider at all, so a continuous value would be adjustable from
        exactly one of the three surfaces this player runs on.
     2. A RATE HAS TO BE ENUMERABLE TO BE TESTED. The out-point stops each
        segment at an exact `end_sec` and a miss costs a median 936.5 s of the
        wrong episode; overshoot is measured AT a rate. Six stops can each be
        pinned. A continuum cannot, and "we tested 1.5 and 1.6 and assume the
        rest" is how the interesting value goes unmeasured.
     3. THE STORED VALUE IS UNTRUSTED INPUT. `cp_rate` survives in localStorage
        across app versions and can be hand-edited; a closed set snaps a junk or
        stale value onto a known stop (see `normalizeRate`), where a continuous
        range would have to trust a number it cannot verify.
     4. THE PRECISION IS NOT AUDIBLE HERE. A Foray segment runs 30-240 s
        (`docs/curation/segment-length-rules.md`), so 1.5x versus 1.6x is under a
        second either way on a typical one. The granularity a slider buys is
        below the resolution of the thing being adjusted.

   ── ONE VALUE, GLOBAL ─────────────────────────────────────────────────────

   `cp_rate` is one key for the whole app, not one per Foray. A speed is a fact
   about the LISTENER — how fast they parse speech — not about the audio, and a
   Foray is an hour drawn from nine different shows, so "per Foray" would mean
   "per arbitrary bundle of nine publishers" and mean nothing. Apple's per-show
   speed is an override on top of a global default, and Spotify's failure to
   persist at all is its most-complained-about behaviour. Global is also the only
   choice that keeps the promise "the app remembers I listen at 1.5x" on the
   first Foray a listener ever opens.

   `cp_` prefix per CLAUDE.md § Conventions: renaming these wipes user state.
*/

/** localStorage key. The `cp_` prefix is legacy and load-bearing. */
export const RATE_KEY = "cp_rate";

/** The stops, ascending. See the header for where they come from. */
export const RATES = Object.freeze([0.75, 1, 1.25, 1.5, 1.75, 2]);

/** Normal speed, and the answer to every unusable input. */
export const DEFAULT_RATE = 1;

/** The fastest stop, named so the reasoning above is reachable from code that
    cares (a test pinning the #224 argument, telemetry). */
export const MAX_RATE = RATES[RATES.length - 1];

/** The slowest stop. */
export const MIN_RATE = RATES[0];

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** Is this value exactly one of the stops? Strict: `isRate("1.5")` is false,
    because a string reaching `element.playbackRate` is a different bug and
    coercing it here would hide it. */
export function isRate(v) {
  return isNum(v) && RATES.includes(v);
}

/**
 * Any value -> a stop on the ladder.
 *
 * SNAPS RATHER THAN REJECTS, and that difference is the point. The inputs here
 * are a hand-edited `cp_rate`, a row written by an older version of this app
 * with a different ladder, and a founder typing in a console — none of which is
 * an attack and all of which must produce a usable speed rather than a silent
 * fall back to 1x that reads as "the app forgot". So a finite positive number in
 * range lands on the NEAREST stop (1.6 -> 1.5), a number outside the range is
 * CLAMPED to the end it is past (3 -> 2, 0.1 -> 0.75), and only a value that is
 * not a usable number at all — null, "fast", NaN, Infinity, 0, negative — falls
 * back to 1x.
 *
 * Clamping rather than defaulting for out-of-range matters in one direction that
 * has already happened once in this repo's sister project: if the ladder is ever
 * shortened, everyone stored at the old top would be dropped to 1x on their next
 * launch, which is indistinguishable from a bug. Clamping keeps them as fast as
 * the app still goes.
 */
export function normalizeRate(v) {
  if (!isNum(v) || v <= 0) return DEFAULT_RATE;
  if (v <= MIN_RATE) return MIN_RATE;
  if (v >= MAX_RATE) return MAX_RATE;
  let best = RATES[0];
  for (const r of RATES) {
    if (Math.abs(r - v) < Math.abs(best - v)) best = r;
  }
  return best;
}

/**
 * The next stop up, wrapping past the top back to the slowest.
 *
 * Every app on the list in the header cycles UPWARD from a tap, because that is
 * the direction people move: the reason to touch the control at all is almost
 * always "this is slower than I can listen". Wrapping to 0.75x rather than to 1x
 * is what keeps the slow stop reachable from a one-button control at all.
 *
 * NORMALISES FIRST, and this is not defensive tidying — it is the bug the first
 * draft of this control shipped with. It did `RATES[(RATES.indexOf(cur) + 1) %
 * RATES.length]`, and `indexOf` returns -1 for anything off the ladder, so
 * `-1 + 1 = 0`: a listener whose stored rate was off the ladder (an older
 * ladder, a hand edit) got RATES[0] on every single tap and the control was
 * permanently stuck on one value.
 */
export function nextRate(v) {
  const cur = normalizeRate(v);
  const at = RATES.indexOf(cur);
  return RATES[(at + 1) % RATES.length];
}

/**
 * What the button says: "1×", "1.5×", "0.75×".
 *
 * Written the way podcast apps write it — the multiplication sign, no space, no
 * trailing zero. Apple shows "1.5×", Spotify "1.5x", YouTube "1.5". The × is
 * already the glyph this repo's player uses (`client.js` shipped `1×`), so this
 * keeps it rather than introducing a second convention.
 */
export function rateLabel(v) {
  const r = normalizeRate(v);
  // `String(1)` is "1" and `String(0.75)` is "0.75"; neither needs trimming,
  // and every stop on a 0.25 ladder is exact in binary, so there is no
  // 1.7500000000000002 to guard against. Asserted in the suite rather than
  // assumed here.
  return `${r}×`;
}

/**
 * The accessible name for the control. The visible label is a bare number, which
 * a screen reader reads as "one point five multiplication sign" — true and
 * useless — and `aria-label` on a button REPLACES its text, so the value has to
 * be said again here or it is lost entirely.
 *
 * Sentence case, no exclamation, em-dash as in the surrounding copy
 * (CLAUDE.md § Conventions / repo copy rules).
 */
export function rateAriaLabel(v) {
  return `Playback speed ${rateLabel(v)} — tap for the next speed`;
}

/* ---------- storage ---------- */

/**
 * The stored speed, or 1x.
 *
 * `storage` is injected — `player/durable-store.js` in the app, a plain fake in
 * the suite — for the same reason `foray-progress.js` injects it: this module
 * has no business referencing `localStorage` and could not be tested if it did.
 * A throwing or absent store is the ordinary case (private mode, storage
 * blocked, no browser at all), not an error.
 */
export function readRate(storage) {
  if (!storage || typeof storage.getItem !== "function") return DEFAULT_RATE;
  try {
    const raw = storage.getItem(RATE_KEY);
    if (raw == null) return DEFAULT_RATE;
    return normalizeRate(Number(raw));
  } catch (_) {
    return DEFAULT_RATE;
  }
}

/**
 * Write the speed down. Returns whether it stuck.
 *
 * A refusal is NOT a reason to leave the rate unapplied — a speed that cannot be
 * stored is still a speed that should govern this session — so this reports
 * rather than throws, and the caller applies either way. Same posture as
 * `foray-progress.js`'s `writeProgress`.
 */
export function writeRate(storage, v) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(RATE_KEY, String(normalizeRate(v)));
    return true;
  } catch (_) {
    return false;
  }
}

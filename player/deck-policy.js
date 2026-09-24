/* The deck's decisions, as pure functions (NE-14j, docs/native-engine-plan.md
   §4.3 and §6.5: the `deck-episode` parity family).

   WHY THIS FILE EXISTS
   `HtmlAudioBackend` makes a handful of decisions that the native engine's
   `DeckPolicy` (NE-14s) has to make identically: when the out-point's fine
   watch arms and for how long, what a fine wake does, how long a load may take
   hidden or visible, when a new item is a seek in the buffer rather than a
   refetch, and what the handover's recovery may still do after a stop. Inside
   the backend they were lines in methods that also touch an <audio> element,
   and a rule that can only be read by driving a DOM element cannot be handed to
   a second implementation, nor checked against one. So the DECISIONS live here
   and the backend keeps the ACTIONS: it gathers what the element says, asks one
   of these functions, and does what the answer says.

   NO BEHAVIOUR CHANGE, BY CONSTRUCTION. Each function is the backend's old
   inline code with its inputs named, and the four numbers moved here with their
   derivations, unchanged. html-audio-backend.test.js drives the real backend
   over fake elements and changed only where a comment named a line that moved
   here; it is the proof.

   JS IS THE REFERENCE (plan §6). A rule change here is a JS PR that re-records
   `player/parity/fixtures/deck-episode/`, which hands the changed ids to
   swift-pending.json; the Swift port follows. The never-early rule
   (`fineWakeAction`) and the numbers are AUTHORED cases: record.mjs refuses to
   overwrite them.

   Every answer is a number, a boolean, a closed token or a list of tokens, so a
   fixture can record it and a Swift enum can mirror it. Nothing here reads a
   clock, the DOM or storage. */

/**
 * How much WALL CLOCK before the boundary the fine stage takes over.
 *
 * ── WHY IT IS 2.0 s AND NOT 0.5 s (raised 2026-08-17, with playback speed) ──
 *
 * It has to exceed the widest gap the COARSE stage can leave, because the
 * handover only happens on a tick and a boundary the coarse stage never gets
 * within the lead of is stopped BY the coarse stage — one tick late.
 *
 * `timeupdate` is nominally 250 ms, measures a 252 ms median in a hidden page,
 * and **the widest interval this repo has actually recorded is 1,825 ms** (see
 * html-audio-backend.js and its tests' out-point section, and its
 * `PREFETCH_LEAD_SEC`, which is sized off the same number). At a 0.5 s lead a run that delivered a 1.8 s gap armed nothing at all
 * and the stop landed on the late tick.
 *
 * **THAT IS THE ONE PLACE RATE MADE THE BOUNDARY WORSE, and it is why this
 * number moved with the speed control rather than before it.** The fine timer's
 * content window is already flat in rate by arithmetic — it is armed for
 * `(end - now) / rate` of wall clock, so `armed x rate` is constant, which the
 * suite pins with no clock in it. The coarse stage has no such property: its
 * window is one tick of WALL clock, which is `rate` times as much CONTENT. So a
 * 1,825 ms gap costs 1.8 s of overshoot at 1x and **3.7 s at 2x** — most of a
 * sentence of the next show, on the path this repo prices at a median 936.5 s of
 * the wrong episode when it goes wrong.
 *
 * Raising the lead past the worst recorded gap means the fine stage is armed from
 * whichever tick lands inside it, at any rate, so the overshoot is bounded by
 * TIMER latency (single-digit to tens of ms) instead of EVENT latency — and
 * `overshoot x rate` stops being the thing that grows. 2.0 s is 1,825 ms plus
 * enough not to be exactly on the boundary of the observation.
 *
 * ── WHAT A LONGER LEAD COSTS, WHICH IS ALMOST NOTHING ──────────────────────
 *
 * The original 0.5 s was reasoned as "timeupdate is free and already firing, and
 * a fine timer armed minutes out would just be rescheduled hundreds of times",
 * which is correct and does not argue for 0.5 over 2.0: at 4 Hz this is ~8
 * reschedules per segment instead of ~2, against a segment median of 103 s. Each
 * one is a `clearTimeout` and a `setTimeout`. It buys, in exchange, one thing
 * that matters at every rate: the timer is armed from `playing` and from the
 * first tick inside the window, rather than from whichever tick happens to fall
 * in the last half second.
 *
 * It cannot cause an early stop at any length — the wake re-reads the playhead
 * and only stops on a genuine crossing — and it cannot spin, because a wake with
 * no progress stands the stage down.
 */
export const OUT_POINT_ARM_LEAD_SEC = 2.0;
/** Browsers clamp nested timeouts to ~4 ms; asking for less just burns wakeups. */
export const OUT_POINT_MIN_TIMER_MS = 4;

/** How long EITHER load path may take to settle before we give up and let the
    manager degrade. Generous — a range request into the middle of a podcast
    normally settles in well under a second, and the cost of being wrong in the
    impatient direction is dropping a segment that would have played. The cost
    of no deadline at all is a player that never recovers.

    Both paths need one for the same reason: the events that mean "ready"
    (`canplay`, `seeked`) and the event that means "broken" (`error`) do not
    cover a network that simply stops. A stalled fetch fires `stalled` and
    `suspend` and then nothing at all, forever. Without a deadline the promise
    stays pending, `_loadItem` awaits it forever, and the state machine sits in
    `loadingItem` with no path out — a listener stranded mid-Foray with a UI
    that still says "loading".

    NEVER `unref()` A DEADLINE. That was the actual CI failure on this PR
    (#111): the seek deadline was unref'd, so it was not guaranteed to fire at
    all — an unref'd timer only runs if something ELSE keeps the event loop
    alive, which makes a recovery path depend on unrelated activity elsewhere in
    the process. Node 24's test runner happened to hold the loop open, Node 22's
    did not, and the suite hung with "Promise resolution is still pending but
    the event loop has already resolved". `unref()` is for periodic
    housekeeping that nobody awaits (the manager's 15s position timer); it is
    never right for a timer something is waiting on.

    THIS NUMBER IS FOR A VISIBLE PAGE ONLY. A hidden page is a different machine
    — see `LOAD_SETTLE_TIMEOUT_HIDDEN_MS`. */
export const LOAD_SETTLE_TIMEOUT_MS = 10_000;

/**
 * The same deadline for a page that is HIDDEN, which on iOS is a different
 * machine rather than the same one running slower.
 *
 * WHY IT HAS TO BE SEPARATE. A visible load is measured at **590 ms**
 * (run 32057395270, `WebKit:Media` lifecycle). A hidden load runs the same
 * algorithm as a chain of queued tasks delivered SECONDS apart, so it takes
 * 5-11 s for the identical file. 10 s therefore has ~17x headroom while visible
 * and NEGATIVE headroom while hidden: a seam on a backgrounded Simulator was measured at
 * 9,153 ms, i.e. 847 ms inside a budget it is supposed to be nowhere near, and
 * a run that crossed it DROPPED THE SEGMENT — the manager degrades, and the
 * listener loses ~110 s of Foray rather than waiting a few more seconds.
 *
 * ── DERIVED FROM THE FLOOR. THERE IS NO USABLE CEILING — SEE BELOW ────────
 *
 * FLOOR — the worst CLEAN chain, times the observed spread. Three runs on an
 * **iOS Simulator** (backgrounded by launching Settings; no real audio route; no
 * phone was locked), all on `probe-tone-b.wav`, a small file BUNDLED INSIDE THE
 * APP:
 *
 *     32064639785   5,114 ms   clean, one element
 *     32036295743   9,153 ms   clean, one element     <- the worst CLEAN sample
 *     32057395270  11,140 ms   a second element's teardown sharing the task
 *                              queue — that path is parked (html-audio-backend.js §"prefetch"),
 *                              so it is EXCLUDED from the derivation rather
 *                              than being the worst case. Stated, because
 *                              "worst evidenced" would otherwise be false: at
 *                              11.14 s the same arithmetic gives 21.5 s.
 *
 * The **1.8x spread between the two clean samples** is the load-bearing part:
 * same code path, same 15.0 s of hidden playback before the boundary, same file,
 * 5.1 s against 9.2 s — and the whole difference sits in one phase (`stalled` ->
 * `loadedmetadata`, 1,902 ms against 5,954 ms). A hidden chain is a distribution
 * we have three samples of, not a constant to bound tightly. So the bound wants
 * to be a MULTIPLE of 9.2 s: 9.2 x 1.8 = 16.6 s, plus the cold cross-origin CDN
 * none of these exercised (ranged GETs against six real sources: TTFB 0.99 s
 * median, 1.41 s worst, desktop, a lower bound) ~= 18 s. Rounded to **20 s**.
 *
 * ── AND THE THING THAT LOOKS LIKE A CEILING IS NOT ONE ────────────────────
 *
 * A first draft of this comment bounded 20 s from above by the page's hidden
 * lifetime, and that was wrong twice over. The page IS suspended while hidden —
 * the durable record ends after 25.2 s, 26.8 s and 27.9 s of hidden time, with
 * `didChangeThrottleState(Suspended)` and `uiAssertionWillExpireImminently` in
 * the log (§4.1b) — but:
 *
 *   1. **That clock starts when the app hides; this deadline starts at the
 *      boundary**, which the probe pins 15.0 s later. The post-boundary budget is
 *      therefore only **10.2 / 11.8 / 12.9 s** — and in two of three runs the
 *      load finished with under a second to spare. NOTHING above ~13 s can fire
 *      in the measured configuration, which includes 20 s.
 *   2. The suspension is plausibly a Simulator artifact (§4.1b), so it is not
 *      something to size a shipped constant against in either direction.
 *
 * **So the two constraints are incompatible, and that is the finding rather than
 * a problem with the number.** No value both clears the floor (~18 s) and fits
 * the measured post-boundary window (~13 s). Picking a value below the floor
 * guarantees the drops this exists to prevent; picking 20 s means that when a
 * hidden load is slow enough to matter, the thing that ends the Foray is the
 * SUSPENSION rather than our impatience. That is strictly better — one cause
 * removed, the next one exposed — and it is why §4.1b's suspension question,
 * not this constant, is the top of the queue.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ─────────────────────────────────
 *
 * Every hidden number above comes from the FIRST ~15 s OF HIDDEN TIME, because
 * `tools/mobile/probe/probe-seam.js` pinned its first boundary at
 * `ARM_AFTER_HIDDEN_SEC = 15` and the record had never contained a second
 * transition. **That constant is 60 s as of 2026-08-17 (PR #240), so numbers from
 * deeper in the hidden window now exist — read the run linked from that PR before
 * quoting the paragraph above as current.** The reason it moved is not this
 * deadline: 15 s of playback plus WebKit's ~12 s assertion release landed on the
 * same ~28 s the record always stopped at, so the probe could not tell a platform
 * suspension ceiling apart from a suspension following its own silence.
 * A phone locked for twenty minutes is still UNMEASURED. If hidden
 * throttling deepens with time hidden — plausible, untested, and NOT assumed
 * here — then 20 s is a floor rather than a bound, and the right shape may not
 * be a single number at all. What the change is worth does not depend on that:
 * it converts a dropped segment into a slower seam inside the window we have
 * actually observed, and a listener who hears a long gap still has a Foray.
 *
 * The cost, stated plainly: a genuinely dead URL now strands a hidden player for
 * 20 s instead of 10 s before the manager degrades. That is the right trade only
 * because the two outcomes are not symmetric — a slow seam is recoverable and a
 * dropped segment is not.
 */
export const LOAD_SETTLE_TIMEOUT_HIDDEN_MS = 20_000;

/** How close to its target an in-place seek has to land to count as settled,
    in seconds of content. */
export const SETTLE_NEAR_SEC = 1;

/** What a fine-watch wake does (`fineWakeAction`). */
export const FINE_WAKE = Object.freeze({
  /** The playhead has reached the boundary: pause and report the out-point. */
  STOP: "stop",
  /** Woke early with progress (timer jitter): arm again for what is left. */
  RESCHEDULE: "reschedule",
  /** Woke early with NO progress since the last wake: a stall. Hand back to the
      coarse stage rather than spin at the timer floor. */
  STAND_DOWN: "stand-down",
});

/** What the handover's recovery does once its own load settles
    (`recoveryLoadedOps`, `recoveryFailedOps`). */
export const RECOVERY = Object.freeze({
  /** Arm the out-point the promoted element carried. */
  ARM_OUT_POINT: "arm-out-point",
  /** Start audio on the element that holds the gesture. */
  PLAY: "play",
  /** Tell the manager the segment failed (its degrade path). */
  REPORT: "report",
});

/** The rate the fine watch divides by: the element's own, unless it is not a
    positive number, when the arithmetic falls back to 1x rather than dividing
    by nothing. */
export function deckRate(playbackRate) {
  return typeof playbackRate === "number" && playbackRate > 0 ? playbackRate : 1;
}

/**
 * Is a boundary at `outPointSec` ARMED with the playhead at `atSec`? Only when
 * the playhead is before it: the watch fires on the playhead CROSSING the
 * boundary from below, so a scrub past it free-plays and a scrub back re-arms
 * (see `HtmlAudioBackend#setOutPoint` for why that is the policy).
 */
export function outPointArmed({ atSec, outPointSec }) {
  return atSec < outPointSec;
}

/**
 * How long, in WALL-CLOCK milliseconds, to arm the fine watch for — or null
 * when it must not be armed now.
 *
 * Null when there is no boundary, when it is not armed (the playhead is past
 * it), when the element is paused (nothing is moving; `playing` asks again),
 * and when the boundary is further than `OUT_POINT_ARM_LEAD_SEC` of wall clock
 * away (the coarse stage's job until it is closer). Otherwise the remaining
 * content divided by the rate — so `armed x rate` is constant and a faster rate
 * never widens what a late wake can spill — rounded UP to a whole millisecond
 * and never below `OUT_POINT_MIN_TIMER_MS`.
 *
 * @param {object} s
 * @param {number|null} s.outPointSec  the boundary, in the source's seconds
 * @param {number} s.atSec             the playhead
 * @param {*} s.rate                   the element's playbackRate (see `deckRate`)
 * @param {boolean} [s.armed=true]     `outPointArmed` at the last crossing check
 * @param {boolean} [s.paused=false]   the element is paused
 * @returns {number|null}
 */
export function fineWatchDelayMs({ outPointSec, atSec, rate, armed = true, paused = false }) {
  if (outPointSec == null || !armed || paused) return null;
  const remainingWallSec = (outPointSec - atSec) / deckRate(rate);
  if (remainingWallSec > OUT_POINT_ARM_LEAD_SEC) return null;
  return Math.max(OUT_POINT_MIN_TIMER_MS, Math.ceil(remainingWallSec * 1000));
}

/**
 * What a fine-watch wake does, given where the playhead is NOW.
 *
 * THE STOP IS NEVER EARLY. The timer was a prediction, and predictions are
 * wrong when the decoder stalls or the rate changes, so a wake re-reads the
 * playhead and stops only on a genuine crossing — the payoff a segment exists
 * for is never clipped, at any rate, under any stall. An early wake with
 * progress reschedules (`fineWatchDelayMs` for what is left); an early wake with
 * none since the last one is a stall, and stands down instead of spinning at
 * the timer floor.
 *
 * @param {object} s
 * @param {number} s.atSec                     the playhead now
 * @param {number} s.outPointSec               the armed boundary
 * @param {number|null} [s.lastWakeAtSec=null] the playhead at the previous early
 *   wake since the watch was last re-derived, or null for the first
 * @returns {string} a `FINE_WAKE` token
 */
export function fineWakeAction({ atSec, outPointSec, lastWakeAtSec = null }) {
  if (atSec >= outPointSec) return FINE_WAKE.STOP;
  if (lastWakeAtSec !== null && atSec <= lastWakeAtSec) return FINE_WAKE.STAND_DOWN;
  return FINE_WAKE.RESCHEDULE;
}

/**
 * How long THIS load may take to settle, in milliseconds. A deadline a caller
 * pinned wins at either visibility; otherwise a page known to be hidden gets
 * `LOAD_SETTLE_TIMEOUT_HIDDEN_MS`, and anything else — visible, or visibility
 * unknown — the visible `LOAD_SETTLE_TIMEOUT_MS`.
 *
 * @param {object} [s]
 * @param {number|null} [s.pinnedMs=null]  an injected deadline
 * @param {*} [s.hidden=false]            true only when the page is known hidden
 * @returns {number}
 */
export function loadDeadlineMs({ pinnedMs = null, hidden = false } = {}) {
  if (pinnedMs != null) return pinnedMs;
  return hidden === true ? LOAD_SETTLE_TIMEOUT_HIDDEN_MS : LOAD_SETTLE_TIMEOUT_MS;
}

/**
 * SAME SOURCE = A SEEK, NOT A LOAD. When the deck already holds this URL, with
 * metadata and no error, the next item is a move of the playhead inside the
 * buffer it has — no refetch, no gap, and no chance of an ad-stitched host
 * handing back a different stitch that moves every later timestamp.
 *
 * @param {object} s
 * @param {string|null} s.loadedUrl  what the deck holds, or null
 * @param {string} s.url             what the next item wants
 * @param {boolean} s.hasMetadata    the deck knows the source's duration
 * @param {boolean} s.failed         the deck's source is in error
 * @returns {boolean}
 */
export function sameSourceIsSeek({ loadedUrl, url, hasMetadata, failed }) {
  return Boolean(loadedUrl) && loadedUrl === url && hasMetadata === true && !failed;
}

/** Has an in-place seek landed near enough to its target to count as settled? */
export function settledNear({ atSec, targetSec }) {
  return Math.abs(atSec - targetSec) <= SETTLE_NEAR_SEC;
}

/**
 * The handover's recovery, once its own load has SETTLED: what it may still do.
 *
 * A promoted element refused to play, so the recovery reloaded the segment on
 * the element that holds the gesture. Nothing awaits that load, so by the time
 * it lands the listener may have moved on:
 *
 *  - SUPERSEDED (a newer load owns the deck): nothing. Arming the old segment's
 *    boundary over the new one is a wrong out-point, the most expensive failure
 *    this player has.
 *  - STOPPED (a deliberate pause since the recovery began, #267): arm, but do
 *    not play. ARMED BEFORE THE STOP CHECK, DELIBERATELY: declining to play is
 *    not abandoning the segment, and one press must resume it still bounded, so
 *    the queue advances at its out-point instead of running on into the rest of
 *    the source episode.
 *  - Otherwise: arm, then play.
 *
 * The boundary is armed only if there was one.
 *
 * @param {object} s
 * @param {boolean} s.superseded
 * @param {boolean} s.stopped
 * @param {number|null} s.boundarySec  the out-point the promoted element carried
 * @returns {string[]} `RECOVERY` tokens, in order
 */
export function recoveryLoadedOps({ superseded, stopped, boundarySec }) {
  if (superseded) return [];
  const ops = boundarySec != null ? [RECOVERY.ARM_OUT_POINT] : [];
  if (!stopped) ops.push(RECOVERY.PLAY);
  return ops;
}

/**
 * The same recovery, when its load FAILED. Reporting is `onError`, which sends
 * the manager to idle in every state — so a recovery nobody is waiting on any
 * more (superseded, or stopped since it began) reports nothing: it would
 * overwrite whatever the player has become, and after a stop it would be a lie
 * about causation. Only a failure somebody is still waiting on is reported.
 *
 * @param {object} s
 * @param {boolean} s.superseded
 * @param {boolean} s.stopped
 * @returns {string[]} `RECOVERY` tokens, in order
 */
export function recoveryFailedOps({ superseded, stopped }) {
  return superseded || stopped ? [] : [RECOVERY.REPORT];
}

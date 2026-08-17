/* HtmlAudioBackend — the first PlayerBackend implementation (issue #24).

   Drives a single `<audio>` element. Ships to the web PWA today; the native
   backend (#28, AVPlayer / Media3) implements the same contract later and the
   queue manager never learns which one it is driving.

   ── The contract (mirrors ios/App/Player/PlayerBackend.swift) ─────────────
     async load(item, { startOffset })   resolve when ready to produce audio
     play() / pause()
     seek(seconds, { precise })
     setOutPoint(seconds | null)         stop here and report a normal end
     setRate(rate)
     setVolume(v)                        0..1 — hold-to-talk ducking later
     get currentTime() / get duration()
     release()
     onItemEnded(reason) / onError       assigned by the manager

   `load()` CLEARS ANY ARMED OUT-POINT. That is contract, not implementation
   detail: it is what lets the reducer emit `setOutPoint` only for bounded
   items and still guarantee that a segment's boundary can never leak into the
   next item. A backend that forgets it will stop a full episode partway
   through, at a time taken from something the listener already finished.

   ── Things that will bite, all load-bearing ───────────────────────────────

   TWO ELEMENTS, AND ONLY ONE OF THEM IS EVER ALLOWED TO PRODUCE AUDIO. See
   §"prefetch" below for why the second one exists. Creating an element per
   ITEM is still the web equivalent of corner case #19's two-AVPlayers bug —
   the old one keeps decoding and you get two things audible at once — so
   there are exactly two for the lifetime of the app, they swap roles, and the
   invariant is written down and tested: `this.el` is the player and owns the
   audio session; `this._warmEl` is a loader that is never played, never
   un-paused, and never given a volume. A handover pauses the outgoing element
   BEFORE the swap, so at no instant are two elements un-paused.

   NO `crossorigin` ATTRIBUTE. Podcast CDNs send no `Access-Control-Allow-
   Origin` (measured — see #20 §3). A media element loads cross-origin fine
   without CORS; setting the attribute turns a working no-cors load into a
   hard failure. The cost is that Web Audio cannot touch this element, so
   ducking uses `.volume` rather than a gain node — which is all the spec
   actually needs.

   `currentTime` BEFORE METADATA IS LOST. Assigning it while `readyState` is 0
   either throws or is silently discarded depending on the browser, so the
   start offset is applied after `loadedmetadata`, never optimistically.

   AUTOPLAY REJECTION IS NORMAL, NOT EXCEPTIONAL. `play()` returns a promise
   that rejects without a user gesture. It must be caught — an unhandled
   rejection here is a console error on every session start.

   `timeupdate` IS NOT A BOUNDARY. It fires roughly every 250 ms, and the spec
   only requires 4-66 Hz "at the UA's discretion" — so a bare
   `if (currentTime >= end) stop()` overshoots by up to a quarter second of
   wall clock, which at 2x is half a second of content, i.e. a whole sentence
   of the next thing. See §"the out-point" below for what this does instead.
*/

import { END_NATURAL, END_OUT_POINT } from "./queue-state.js";

const READY_ENOUGH = 3; // HAVE_FUTURE_DATA

/* ── the out-point ────────────────────────────────────────────────────────

   Two stages, because the two failure modes pull in opposite directions:
   overshooting spills the next speaker's first words into a Foray transition,
   and stopping early clips the payoff the segment exists for.

   1. COARSE: `timeupdate` (~4 Hz, free, already firing). It never stops
      anything on its own once the boundary is close — it just keeps the fine
      stage scheduled.
   2. FINE: inside the last ARM_LEAD_SEC of wall clock, a one-shot `setTimeout`
      for exactly the remaining `(end - now) / rate` seconds. Timer latency is
      single-digit-to-tens of milliseconds, against 250 ms of event latency.

   The fine timer is a PREDICTION, and predictions are wrong when the decoder
   stalls or the rate changes. So it never stops on the prediction: it wakes,
   re-reads `currentTime`, and stops only if the playhead has genuinely reached
   the boundary. An early wake reschedules. **The stop is therefore never
   early, at any rate, under any stall** — the accuracy claim is entirely
   one-sided, and the overshoot is bounded by how late a wake can be.

   A stall would turn "reschedule on early wake" into a spin at the timer
   floor, so no-progress between two fine wakes stands the fine stage down and
   hands back to `timeupdate` / `playing`, which cost nothing while stalled.
   The price of a stall is therefore one ordinary timeupdate interval of
   overshoot, once, on resume — never a busy loop, never an early cut.

   ARMED vs DISARMED is the whole scrub-past-the-end policy, and it is one
   comparison rather than a mode: the watch fires on the playhead CROSSING the
   boundary from below. Jump beyond it by hand and there is no crossing, so
   nothing fires and the item free-plays; come back to before it and the next
   crossing stops as usual. See setOutPoint().
*/
const OUT_POINT_ARM_LEAD_SEC = 0.5;
/** Browsers clamp nested timeouts to ~4 ms; asking for less just burns wakeups. */
const OUT_POINT_MIN_TIMER_MS = 4;

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
    never right for a timer something is waiting on. */
const LOAD_SETTLE_TIMEOUT_MS = 10_000;

/* ── prefetch: the next segment loads while this one is still audible ─────
   (issue #111's seam, measured on a device-class run — see the numbers below.)

   MEASURED, run 32036295743, iOS Simulator, app genuinely backgrounded, the
   real PlayerQueueManager over this real backend across one real seam:

     boundary        +0 ms      the out-point fires, 3 ms late — tight
     beat-armed      +2 ms      seam-gap.js's 2.0 s beat arms immediately
     load-started    +12 ms     the element starts looking for media
     stalled         +3,173 ms  no media data has arrived for three seconds
     loadedmetadata  +9,127 ms
     canplay         +9,142 ms
     beat-ended      +9,142 ms  the beat had expired long before this
     playing         +9,153 ms

   `askedGapMs: 2000` -> `observedGapMs: 9153`. THE TIMER IS NOT THE PROBLEM
   and neither is the beat: both were spent inside 2 ms. Every one of those
   9.1 seconds is the MEDIA LOAD, and the file was `probe-tone-b.wav`, a small
   asset bundled inside the app. A cold cross-origin CDN range request is the
   real case and cannot be faster.

   Two consequences, and the second one is worse than the first:

     1. The seam a listener hears is `max(SEAM_GAP_SEC, load)`, not 2.0 s.
        16 of Foray #1's 31 seams cross to a different episode (the other 15
        are same-source and take the seek shortcut below), so that is ~2.5
        minutes of dead air in a one-hour Foray, on a locked screen.
     2. 9,153 ms is 92% of LOAD_SETTLE_TIMEOUT_MS. Cross that and `load()`
        REJECTS, the manager degrades, and the segment is dropped. On Chromium
        this already happens: `docs/research/mp1-background-audio.md` §4.4
        measured 3 of 5 hidden-page loads failing with
        "did not settle within 10000ms". The next thing past a slow seam is a
        dropped one.

   WHY THE LOAD IS SLOW, WHICH IS THE WHOLE DESIGN INPUT. The boundary pauses
   the element, so the page goes SILENT, and silence is what costs us:

     - WebKit takes a foreground process assertion *because* a view is playing
       audio (`takeAudibleActivity()` -> `foregroundActivity("View is playing
       audio")`), and `ProcessThrottler` only suspends a process with no
       activities (mp1-background-audio.md §7.4). Pause and that assertion
       lapses after `audibleActivityClearDelay` = 10 s.
     - Blink is the same shape and it is MEASURED (§4.1): a hidden page that is
       producing audio is not throttled at all (111 ms median for a 100 ms
       timer, identical to visible); pause the element and the same timer
       collapses ~21x. "A page cannot be throttled or frozen 30 seconds after
       playing audio" is the source comment.

   So a load issued after the boundary runs in the worst window the platform
   has, and a load issued BEFORE it runs in the best one. That is the fix: warm
   the next segment while the current one is still audible, and let the boundary
   hand over to an element that is already `canplay` at the right offset.

   WHAT THIS DOES NOT DO. It does not make the beat shorter, and it must not:
   2.0 s of silence between two different voices is authored (`seam-gap.js`,
   `segment-length-rules.md` §6b), and the beat still runs — the manager waits
   out its remainder after the handover. The point is that the listener finally
   hears the 2.0 s the product documents instead of 9.2 s of nothing.

   AND IT NEVER DELAYS OR MOVES THE BOUNDARY. If the warm element is not ready
   when the out-point fires, `load()` takes exactly the path it takes today.
   Losing the race costs what we already pay; it must never cost the out-point.
*/

/**
 * How much WALL CLOCK before the out-point the next segment starts loading.
 *
 * Sized from the two numbers already in this file rather than picked:
 *
 *   - LOAD_SETTLE_TIMEOUT_MS (10 s) is how long this backend is willing to
 *     wait for a load before calling it broken. A lead shorter than that would
 *     leave a load the player still considers VALID missing the boundary
 *     anyway, which is the bug. So the lead must be at least the deadline.
 *   - The window opens on `timeupdate`, a media event, measured at a 252 ms
 *     median in a hidden page (mp1-background-audio.md §4) — but the widest
 *     tick this repo has actually recorded is 1,825 ms against a 250 ms
 *     nominal. ~2 s of slop covers the trigger's own lateness.
 *
 * 10 s + 2 s = 12 s. The measured 9,153 ms load fits with 2.8 s to spare.
 *
 * The other direction is bounded by the content: no segment may be shorter
 * than 30 s (`docs/curation/segment-length-rules.md`, hard floor), so the lead
 * can never start before the current segment is audible, and Foray #1's
 * segments run 51-238 s (median 103 s) — we spend the next segment's bandwidth
 * only in the last ~11% of a typical one. That is the skip-waste budget: a
 * listener who skips inside the last 12 s has already heard 89% of it.
 *
 * ONE segment ahead, not two. Two would need a third element, would double the
 * bytes a skip throws away, and would buy nothing measurable: the whole cost is
 * a single load, and one lead time already covers it with margin.
 *
 * Divided by playback rate at the point of use, because the load takes wall
 * clock and not content — at 2x this arms 24 s of content early.
 */
export const PREFETCH_LEAD_SEC = 12;

export class HtmlAudioBackend {
  /**
   * @param {object} [opts]
   * @param {HTMLAudioElement} [opts.element] injected for tests
   * @param {HTMLAudioElement} [opts.warmElement] the prefetch element. Injected
   *   for tests; in a browser it is created here. Without one — which is every
   *   `node --test` run that does not ask for it — prefetch is simply
   *   unavailable and every path below behaves exactly as it did before it
   *   existed.
   * @param {boolean} [opts.prefetch] set false to run one-element. The escape
   *   hatch for a runtime where a second element misbehaves.
   * @param {Function} [opts.telemetry]
   * @param {number} [opts.loadTimeoutMs] deadline for either load path.
   *   Injected only so the stall cases are testable in milliseconds instead of
   *   ten seconds.
   */
  constructor({
    element = null, warmElement = null, prefetch = true, telemetry = null,
    loadTimeoutMs = LOAD_SETTLE_TIMEOUT_MS,
  } = {}) {
    const el = element ?? (typeof Audio !== "undefined" ? new Audio() : null);
    if (!el) throw new Error("HtmlAudioBackend requires an <audio> element");

    this.el = el;
    this._telemetry = telemetry;
    this._loadTimeoutMs = loadTimeoutMs;
    this.onItemEnded = null;
    this.onError = null;
    /** Called once per armed boundary, PREFETCH_LEAD_SEC of wall clock before
        it, so whoever owns the queue can say what to warm. The backend has the
        playhead; it does not know what comes next, and it must not learn. */
    this.onPrefetchWindow = null;

    // `preload = auto` so the network fetch starts as soon as src is set,
    // rather than waiting for play() — that is most of the tap-to-audio budget.
    this.el.preload = "auto";
    // Deliberately NOT setting el.crossOrigin. See the header.

    /* The second element. Created the same way as the first so the two are
       interchangeable — they swap roles on every cross-episode seam, and a
       difference between them (in the document vs not, playsinline vs not)
       would be a difference the listener hears on alternate segments. */
    this._warmEl = prefetch === false ? null : (warmElement ?? sameKindOfElement(el));
    if (this._warmEl) {
      this._warmEl.preload = "auto";
      // Same reasoning as above: never `crossOrigin`, on either element.
    }
    /** Non-null once prefetch has been switched off for cause, and it is a
        one-way door: every reason below is "warming coincided with something
        going wrong", and retrying that on a listener's commute is not a
        diagnosis, it is a second failure. */
    this._prefetchOffReason = this._warmEl ? null : "no second element is available";
    /** `{ id, url, offset, ready, failed }` for the item being warmed. */
    this._warm = null;
    /** Detaches the warm element's own listeners. */
    this._warmCleanup = null;
    /** One notification per armed boundary, not one per `timeupdate`. */
    this._prefetchWindowKey = null;
    /** True from a handover until the promoted element has actually produced
        audio. It is the window in which an autoplay refusal is recoverable —
        see `_recoverFromRefusedHandover`. */
    this._handoverUnproven = false;
    /** Every `pause` WE cause. What is left is a pause nobody asked for, which
        on iOS is what losing the audio session looks like from JS. */
    this._expectPause = false;
    /** Ducking level, held on the backend rather than on the element, because
        the element changes underneath it at a handover. */
    this._volume = 1;
    /** Listeners a surface registered through `addMediaListener`, so they can
        be moved to the promoted element instead of being stranded on the
        demoted one. `player/client.js` repaints off these. */
    this._external = new Map();

    this._currentItem = null;
    this._currentUrl = null;
    this._pendingRate = 1.0;
    this._released = false;

    /* out-point state — see §"the out-point" above */
    this._outPoint = null;
    this._outArmed = false;
    this._fineTimer = null;
    this._lastFineTime = null;
    /** Measured overshoot of the last out-point stop, in seconds of content.
        Exposed because "how tight is the boundary?" is a question about the
        running system, not about the test suite (product principle 2). */
    this.lastOutPointOvershootSec = null;

    this._onEnded = () => {
      // The file beat the boundary to it — a segment whose end_sec runs past
      // the real audio. Disarm before reporting, so a late fine wake cannot
      // report a second end for an item that already finished.
      this._disarmOutPoint();
      if (this.onItemEnded) this.onItemEnded(END_NATURAL);
    };
    this._onError = () => {
      const code = this.el.error?.code;
      this._emit(`audio.error code=${code ?? "?"} src=${short(this.el.currentSrc)}`);
      if (this.onError) this.onError(`media error ${code ?? "unknown"}`);
    };
    this._onTimeUpdate = () => {
      this._lastFineTime = null;
      this._watchTick();
      // After the out-point watch, never before: `_watchTick` may reach the
      // boundary on this very tick, and a boundary that has just fired has no
      // next-segment window left to open.
      this._maybeOpenPrefetchWindow();
    };
    this._onSeeked = () => { this._reArmFromPlayhead(); };
    this._onRateChange = () => { this._scheduleFineWatch(); };
    this._onPlaying = () => {
      // The promoted element has produced audio, so the handover is proven and
      // the autoplay-refusal recovery below must not fire for it again.
      this._handoverUnproven = false;
      this._lastFineTime = null;
      this._scheduleFineWatch();
    };
    this._onWaiting = () => { this._clearFineTimer(); };
    this._onPause = () => {
      this._clearFineTimer();
      this._notePause();
    };

    this._attach(this.el);
  }

  /* ---------- which element is the player ----------

     Every listener this class owns lives on `this.el` and moves with the role.
     `_attach`/`_detach` are the only places that know the list, so a handover
     cannot half-migrate it. */

  _attach(el) {
    el.addEventListener("ended", this._onEnded);
    el.addEventListener("error", this._onError);
    el.addEventListener("timeupdate", this._onTimeUpdate);
    el.addEventListener("seeked", this._onSeeked);
    el.addEventListener("ratechange", this._onRateChange);
    el.addEventListener("playing", this._onPlaying);
    el.addEventListener("waiting", this._onWaiting);
    el.addEventListener("pause", this._onPause);
    for (const [type, fns] of this._external) for (const fn of fns) el.addEventListener(type, fn);
  }

  _detach(el) {
    el.removeEventListener("ended", this._onEnded);
    el.removeEventListener("error", this._onError);
    el.removeEventListener("timeupdate", this._onTimeUpdate);
    el.removeEventListener("seeked", this._onSeeked);
    el.removeEventListener("ratechange", this._onRateChange);
    el.removeEventListener("playing", this._onPlaying);
    el.removeEventListener("waiting", this._onWaiting);
    el.removeEventListener("pause", this._onPause);
    for (const [type, fns] of this._external) for (const fn of fns) el.removeEventListener(type, fn);
  }

  /**
   * Listen to the element that is CURRENTLY the player, across handovers.
   *
   * A surface that calls `backend.el.addEventListener` directly is subscribing
   * to one particular element, and a cross-episode seam hands the role to the
   * other one — after which the listener is attached to a paused, src-less
   * element and the UI silently stops repainting for the rest of the Foray.
   * This is not a convenience wrapper; it is the only correct way to listen.
   */
  addMediaListener(type, fn) {
    if (typeof fn !== "function") return;
    if (!this._external.has(type)) this._external.set(type, new Set());
    if (this._external.get(type).has(fn)) return;
    this._external.get(type).add(fn);
    this.el.addEventListener(type, fn);
  }

  removeMediaListener(type, fn) {
    this._external.get(type)?.delete(fn);
    this.el.removeEventListener(type, fn);
  }

  /* ---------- the out-point ---------- */

  /**
   * Arm (or, with null, clear) the boundary at which this item is finished.
   *
   * Arming is conditional on the playhead being BEFORE the boundary right now.
   * That single line is the answer to "what if the user scrubs past end_sec?":
   * they get free play to the file's natural end, because the crossing this
   * watch fires on never happens. Reasoning, since the alternatives are both
   * defensible-sounding:
   *
   *   - Advancing on a manual jump past the end makes the far half of the
   *     scrubber unusable — you could not listen past a boundary at all, and
   *     the transport would fight every attempt.
   *   - Clamping back to end_sec is an audible, unexplained yank, and it is
   *     the player silently overruling a deliberate gesture.
   *   - Free play matches what the boundary actually is: an editorial claim
   *     about where the interesting part stops, not a lock on the episode. The
   *     listener asked to hear what comes next; that is the whole product.
   *
   * It is also reversible with no extra state — scrub back before the boundary
   * and the next crossing stops normally.
   */
  setOutPoint(seconds) {
    this._clearFineTimer();
    this._lastFineTime = null;
    if (seconds == null || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      this._outPoint = null;
      this._outArmed = false;
      return;
    }
    this._outPoint = seconds;
    this._outArmed = this.currentTime < seconds;
    const dur = this.duration;
    if (dur != null && seconds >= dur) {
      // Not an error: end_sec past the real audio just means the file ends
      // first, and `ended` handles it. Worth saying out loud, because it also
      // means the authored end_sec disagrees with the copy in hand.
      this._emit(`outPoint.beyondDuration target=${seconds.toFixed(2)} duration=${dur.toFixed(2)}`);
    }
    this._emit(`outPoint.set ${seconds.toFixed(2)}s armed=${this._outArmed}`);
    this._scheduleFineWatch();
  }

  get outPoint() { return this._outPoint; }

  _disarmOutPoint() {
    this._outPoint = null;
    this._outArmed = false;
    this._lastFineTime = null;
    this._clearFineTimer();
  }

  /** After any seek: re-derive armed-ness from where the playhead actually is.
      This covers the in-point seek on load (arms), a user scrub past the
      boundary (disarms), and a scrub back to an earlier segment (re-arms). */
  _reArmFromPlayhead() {
    if (this._outPoint == null) return;
    const armed = this.currentTime < this._outPoint;
    if (armed !== this._outArmed) {
      this._outArmed = armed;
      this._emit(`outPoint.${armed ? "reArmed" : "disarmed"} at=${this.currentTime.toFixed(2)}`);
    }
    this._lastFineTime = null;
    this._scheduleFineWatch();
  }

  /** Coarse stage. Cheap, runs ~4x/s while anything plays. */
  _watchTick() {
    if (this._outPoint == null || this._released) return;
    if (!this._outArmed) {
      // Free-playing past a boundary the listener scrubbed over. Re-arm only
      // if they have come back to before it.
      if (this.currentTime < this._outPoint) {
        this._outArmed = true;
        this._emit(`outPoint.reArmed at=${this.currentTime.toFixed(2)}`);
      } else return;
    }
    if (this.currentTime >= this._outPoint) return this._reachOutPoint();
    this._scheduleFineWatch();
  }

  /** Fine stage. Only ever scheduled inside the last ARM_LEAD_SEC. */
  _scheduleFineWatch() {
    this._clearFineTimer();
    if (this._released || this._outPoint == null || !this._outArmed) return;
    if (this.el.paused) return; // nothing is moving; play/timeupdate re-schedules
    const rate = typeof this.el.playbackRate === "number" && this.el.playbackRate > 0
      ? this.el.playbackRate : 1;
    const remainingWallSec = (this._outPoint - this.currentTime) / rate;
    if (remainingWallSec > OUT_POINT_ARM_LEAD_SEC) return; // timeupdate will bring us closer
    const ms = Math.max(OUT_POINT_MIN_TIMER_MS, Math.ceil(remainingWallSec * 1000));
    // Not unref'd either: this is the timer that STOPS the audio at the
    // boundary. It is always cleared on reach, disarm, pause or release, so it
    // can never outlive the item it belongs to.
    this._fineTimer = setTimeout(() => {
      this._fineTimer = null;
      this._onFineWake();
    }, ms);
  }

  _onFineWake() {
    if (this._released || this._outPoint == null || !this._outArmed) return;
    const t = this.currentTime;
    if (t >= this._outPoint) return this._reachOutPoint();

    // Woke early. Either ordinary timer jitter (reschedule, we are within a
    // few ms) or the playhead is not moving at all (a buffering stall). Only
    // the second one can spin, so only the second one stands down.
    if (this._lastFineTime !== null && t <= this._lastFineTime) {
      this._lastFineTime = null;
      this._emit(`outPoint.stalled at=${t.toFixed(2)} — handing back to timeupdate`);
      return;
    }
    this._lastFineTime = t;
    this._scheduleFineWatch();
  }

  /** The boundary. Pause first, then report the same end a finished file
      reports — the manager and the reducer must not be able to tell which. */
  _reachOutPoint() {
    const target = this._outPoint;
    const at = this.currentTime;
    this._disarmOutPoint();
    this.lastOutPointOvershootSec = Math.max(0, at - target);
    this._emit(
      `outPoint.reached target=${target.toFixed(2)} at=${at.toFixed(2)} ` +
      `overshoot=${this.lastOutPointOvershootSec.toFixed(3)}s`
    );
    // Our own pause, at the boundary, and a prefetch is normally in flight
    // right now — so it must not be mistaken for the session being taken.
    this._expectPause = true;
    this.el.pause();
    if (this.onItemEnded) this.onItemEnded(END_OUT_POINT);
  }

  _clearFineTimer() {
    if (this._fineTimer == null) return;
    clearTimeout(this._fineTimer);
    this._fineTimer = null;
  }

  /* ---------- prefetch (see §"prefetch" in the header) ---------- */

  /** Whether warming is available at all. False in `node --test` unless a warm
      element was injected, and false forever once it has been switched off for
      cause — so a caller can ask instead of assuming, and so the manager's
      wiring is a no-op rather than a crash on a backend without it. */
  get canPrefetch() {
    return this._warmEl != null && this._prefetchOffReason == null && !this._released;
  }

  /** Why warming is off, or null. Read by telemetry and by tests; a silent
      capability is one nobody can tell has stopped working. */
  get prefetchOffReason() { return this._prefetchOffReason; }

  /** What the warm element currently holds, for assertions and telemetry. */
  get warmState() {
    if (!this._warm) return null;
    return { id: this._warm.id, url: this._warm.url, offset: this._warm.offset, ready: this._warm.ready };
  }

  /**
   * Start loading `item` on the warm element so the next boundary can hand over
   * to something already `canplay` at `startOffset`.
   *
   * Returns true only if a warm load was actually started or is already in
   * flight for exactly this item and offset. Every refusal is a telemetry line,
   * because "prefetch quietly did nothing" and "prefetch was not needed" look
   * identical from the outside and have very different fixes.
   *
   * NO TIMERS. Not one. The trigger is `timeupdate` (a media event, 252 ms
   * median in a hidden page) and completion is `loadedmetadata`/`seeked`/
   * `canplay`. A hidden page's DOM timers align to 1 s (WebKit) and are
   * throttled ~21x (Blink, measured), so anything here that depended on a
   * sub-second timer would be the same defect wearing a different hat. There is
   * also no deadline on a warm load: it has nothing to strand — if it never
   * finishes, the boundary simply takes the ordinary path.
   */
  prefetch(item, { startOffset = 0 } = {}) {
    if (!this.canPrefetch) {
      this._emit(`prefetch.unavailable ${item?.id ?? "?"}: ${this._prefetchOffReason ?? "released"}`);
      return false;
    }
    if (!item?.audio_url) {
      this._emit(`prefetch.skipped ${item?.id ?? "?"}: no audio_url`);
      return false;
    }
    /* SAME EPISODE IS NOT WARMED, and this is not an optimisation — it is
       correctness. 15 of Foray #1's 31 seams stay inside one episode, and
       `load()` serves those by MOVING THE PLAYHEAD in the buffer the element
       already holds (see `_seekWithinLoadedSource`). Warming the same URL on
       the other element would refetch a whole podcast episode to reach a
       position we already have, and on an ad-stitched host the refetch can
       return a different stitch — the exact hazard the same-source shortcut
       exists to avoid. */
    if (item.audio_url === this._currentUrl) {
      this._emit(`prefetch.skipped ${item.id}: same episode — the seek shortcut already covers this seam`);
      return false;
    }
    const offset = Number.isFinite(startOffset) && startOffset > 0 ? startOffset : 0;
    if (this._warm && this._warm.url === item.audio_url && this._warm.offset === offset && !this._warm.failed) {
      return true; // already in flight or already warm for exactly this
    }

    this._discardWarm(`replacedBy:${item.id}`);
    const el = this._warmEl;
    const warm = { id: item.id, url: item.audio_url, offset, ready: false, failed: false };
    this._warm = warm;

    /* Resolve-condition parity with `load()`: metadata first, THEN the offset
       (assigning currentTime at readyState 0 is discarded), then ready only
       once the playhead is near the offset AND the element can produce audio.
       If the warm element were declared ready on `canplay` for the buffered
       HEAD of the file, the handover would start the next segment at 0:00 of
       somebody else's episode — the seam would be gone and replaced by a much
       worse bug. This is the same trap `onCanPlay` documents below. */
    const onMeta = () => {
      if (warm.offset > 0) {
        try { el.currentTime = warm.offset; } catch (_) { /* browser refused; the check below then fails honestly */ }
      }
      this._settleWarm(warm);
    };
    const onProgress = () => this._settleWarm(warm);
    const onErr = () => {
      warm.failed = true;
      this._emit(`prefetch.failed ${warm.id} (code ${el.error?.code ?? "?"}) — the boundary will load it the slow way`);
      // NOT a reason to switch prefetching off: one bad episode is not a broken
      // mechanism, and the boundary's own load will report the real failure
      // through the manager's degrade path.
    };
    this._warmCleanup = () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("seeked", onProgress);
      el.removeEventListener("canplay", onProgress);
      el.removeEventListener("error", onErr);
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("seeked", onProgress);
    el.addEventListener("canplay", onProgress);
    el.addEventListener("error", onErr);

    this._emit(`prefetch.started ${warm.id} -> ${Math.round(offset)}s (while the current segment is still audible)`);
    el.src = warm.url;
    el.load();
    return true;
  }

  _settleWarm(warm) {
    if (this._warm !== warm || warm.ready || warm.failed) return;
    const el = this._warmEl;
    const near = warm.offset === 0 || Math.abs((el.currentTime ?? 0) - warm.offset) <= 1;
    if (!near || (el.readyState ?? 0) < READY_ENOUGH) return;
    warm.ready = true;
    this._emit(`prefetch.ready ${warm.id} at ${Math.round(el.currentTime ?? 0)}s — the next seam is a beat, not a load`);
  }

  /** The window in which the next segment must start loading if it is going to
      be ready. Fires once per armed boundary. */
  _maybeOpenPrefetchWindow() {
    if (this._released || !this.canPrefetch) return;
    if (this._outPoint == null || !this._outArmed) return;
    if (this.el.paused) return;
    const key = `${this._currentUrl}@${this._outPoint}`;
    if (this._prefetchWindowKey === key) return;
    const rate = typeof this.el.playbackRate === "number" && this.el.playbackRate > 0 ? this.el.playbackRate : 1;
    const remainingWallSec = (this._outPoint - this.currentTime) / rate;
    if (remainingWallSec > PREFETCH_LEAD_SEC) return;
    this._prefetchWindowKey = key;
    this._emit(`prefetch.window ${remainingWallSec.toFixed(1)}s of wall clock before the boundary`);
    if (this.onPrefetchWindow) {
      // A surface's bad handler must never take the audio down with it, and the
      // out-point watch runs on this same tick.
      try { this.onPrefetchWindow(); } catch (err) { this._emit(`prefetch.window.threw ${err?.message ?? err}`); }
    }
  }

  /** Is the warm element ready to BE the player for exactly this request? */
  _warmReadyFor(url, startOffset) {
    if (!this._warm || !this._warm.ready || this._warm.failed) return false;
    if (this._warm.url !== url) return false;
    const want = Number.isFinite(startOffset) && startOffset > 0 ? startOffset : 0;
    return this._warm.offset === want;
  }

  /**
   * The handover. Swap roles so the already-loaded element becomes the player.
   *
   * ORDER IS THE SAFETY PROPERTY: the outgoing element is paused BEFORE the
   * swap, so there is no instant at which two elements are un-paused. On iOS
   * that is not tidiness — a second element that begins playing takes the audio
   * session and silences the first, and a foreground test would never show it.
   */
  _promoteWarm(item, startOffset) {
    const outgoing = this.el;
    const incoming = this._warmEl;
    const warm = this._warm;

    this._detach(outgoing);
    this._expectPause = true;
    try { outgoing.pause(); } catch (_) { /* already paused */ }
    // Drop the demoted element's buffer rather than leaving it decoding — the
    // same reason `release()` does it.
    try { outgoing.removeAttribute("src"); outgoing.load(); } catch (_) { /* fine */ }

    this.el = incoming;
    this._warmEl = outgoing;
    if (this._warmCleanup) { this._warmCleanup(); this._warmCleanup = null; }
    this._warm = null;
    this._prefetchWindowKey = null;
    this._attach(this.el);

    // State that lives on the BACKEND has to be re-applied to whatever element
    // is now the player: neither of these survives the swap on its own.
    try { this.el.volume = this._volume; } catch (_) { /* fine */ }
    this.el.playbackRate = this._pendingRate;

    this._currentItem = item;
    this._currentUrl = item.audio_url;
    this._handoverUnproven = true;
    this._emit(
      `load.handover ${item.id} -> ${Math.round(startOffset)}s ` +
      `(prefetched: no wait at this boundary)`
    );
    return Promise.resolve();
  }

  /** Stop warming and let go of whatever the warm element holds. */
  _discardWarm(why) {
    if (this._warmCleanup) { this._warmCleanup(); this._warmCleanup = null; }
    if (!this._warm) return;
    const id = this._warm.id;
    this._warm = null;
    if (this._warmEl) {
      try { this._warmEl.removeAttribute("src"); this._warmEl.load(); } catch (_) { /* fine */ }
    }
    this._emit(`prefetch.discarded ${id}: ${why}`);
  }

  /** One-way. Every caller is a case of "warming coincided with something
      going wrong", and the fallback is the behaviour that shipped before it. */
  _disablePrefetch(reason) {
    if (this._prefetchOffReason) return;
    this._prefetchOffReason = reason;
    this._discardWarm("prefetchDisabled");
    this._emit(`prefetch.disabled: ${reason}`);
  }

  /**
   * A `pause` event nobody asked for.
   *
   * On iOS, losing the audio session to another element looks exactly like
   * this from JS, and the prompt case is the one thing warming could plausibly
   * cause: a second element loading media while the first is playing. We cannot
   * prevent it and we must not resume through it (a real interruption — a
   * phone call — arrives the same way, and playing over that would be worse
   * than silence). So it stands warming down for the rest of the session and
   * says so, which turns an invisible failure into a recorded one.
   */
  _notePause() {
    if (this._expectPause) { this._expectPause = false; return; }
    if (!this._warm) return; // an ordinary pause with nothing being warmed
    this._emit("audio.pausedUnexpectedly while a prefetch was in flight");
    this._disablePrefetch("playback stopped while a prefetch was in flight — refusing to warm again");
  }

  /**
   * A promoted element refused to play.
   *
   * The one failure mode a handover introduces that the single-element player
   * does not have: autoplay policy is per ELEMENT, and the element the listener
   * tapped is the other one. In the Capacitor shells this cannot happen
   * (`mediaTypesRequiringUserActionForPlayback = []`, MP1 §7.3) but the web PWA
   * is a real shipping target, and there exactly one handover per session is
   * exposed — the first, after which both elements have played.
   *
   * "Report an error" is not good enough: the manager's degrade path stops the
   * Foray, and a listener with a locked screen cannot tap. So this falls back
   * onto the element that DOES hold the gesture, at the same offset, and
   * re-arms the same boundary — the listener gets one slow seam (what they get
   * today) instead of a dead Foray, and warming is off from then on.
   *
   * @returns true if the rejection was handled here.
   */
  _recoverFromRefusedHandover(el, err) {
    if (this._released || el !== this.el || !this._handoverUnproven) return false;
    const item = this._currentItem;
    const blessed = this._warmEl;
    if (!item || !blessed) return false;

    this._handoverUnproven = false;
    this._disablePrefetch(`a promoted element refused to play (${err?.name ?? err}) — autoplay policy is per element`);
    // The out-point the manager armed on the promoted element. `load()` clears
    // it by contract, so it has to be carried across by hand: a recovery that
    // forgot it would play this segment to the end of its whole source episode,
    // which is a median 936.5 s of the wrong show (mp1-background-audio.md §3).
    const boundary = this._outPoint;
    const offset = this.currentTime;
    this._emit(`handover.refused ${item.id} — retrying on the element that holds the gesture`);

    this._detach(this.el);
    this._expectPause = true;
    try { this.el.pause(); } catch (_) { /* fine */ }
    try { this.el.removeAttribute("src"); this.el.load(); } catch (_) { /* fine */ }
    this._warmEl = this.el;
    this.el = blessed;
    this._attach(this.el);
    this._currentUrl = null; // the blessed element holds nothing; force a real load
    this._disarmOutPoint();

    this.load(item, { startOffset: offset }).then(
      () => {
        if (this._released) return;
        if (boundary != null) this.setOutPoint(boundary);
        this.play();
      },
      (loadErr) => {
        // Now it is a genuine failure and the manager's degrade path is right.
        this._emit(`handover.recovery.failed ${item.id}: ${loadErr?.message ?? loadErr}`);
        if (this.onError) this.onError(`play rejected: ${err?.name ?? err}`);
      }
    );
    return true;
  }

  /* ---------- loading ---------- */

  /**
   * Point the element at an item and resolve once it can produce audio at the
   * requested offset. Rejects on a media error so the manager's degrade path
   * (corner case #6/#10) can run.
   */
  load(item, { startOffset = 0 } = {}) {
    if (this._released) return Promise.reject(new Error("backend released"));
    if (!item?.audio_url) return Promise.reject(new Error(`item ${item?.id} has no audio_url`));

    // Contract: a load drops any armed boundary. See the header.
    this._disarmOutPoint();
    this._prefetchWindowKey = null;

    // SAME SOURCE = A SEEK, NOT A LOAD. Consecutive Foray segments frequently
    // share an episode, and re-assigning `src` — even to the identical string
    // — restarts the media load algorithm: the buffer is discarded, there is
    // an audible gap, and on an ad-stitched host the refetch can return a
    // DIFFERENT stitch, which moves every subsequent timestamp under us. So
    // when the element already holds this URL we keep the buffer and move the
    // playhead, which is also what makes back-to-back segments gapless.
    if (this._currentUrl && this._currentUrl === item.audio_url && this.el.readyState >= 1 && !this.el.error) {
      this._currentItem = item;
      // Whatever was being warmed was warmed for a different "next" than the
      // one we just turned out to want — see the invariant below.
      this._discardWarm(`notNeededBy:${item.id}`);
      this._emit(`load.sameSource ${item.id} -> ${Math.round(startOffset)}s (seek, no refetch)`);
      return this._seekWithinLoadedSource(startOffset);
    }

    /* THE HANDOVER, and the ONE invariant that keeps it honest: after this
       method, the warm element has either become the player or holds nothing.
       Never a third state. A warm element left holding a segment the listener
       has already skipped past is a buffer waiting to be promoted for the wrong
       item — the "next segment starts mid-word" failure — and dropping it costs
       only a re-warm at the next window, 12 s before it is needed. */
    if (this._warmReadyFor(item.audio_url, startOffset)) return this._promoteWarm(item, startOffset);
    this._discardWarm(`notReadyFor:${item.id}`);

    this._currentItem = item;
    this._currentUrl = item.audio_url;

    return new Promise((resolve, reject) => {
      const el = this.el;
      let settled = false;

      let timer = null;
      const cleanup = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("canplay", onCanPlay);
        el.removeEventListener("error", onErr);
        el.removeEventListener("seeked", onSeeked);
        if (timer != null) clearTimeout(timer);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(msg));
      };

      const onErr = () => fail(`load failed (code ${el.error?.code ?? "?"}) for ${item.id}`);

      // Offset is applied here, not before: assigning currentTime at
      // readyState 0 is discarded, and doing it after playback starts would
      // let the episode's opening be briefly audible before the jump.
      const onMeta = () => {
        if (startOffset > 0 && Number.isFinite(startOffset)) {
          try { el.currentTime = startOffset; } catch (_) { /* browser refused; continue at 0 */ }
        }
      };
      const onSeeked = () => { if (el.readyState >= READY_ENOUGH) done(); };
      const onCanPlay = () => {
        // If we asked for an offset, wait until we are actually near it —
        // otherwise `canplay` can fire for the buffered head while the seek
        // is still resolving.
        if (startOffset > 0 && Math.abs(el.currentTime - startOffset) > 1) return;
        done();
      };

      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("canplay", onCanPlay);
      el.addEventListener("seeked", onSeeked);
      el.addEventListener("error", onErr);
      // A fetch that stalls without erroring would otherwise hang here forever.
      // Same hole as the in-place path, same fix, and NOT unref'd.
      timer = setTimeout(
        () => fail(`load of ${item.id} did not settle within ${this._loadTimeoutMs}ms`),
        this._loadTimeoutMs
      );

      // Re-pointing a PLAYING element fires `pause` as the media load algorithm
      // starts. That is our own doing, so it must not read as the session being
      // taken from us — see `_notePause`.
      this._expectPause = true;
      el.src = item.audio_url;
      el.load();
    });
  }

  /**
   * The in-point for an item whose audio is already loaded and buffered.
   *
   * Resolves on the same condition the full load does — playhead near the
   * offset AND ready to produce audio — so the manager's ordering guarantee
   * (nothing audible until the asset is at the right position) survives the
   * shortcut.
   *
   * IT MUST ALWAYS SETTLE, and that is the whole reason for the error listener
   * and the deadline. Seeking into an unbuffered region drops `readyState`
   * below HAVE_FUTURE_DATA, so this waits for a refill — and a refill that
   * never arrives is the ordinary network-stall shape, where browsers fire
   * `stalled`/`suspend` and **never** `error`. A promise that never settles
   * leaves `_loadItem` awaiting forever, the state machine stuck in
   * `loadingItem` with no recovery, and these two listeners leaked; a much
   * later `canplay` could then resolve the zombie and dispatch a stale
   * `itemLoaded` for an item the player left minutes ago. Rejecting instead
   * hands the problem to the manager's existing degrade path (corner case
   * #6/#10), which is what every other load failure already uses.
   */
  _seekWithinLoadedSource(startOffset) {
    const el = this.el;
    const target = typeof startOffset === "number" && Number.isFinite(startOffset) && startOffset > 0
      ? startOffset : 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const near = () => Math.abs(el.currentTime - target) <= 1 && el.readyState >= READY_ENOUGH;
      const cleanup = () => {
        el.removeEventListener("seeked", onProgress);
        el.removeEventListener("canplay", onProgress);
        el.removeEventListener("error", onErr);
        if (timer != null) clearTimeout(timer);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(msg));
      };
      const onProgress = () => { if (near()) done(); };
      const onErr = () => fail(`in-place seek to ${Math.round(target)}s failed (code ${el.error?.code ?? "?"})`);

      el.addEventListener("seeked", onProgress);
      el.addEventListener("canplay", onProgress);
      el.addEventListener("error", onErr);
      // Deliberately NOT unref'd — see LOAD_SETTLE_TIMEOUT_MS.
      timer = setTimeout(
        () => fail(`in-place seek to ${Math.round(target)}s did not settle within ${this._loadTimeoutMs}ms`),
        this._loadTimeoutMs
      );

      try { el.currentTime = target; } catch (_) { /* not seekable yet; events will settle it */ }
      if (near()) done();
    });
  }

  /* ---------- transport ---------- */

  play() {
    if (this._released) return;
    // Rate has to be re-applied after a load: assigning src resets
    // playbackRate to 1 in most browsers, so the manager's restoreRate effect
    // (which fires before startPlayback) would otherwise be undone by the load.
    this.el.playbackRate = this._pendingRate;
    const el = this.el;
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        // A promoted element refusing to play is recoverable and must not stop
        // the Foray — see `_recoverFromRefusedHandover`.
        if (this._recoverFromRefusedHandover(el, err)) return;
        // NotAllowedError = autoplay policy: the first play must come from a
        // real gesture. Surface it as state, never as an unhandled rejection.
        this._emit(`play.rejected ${err?.name ?? err}`);
        if (this.onError) this.onError(`play rejected: ${err?.name ?? err}`);
      });
    }
  }

  pause() {
    if (this._released) return;
    this._expectPause = true;
    this.el.pause();
  }

  seek(seconds, { precise = false } = {}) {
    if (this._released) return;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return;
    // `precise` comes from seek-policy.js (#30). The element seeks the same
    // way either way — the flag is carried so it can be logged, and so a
    // future backend that supports approximate/fast seeking can use it.
    this._emit(`seek ${Math.round(seconds)}s precise=${precise}`);
    try { this.el.currentTime = seconds; } catch (_) { /* not seekable yet */ }
    // Don't wait for the element's own `seeked` to re-derive armed-ness: it is
    // asynchronous, and between the assignment and the event a fine timer
    // scheduled against the OLD playhead could still be pending. Doing it here
    // makes the scrub-past-the-end decision take effect on the same tick as
    // the scrub. The later `seeked` repeats it harmlessly.
    this._reArmFromPlayhead();
  }

  setRate(rate) {
    const r = typeof rate === "number" && rate > 0 ? rate : 1.0;
    this._pendingRate = r;
    if (!this._released) this.el.playbackRate = r;
  }

  /** 0..1. Ducking for hold-to-talk uses this rather than a Web Audio gain
      node, because no `crossorigin` means Web Audio cannot see this element. */
  setVolume(v) {
    if (this._released) return;
    // Held on the backend as well as written to the element: a handover swaps
    // the element underneath this, and a duck that silently reset to 1.0 on the
    // next segment would be a bug with no visible cause.
    this._volume = Math.min(1, Math.max(0, Number(v) || 0));
    this.el.volume = this._volume;
  }

  get currentTime() { return this.el?.currentTime ?? 0; }

  get duration() {
    const d = this.el?.duration;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  }

  get currentItem() { return this._currentItem; }

  release() {
    if (this._released) return;
    this._released = true;
    this._disarmOutPoint();
    // Before `_released` stops it mattering, and before the listeners go: the
    // warm element is holding a buffer too, and it must not be left decoding.
    this._discardWarm("released");
    this._detach(this.el);
    this._expectPause = true;
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load(); // drop the buffer rather than leaving it decoding
    this._currentItem = null;
    this._currentUrl = null;
  }

  _emit(m) { if (this._telemetry) this._telemetry(m); }
}

/** A second element of the same kind as the first, so the two are genuinely
    interchangeable — they alternate roles for the life of the session, and any
    asymmetry between them becomes a difference the listener hears on every
    other segment. In `node --test` there is no `Audio` and no `document`, so
    this returns null and prefetching is simply unavailable. */
function sameKindOfElement(el) {
  let warm = null;
  if (typeof Audio !== "undefined") warm = new Audio();
  else if (typeof document !== "undefined" && document.createElement) warm = document.createElement("audio");
  if (!warm) return null;
  // Match document membership: WebKit's audibility bookkeeping is per element,
  // and an out-of-document element is a needless difference from the one that
  // is currently working.
  if (el?.parentNode && typeof el.parentNode.insertBefore === "function") {
    try { el.parentNode.insertBefore(warm, el.nextSibling ?? null); } catch (_) { /* detached is fine */ }
  }
  if (typeof warm.setAttribute === "function" && el?.hasAttribute?.("playsinline")) {
    warm.setAttribute("playsinline", "");
  }
  return warm;
}

function short(u) {
  if (!u) return "";
  return String(u).slice(0, 60);
}

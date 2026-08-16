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

   ONE ELEMENT, FOR THE LIFETIME OF THE APP. Creating an element per item is
   the web equivalent of corner case #19's two-AVPlayers bug: the old one keeps
   decoding and you get two things audible at once. There is exactly one, and
   it is reused.

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

export class HtmlAudioBackend {
  /**
   * @param {object} [opts]
   * @param {HTMLAudioElement} [opts.element] injected for tests
   * @param {Function} [opts.telemetry]
   * @param {number} [opts.loadTimeoutMs] deadline for either load path.
   *   Injected only so the stall cases are testable in milliseconds instead of
   *   ten seconds.
   */
  constructor({ element = null, telemetry = null, loadTimeoutMs = LOAD_SETTLE_TIMEOUT_MS } = {}) {
    const el = element ?? (typeof Audio !== "undefined" ? new Audio() : null);
    if (!el) throw new Error("HtmlAudioBackend requires an <audio> element");

    this.el = el;
    this._telemetry = telemetry;
    this._loadTimeoutMs = loadTimeoutMs;
    this.onItemEnded = null;
    this.onError = null;

    // `preload = auto` so the network fetch starts as soon as src is set,
    // rather than waiting for play() — that is most of the tap-to-audio budget.
    this.el.preload = "auto";
    // Deliberately NOT setting el.crossOrigin. See the header.

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
    this._onTimeUpdate = () => { this._lastFineTime = null; this._watchTick(); };
    this._onSeeked = () => { this._reArmFromPlayhead(); };
    this._onRateChange = () => { this._scheduleFineWatch(); };
    this._onPlaying = () => { this._lastFineTime = null; this._scheduleFineWatch(); };
    this._onWaiting = () => { this._clearFineTimer(); };
    this._onPause = () => { this._clearFineTimer(); };

    this.el.addEventListener("ended", this._onEnded);
    this.el.addEventListener("error", this._onError);
    this.el.addEventListener("timeupdate", this._onTimeUpdate);
    this.el.addEventListener("seeked", this._onSeeked);
    this.el.addEventListener("ratechange", this._onRateChange);
    this.el.addEventListener("playing", this._onPlaying);
    this.el.addEventListener("waiting", this._onWaiting);
    this.el.addEventListener("pause", this._onPause);
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
    this.el.pause();
    if (this.onItemEnded) this.onItemEnded(END_OUT_POINT);
  }

  _clearFineTimer() {
    if (this._fineTimer == null) return;
    clearTimeout(this._fineTimer);
    this._fineTimer = null;
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

    // SAME SOURCE = A SEEK, NOT A LOAD. Consecutive Foray segments frequently
    // share an episode, and re-assigning `src` — even to the identical string
    // — restarts the media load algorithm: the buffer is discarded, there is
    // an audible gap, and on an ad-stitched host the refetch can return a
    // DIFFERENT stitch, which moves every subsequent timestamp under us. So
    // when the element already holds this URL we keep the buffer and move the
    // playhead, which is also what makes back-to-back segments gapless.
    if (this._currentUrl && this._currentUrl === item.audio_url && this.el.readyState >= 1 && !this.el.error) {
      this._currentItem = item;
      this._emit(`load.sameSource ${item.id} -> ${Math.round(startOffset)}s (seek, no refetch)`);
      return this._seekWithinLoadedSource(startOffset);
    }

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
    const p = this.el.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        // NotAllowedError = autoplay policy: the first play must come from a
        // real gesture. Surface it as state, never as an unhandled rejection.
        this._emit(`play.rejected ${err?.name ?? err}`);
        if (this.onError) this.onError(`play rejected: ${err?.name ?? err}`);
      });
    }
  }

  pause() { if (!this._released) this.el.pause(); }

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
    this.el.volume = Math.min(1, Math.max(0, Number(v) || 0));
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
    this.el.removeEventListener("ended", this._onEnded);
    this.el.removeEventListener("error", this._onError);
    this.el.removeEventListener("timeupdate", this._onTimeUpdate);
    this.el.removeEventListener("seeked", this._onSeeked);
    this.el.removeEventListener("ratechange", this._onRateChange);
    this.el.removeEventListener("playing", this._onPlaying);
    this.el.removeEventListener("waiting", this._onWaiting);
    this.el.removeEventListener("pause", this._onPause);
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load(); // drop the buffer rather than leaving it decoding
    this._currentItem = null;
    this._currentUrl = null;
  }

  _emit(m) { if (this._telemetry) this._telemetry(m); }
}

function short(u) {
  if (!u) return "";
  return String(u).slice(0, 60);
}

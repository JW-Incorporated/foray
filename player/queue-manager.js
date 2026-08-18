/* Player queue manager — the layer between the pure reducer and the audio
   backend. Port of ios/App/Player/PlayerQueueManager.swift (issue #33).

   The reducer (queue-state.js) is a pure function of its own inputs and
   deliberately owns none of the following. This does:

     1. the queue — the flat item list and where we are in it
     2. resolving "next", including skipping over bridge TTS items
     3. interpreting every PlayerEffect into a backend call
     4. the 15s position timer, which the reducer explicitly does not model
     5. cold-launch restore, before any network (corner case #15)
     6. route policy (auto-resume only on known car routes, corner case #13)
     7. the single-instance invariant (corner case #19)

   Nothing here mutates player state directly. Every transition goes through
   `reduce()`. If you can find a state change in this file that did not come out
   of the reducer, that is a bug — the two-layer defence against overlapping
   audio depends on it.

   ── Backend contract (implemented by #24) ─────────────────────────────────
   Injected, never imported, so this runs under `node --test` with a fake:

     async load(item, { startOffset })   resolve when ready to produce audio,
                                         and CLEAR any armed out-point
     play() / pause()
     seek(seconds, { precise })
     setOutPoint(seconds | null)         stop there, report a normal end
     setRate(rate)
     get currentTime()  -> seconds
     get duration()     -> seconds | null
     release()
     onItemEnded = fn(reason)  assigned by this manager
     onError = fn              assigned by this manager

   ── Forays (issues #111 / #65) ────────────────────────────────────────────
   A Foray is an ordered list of segments, each a `[start_sec, end_sec]` slice
   of a *different* episode. Everything above already handles that except two
   things, and both live here rather than in the reducer:

     8. the in-point — a segment's `start_sec` is the load's `startOffset`, and
        it OVERRIDES any saved episode position (resuming a segment to where
        the listener last left that episode drops them outside the segment)
     9. the ADR-0007 ladder at load time, which is the only moment the observed
        duration of the copy in hand exists — see `_segmentGate`

   The out-point itself is not here: the reducer emits `setOutPoint`, the
   backend watches the playhead, and when the boundary lands the backend
   reports the same `onItemEnded` a finished file reports. `_handleBackendItem-
   Ended` below cannot tell the difference, and that is the design.

   ── 10. The seam beat (`player/seam-gap.js`) ──────────────────────────────
   An unbridged segment-to-segment seam gets 2.0 s of silence before the next
   segment becomes audible. The RULE lives in seam-gap.js; the CLOCK lives here,
   for the same reason the 15 s position timer does — the reducer models no
   timers, and adding a `gapping` state would buy nothing the deadline below
   does not already give us. `queue-state.js` is unchanged by this feature.

   Two properties worth stating, because both are easy to get wrong:

     THE GAP IS NOT AUDIO. Nothing is appended to, padded onto or re-encoded
     into an episode file. The beat is wall clock between the out-point pausing
     the element and `startPlayback` running. Product principle 3 holds by
     construction: we never touch the bytes.

     THE GAP ABSORBS THE LOAD, it does not follow it. The deadline is stamped
     the instant the out-point fires, and the next item's `backend.load()` runs
     IMMEDIATELY — inside the beat. Only the dispatch of `itemLoaded` (which is
     what arms the out-point and starts playback) waits out the remainder. So
     total silence is `max(gap, load)`, never `gap + load`. Ordering it the
     other way is the difference between a graceful beat and a stall, and on a
     cold CDN it is the difference between 2 s and 5 s.

   ── 11. Warming the next segment — PARKED, DEFAULT OFF ─────────────────────
   Everything in this section describes a mechanism that **is not enabled**. It
   shipped, was measured on an iOS Simulator (run 32057395270) making the seam
   WORSE than the bug — the segment was dropped, not merely delayed — and is now
   off unless a caller passes `prefetch: true`. The reasoning below about the
   "audible window" is the part that was wrong: media-element load tasks are
   throttled by VISIBILITY, DOM timers by AUDIBILITY, and this feature was built
   on generalising the second to the first. `html-audio-backend.js` §"prefetch"
   carries the refutation and the numbers; `docs/research/mp1-background-audio.md`
   §4.1a carries the rule. `_warmNextSegment` below is therefore dead code in
   production, kept because the question is still open and the wiring is correct.

   §10's `max(gap, load)` is the best ordering available with one element, and
   it is still the defect, because on a backgrounded phone the load is not 2 s:
   run 32036295743 measured `askedGapMs: 2000` against `observedGapMs: 9153`,
   with the beat armed 2 ms after the boundary and every remaining millisecond
   spent in the media load — for a file bundled inside the app. The backend's
   header carries the full stage trace and the cause: the boundary pauses the
   element, a silent page loses the audibility the platform keys its scheduling
   off, and the load then runs in the worst window there is.

   So the load moves off the boundary. The backend warms the NEXT segment on a
   second element while the current one is still audible and hands over at the
   boundary. THE MANAGER'S PART IS ONE QUESTION — when the backend says the
   window is open, what comes next and where does it start — and deliberately
   nothing more: the queue is the one thing here a backend must never learn.

   Two properties to preserve:

     WARMING USES THE BEAT'S OWN RULE. Eligibility is `seamGapSec(...) > 0`, the
     same call that decides the beat, not a second copy of "is this a
     segment-to-segment seam". Warm exactly the transitions that get a beat and
     the two cannot drift apart.

     THE BEAT IS STILL SPENT IN FULL. `_awaitSeamGap` is untouched, so a
     handover that finishes early waits out the remainder and the listener hears
     the authored 2.0 s instead of 9.2 s of nothing. The beat is an editorial
     pause between two voices, not an artifact of loading; shortening it was
     never the fix.

   ── 12. THE LISTENER'S SPEED, AND WHY IT LIVES HERE ────────────────────────
   The ladder and the labels are `player/playback-rate.js`; the chosen value is
   `this._rate`, and this class is the only thing that owns it. That is not
   layering for its own sake — it is where the bug was.

   `playbackRate` resets to 1 when a media element loads a new source in several
   engines, and a Foray changes source at every cross-episode seam, so the naive
   version of this feature works until the first seam and then silently drops
   back to 1x mid-listen. `html-audio-backend.js` already survives THAT: it holds
   `_pendingRate` and re-applies it in `play()`.

   **The reset that actually shipped was ours, and it was worse than the engine's
   one.** `restoreRate` read `item?.rate ?? 1.0` — and no queue item in this repo
   has ever carried a `rate` field, so the effect was an unconditional
   `setRate(1.0)`. The reducer emits `restoreRate` on EVERY `itemLoaded` for a
   non-TTS item, which means the listener's speed was thrown away:

     - at the first `play()`, so a stored 1.5x never applied at all; and
     - at every single seam, so a speed changed mid-Foray survived exactly one
       segment — a median 103 s — and then reverted with nothing on screen to
       say so.

   So `restoreRate` restores `this._rate` now. An authored `item.rate` still
   wins, because that is the escape hatch the effect was named for; nothing
   authors one today.

   TTS IS STILL 1.0x, and `setRate` respects that live (corner case #18). A
   bridge is one line of our own narration at a level and pace we chose; playing
   it at 2x is not a feature. `resetRateForTTS` forces 1.0 on the way in and
   `restoreRate` brings the listener's speed back on the way out, so the only new
   rule is that a tap arriving WHILE narration is audible is stored and applied
   when the narration ends rather than mid-word.
*/

import { reduce, S, E, itemRef, itemBounds, TTS, END_NATURAL, END_OUT_POINT } from "./queue-state.js";
import { SINGLE_ITEM, assertStrategy } from "./queue-strategy.js";
import { seekPrecision, FOREIGN, APPROXIMATE } from "./seek-policy.js";
import { buildForayQueue } from "./foray-queue.js";
import { seamGapSec, describeSeam, SEAM_GAP_SEC, AUTO_ADVANCE } from "./seam-gap.js";
import { normalizeRate, DEFAULT_RATE } from "./playback-rate.js";

const POSITION_INTERVAL_MS = 15_000;

/** Wall clock for the seam beat. Injected so the suite drives the beat by hand
    instead of sleeping: a test that asserts "2 s elapsed" is a test that goes
    red when the box is busy, and this repo has already paid for that once
    (#195, `player/html-audio-backend.test.js` under a transcription queue).
    `schedule` returns its own cancel, so nothing here has to track timer ids. */
const REAL_SCHEDULER = Object.freeze({
  nowMs: () => Date.now(),
  // Never unref'd: something awaits this. See LOAD_SETTLE_TIMEOUT_MS in
  // html-audio-backend.js for the CI failure that lesson came from.
  schedule: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
});

/** Exactly one manager for the app's lifetime. Together with the reducer's own
    double-entry guard this is the two-layer defence against corner case #19
    (two players alive after a fast skip). A second construction is a
    programming error, not a recoverable condition. */
let liveInstance = null;

export class PlayerQueueManager {
  /**
   * @param {object}   opts
   * @param {object}   opts.backend        see the contract above
   * @param {object}   [opts.positionStore] { save(id, seconds), load(id) } — #26
   * @param {object}   [opts.strategy]     see queue-strategy.js; default SINGLE_ITEM
   * @param {Function} [opts.telemetry]    (message) => void
   * @param {boolean}  [opts.allowMultiple] test-only escape hatch
   * @param {number}   [opts.seamGapSec]   length of the unbridged-seam beat
   * @param {object}   [opts.scheduler]    `{ nowMs(), schedule(ms, fn) -> cancel }`
   * @param {Function} [opts.onSeamGapChange] (inGap: boolean) => void — fires
   *   when a beat starts and when it ends. A surface needs this because a beat
   *   produces no media events to repaint on.
   * @param {number}   [opts.rate]  the listener's speed (§12). Stored, not
   *   applied: a constructor that reached into the backend would make building a
   *   manager audible. `setRate()` is what applies it, and `client.js` calls it
   *   once at boot with the stored value.
   */
  constructor({
    backend, positionStore = null, strategy = SINGLE_ITEM, telemetry = null, allowMultiple = false,
    seamGapSec: gapSec = SEAM_GAP_SEC, scheduler = REAL_SCHEDULER, onSeamGapChange = null,
    rate = DEFAULT_RATE,
  } = {}) {
    if (!backend) throw new Error("PlayerQueueManager requires a backend");
    if (liveInstance && !allowMultiple) {
      throw new Error(
        "PlayerQueueManager already exists — exactly one instance may be alive (corner case #19). " +
        "Call dispose() on the old one first."
      );
    }
    if (!allowMultiple) liveInstance = this;

    this.backend = backend;
    this.positionStore = positionStore;
    this.strategy = assertStrategy(strategy);
    this._telemetry = telemetry;
    // Passed straight through, deliberately un-sanitised: `seam-gap.js` already
    // owns what a nonsense length means (it collapses to no beat), and a second
    // policy here — the first draft quietly turned a negative into 2.0 — would
    // be two answers to one question.
    this.seamGapSec = gapSec;
    this._scheduler = scheduler ?? REAL_SCHEDULER;
    this._onSeamGapChange = typeof onSeamGapChange === "function" ? onSeamGapChange : null;

    this.state = S.idle();
    this.queue = [];
    this.currentIndex = -1;
    this._timer = null;
    this._knownCarRoutes = new Set();
    this._forceNextOffset = null;
    // Two distinct notions of "where we are", conflated in the Swift:
    //   currentIndex  what is actually LOADED — savePosition writes against it
    //   _targetIndex  where a skip is HEADING, before the load resolves
    // Keeping them apart is what lets a fast double-skip advance two items
    // while still saving the outgoing episode's playhead against the right id.
    this._targetIndex = null;
    this._disposed = false;
    /** The id the backend last successfully loaded. Distinct from currentIndex:
        it answers "is this a re-entry into the item we are already inside?",
        which is what separates a resume from a restart for a bounded item. */
    this._loadedId = null;
    /** Set by setQueueFromForay; consulted by the load-time ladder. */
    this._forayOptions = { isLocalFile: false, allowAdPad: false };
    /** The listener's chosen speed (§12). The ONE place it lives: the backend's
        `_pendingRate` is a cache of whatever it was last told, and the button's
        label is painted from here, so a divergence between them is not
        expressible. Normalised on the way in so nothing downstream — the
        element, `setPositionState`, a label — ever sees a value off the
        ladder. */
    this._rate = normalizeRate(rate);

    /* ---- the seam beat (see §10 in the header) ----
       `_gapUntil` is an ABSOLUTE deadline, stamped when the out-point fires,
       not a duration counted from when the load happens to finish. That one
       choice is what makes the load run inside the beat instead of after it,
       and it is also why skipping an unplayable segment mid-beat consumes the
       remainder rather than restarting it. */
    this._gapUntil = null;
    /** Resolves the parked wait. Non-null exactly while one exists. */
    this._gapFinish = null;
    /** Stops the beat's timer without resolving anything. */
    this._gapStopTimer = null;
    /** The beat was cut and its wait is parked, awaiting `_releaseSeamGap`. */
    this._gapCut = false;
    /** Bumped on every load. A wait that returns to find this changed is a
        wait whose item has been superseded — by a skip, a jump, or the ladder
        — and it must not dispatch `itemLoaded` for an item nobody is on.
        WHEN it is compared is the load-bearing part; see `_transport`. */
    this._loadSeq = 0;

    /** A backend with no out-point watch cannot play a Foray at all — it would
        run each segment to the end of its whole episode. Recorded once here so
        the refusal below can name the cause instead of the symptom. */
    this._outPointCapable = typeof backend.setOutPoint === "function";

    /* Warming the next segment (§11). Wired only for a backend that can honour
       it: the native backend (#28) may never implement `prefetch`, and every
       fake in this repo's suites does not — so this is a capability check rather
       than politeness, and its absence is the behaviour that shipped before. */
    if (typeof backend.prefetch === "function") {
      backend.onPrefetchWindow = () => this._warmNextSegment();
    }

    backend.onItemEnded = (reason) => this._handleBackendItemEnded(reason);
    backend.onError = (msg) => this._handle(E.error(String(msg)));
  }

  /* ---------- lifecycle ---------- */

  dispose() {
    this._stopTimer();
    // `_disposed` first: the released wait's continuation then hits `_handle`'s
    // disposed guard instead of dispatching into a torn-down player.
    this._disposed = true;
    this._cutSeamGap("dispose");
    this._releaseSeamGap();
    if (liveInstance === this) liveInstance = null;
    if (typeof this.backend.release === "function") this.backend.release();
  }

  /* ---------- queue construction ---------- */

  /** Build the queue from a picked item using the injected strategy.
      `context` is passed straight through (e.g. `{ others }` for PICKED_FIRST). */
  setQueueFromPick(picked, context = {}) {
    this.queue = this.strategy.build(picked, context).filter(Boolean);
    this.currentIndex = -1;
    this._emit(`queue.built.${this.strategy.name}.n=${this.queue.length}`);
    return this.queue;
  }

  /** Set an explicit queue, bypassing the strategy. Used by cold-launch
      restore, where the queue is whatever it was, not whatever the strategy
      would build today. */
  loadQueue(items) {
    this.queue = (items || []).filter(Boolean);
    this.currentIndex = -1;
  }

  /* ---------- Forays (#111) ---------- */

  /**
   * Load a Foray as the queue. The strategy is bypassed on purpose: a Foray is
   * already an ordered list somebody authored, and no strategy gets a vote on
   * it. It is also ONE queue — when the last segment ends, the session ends
   * (CLAUDE.md principle 1, no chaining into a second Foray).
   *
   * @returns the build report from `buildForayQueue`, including `skipped` —
   *   read it. A Foray that lost a segment to the ADR-0007 ladder is a shorter
   *   Foray, and the caller is the only layer that can say so.
   */
  setQueueFromForay(foray, opts = {}) {
    const report = buildForayQueue(foray, opts);
    const bounded = report.items.filter((i) => boundsOf(i));
    if (bounded.length && !this._outPointCapable) {
      // Loud, and before anything is audible. Silently playing each segment to
      // the end of its whole episode is the one outcome worse than not playing.
      throw new Error(
        "this backend has no setOutPoint(); a Foray cannot play on it — " +
        `${bounded.length} of ${report.items.length} items carry an out-point`
      );
    }
    this._forayOptions = { isLocalFile: Boolean(opts.isLocalFile), allowAdPad: Boolean(opts.allowAdPad) };
    this.loadQueue(report.items);
    this._emit(
      `queue.foray.${report.id}.n=${report.items.length}` +
      `.skipped=${report.skipped.length}.warnings=${report.warnings.length}`
    );
    for (const s of report.skipped) this._emit(`foray.segment.skipped[${s.index}]: ${s.reason}`);
    for (const w of report.warnings) this._emit(`foray.warning: ${w}`);
    return report;
  }

  /** Build the Foray's queue and start it. The whole API a surface needs. */
  async playForay(foray, opts = {}) {
    const report = this.setQueueFromForay(foray, opts);
    if (!report.items.length) {
      this._emit(`foray.${report.id}.empty — every item was skipped`);
      return report;
    }
    await this.play(0);
    return report;
  }

  /* ---------- transport ----------

     EVERY entry point below cuts a running seam beat, and that is one rule
     rather than five special cases: the beat exists to mark an edit the
     listener did not ask for, so the moment they touch the transport it has
     nothing left to say.

     They all go through `_transport`, and that is not decoration — see the
     comment on it. Calling `_cutSeamGap` directly from a transport method is
     the bug it exists to prevent. */

  /**
   * Run a transport action that must end any running seam beat first.
   *
   * The beat's clock stops immediately, but the load that was waiting on it is
   * PARKED and only released once `run()` has finished.
   *
   * That ordering is the whole point, and getting it wrong is subtle enough to
   * be worth spelling out. When a beat is cut, the waiting `_loadItem` has to
   * answer one question: "am I still the load this player is on?" It answers by
   * comparing `_loadSeq`. But a transport action cuts the beat BEFORE it issues
   * its own replacement load, so at cut time `_loadSeq` has not moved yet and
   * the answer is always a stale yes — the abandoned wait then dispatches
   * `itemLoaded` into the middle of the new action's effect loop, arming an
   * out-point that the replacement `load()` immediately clears (the backend
   * contract) and starting playback before the replacement has any audio. The
   * segment then runs to the end of the whole source episode with no boundary
   * at all, which `_perform`'s setOutPoint refusal calls the one outcome worse
   * than not playing.
   *
   * Deferring the comparison by a microtask is NOT enough: `skipToPrevious`
   * emits `savePosition` and `pausePlayback` before `loadItem`, so its bump is
   * two awaits away. Parking until `run()` returns needs no counting — by then
   * the action has issued whatever load it was going to issue, so `_loadSeq`
   * simply tells the truth. Observed, not predicted (product principle 2).
   */
  async _transport(why, run) {
    this._cutSeamGap(why);
    try {
      return await run();
    } finally {
      this._releaseSeamGap();
    }
  }

  async play(index = 0) {
    const item = this.queue[index];
    if (!item) return this._emit(`play.ignored.noItemAt=${index}`);
    return this._transport("play", () => {
      this.currentIndex = index;
      return this._handle(E.play(refOf(item)));
    });
  }

  async resume() {
    const item = this._currentItem();
    if (!item) return this._emit("resume.ignored.noCurrentItem");
    return this._transport("resume", () => this._handle(E.play(refOf(item))));
  }

  /** Pause is modelled as an interruption, matching the Swift. This slightly
      overloads `interrupted`'s telemetry meaning but keeps "why are we paused"
      as a single code path — see the note in PlayerQueueState.swift. */
  async pause() {
    return this._transport("pause", () => this._handle(E.interruptionBegan()));
  }

  async skipToNext() {
    return this._transport("skipToNext", () => this._skipToNext());
  }

  async _skipToNext() {
    const next = this._nextItem(this._cursor(), true);
    if (next) this._targetIndex = next.index;
    // currentIndex is NOT advanced here. The reducer's skip emits savePosition
    // BEFORE loadItem, and savePosition writes whatever currentIndex points at
    // — so advancing first would stamp the *incoming* episode with the outgoing
    // one's playhead (0 on a fresh skip), destroying its resume point before
    // the load ever reads it. `_loadItem` moves the index instead, once it
    // knows what actually loaded.
    //
    // Worth flagging: PlayerQueueManager.swift has this same ordering and
    // therefore the same bug. See the note on #33.
    await this._handle(E.skipToNext(next ? refOf(next.item) : null));
  }

  /** Restarts the current item in place. `04_VOICE_AUDIO_SPEC.md` specifies
      "prevTrack = restart item / previous"; true previous-item behaviour is
      flagged there as an undecided taste call and is not decided here. */
  async skipToPrevious() {
    return this._transport("skipToPrevious", () => {
      // "Restart" must mean zero. Without this the reducer's savePosition fires
      // first, stores the current playhead, and the reload then resumes to the
      // exact spot the user just asked to leave.
      this._forceNextOffset = 0;
      return this._handle(E.skipToPrevious(null));
    });
  }

  async stop() {
    await this._transport("stop", () => this._handle(E.stop()));
    this._stopTimer();
  }

  /** @param {object} [opts] `{ precise }` — decided by seek-policy.js (#30),
      never by this manager. */
  async seek(seconds, opts = {}) {
    return this._transport("seek", () => this._handle(E.seek(seconds, Boolean(opts.precise))));
  }

  /* ---------- the listener's speed (§12) ---------- */

  /** The chosen speed. What the button's label is painted from — never the
      element's live `playbackRate`, which is 1 for the moment after a load
      assigns a src and would make the label flicker at every seam. */
  get rate() { return this._rate; }

  /**
   * Change the listener's speed. Survives every seam, because `restoreRate` now
   * reads `this._rate` (§12).
   *
   * DELIBERATELY NOT A `_transport` ACTION, and the distinction is the seam
   * beat's own rule (`seam-gap.js`): every transport method cuts a running beat
   * because the beat marks an edit the listener did not ask for, and touching the
   * transport means they have named a destination. Changing speed names no
   * destination — it is a preference about how the rest of the hour sounds — so
   * cutting the beat here would start the next segment early and swallow the
   * authored 2.0 s for a tap that was not about going anywhere.
   *
   * It also does not need to be: the beat is wall clock and the element is paused
   * for it, so writing the rate mid-beat is applied to a stopped element and
   * `play()` re-applies it at the far side.
   *
   * @param {number} rate  snapped onto the ladder by `normalizeRate`
   * @returns {number} the rate now in force
   */
  setRate(rate) {
    const r = normalizeRate(rate);
    const was = this._rate;
    this._rate = r;
    /* NARRATION IS NOT SPED UP, EVER (corner case #18). If a bridge is what is
       audible right now, the value is STORED and applied when `restoreRate` fires
       at the end of it — so a tap during narration is not lost, it just does not
       take effect mid-word. Without this the guarantee `resetRateForTTS` exists
       to make would hold for every path except a listener touching the control at
       the wrong moment, which is precisely when a guarantee stops being one. */
    if (this._narrationIsAudible()) {
      this._emit(`rate.deferred=${r} — narration is audible and plays at 1.0x`);
      return r;
    }
    this.backend.setRate(r);
    if (r !== was) this._emit(`rate.set=${r} (was ${was})`);
    return r;
  }

  /** Is the thing making sound right now one of our own narration lines? Read
      from the LOADED item rather than from the reducer's state, because
      `transitioning` covers the bridge loading as well as playing and the item
      is what carries the kind. */
  _narrationIsAudible() {
    return this.state.type === "transitioning" || this._currentItem()?.kind === TTS;
  }

  /* ---------- interruptions and routes ---------- */

  async interruptionBegan() {
    return this._transport("interruption", () => this._handle(E.interruptionBegan()));
  }
  async interruptionEnded(shouldResume) { await this._handle(E.interruptionEnded(Boolean(shouldResume))); }

  /** Corner case #13. The reducer never auto-resumes; that policy lives here.
      A route reappearing only resumes if we have seen it before as a car route
      — otherwise plugging in headphones would blast audio unasked. */
  async routeChanged({ oldDeviceUnavailable, routeName = null, isCarRoute = false }) {
    if (isCarRoute && routeName) this._knownCarRoutes.add(routeName);
    // Losing the output device mid-beat is not the beat's business to finish:
    // the next thing that happens is a pause, and a beat that outlived it would
    // start audio into a dead route the moment the timer fired. A route
    // BECOMING available cannot interrupt a beat — that path only acts on an
    // `interrupted` state — so it needs no cut and takes the plain call.
    if (oldDeviceUnavailable) {
      await this._transport("routeLost", () => this._handle(E.routeChanged(true)));
    } else {
      await this._handle(E.routeChanged(false));
    }

    if (!oldDeviceUnavailable && routeName && this._knownCarRoutes.has(routeName)) {
      const item = this._currentItem();
      if (item && this.state.type === "interrupted" && this.state.wasPlaying) {
        this._emit(`route.autoResume.knownCar=${routeName}`);
        await this._handle(E.play(refOf(item)));
      }
    }
  }

  /* ---------- cold launch (corner case #15) ---------- */

  /** Rebuild queue and position from local state BEFORE any network call.
      Airplane-mode cold launch is an acceptance test, so nothing here may
      await the network. */
  async restoreColdLaunchState({ items, index = 0, autoplay = false }) {
    this.loadQueue(items);
    if (!this.queue[index]) return this._emit("restore.ignored.badIndex");
    this.currentIndex = index;

    const item = this.queue[index];
    const seconds = this._savedPositionFor(item.id);

    // No seek event here: `_loadItem` carries the offset into the load, so the
    // asset is prepared at the right position and nothing is ever audible from
    // the wrong one. See the note there.
    if (autoplay) await this._handle(E.play(refOf(item)));
    this._emit(`restore.index=${index}.position=${Math.round(seconds)}s`);
  }

  /* ---------- the pump ---------- */

  async _handle(event) {
    if (this._disposed) return;
    const [next, effects] = reduce(this.state, event);
    this.state = next;
    for (const effect of effects) await this._perform(effect);
    this._syncTimer();
  }

  /** Every effect gets an explicit case. An unhandled one throws rather than
      silently doing nothing — a missed effect is a stuck player, and that is
      far harder to diagnose later than a loud failure now. */
  async _perform(effect) {
    switch (effect.type) {
      case "loadItem":
        return this._loadItem(effect.item);

      case "startPlayback":
        return this.backend.play();

      case "pausePlayback":
        return this.backend.pause();

      case "savePosition":
        return this._persistPosition();

      case "seekTo":
        return this.backend.seek(effect.seconds, { precise: effect.precise });

      case "seekRejected":
        return this._emit(`seek.rejected: ${effect.reason}`);

      case "setOutPoint":
        // setQueueFromForay asserts the capability, but loadQueue() and
        // restoreColdLaunchState() reach the queue without going through it —
        // a cold-launch restore of a Foray is exactly that path. So this has to
        // be a real refusal. THROWING is the refusal: `_perform` runs inside a
        // loop over the effect list, so a bare `return` here would emit the
        // telemetry and then let `startPlayback` run anyway, which is precisely
        // the "plays the whole episode" outcome the message claims to prevent.
        // The throw lands in `_loadItem`'s catch -> E.error -> idle + pause.
        if (!this._outPointCapable) {
          throw new Error(
            `backend has no setOutPoint(); cannot stop at ${Math.round(effect.seconds)}s, ` +
            "refusing rather than playing the whole episode"
          );
        }
        return this.backend.setOutPoint(effect.seconds);

      case "resetRateForTTS":
        // Corner case #18. Deliberately the literal 1.0 and NOT `this._rate`:
        // narration is our own line at a pace we chose, and this effect exists
        // to override the listener's speed rather than to consult it.
        return this.backend.setRate(1.0);

      case "restoreRate": {
        const item = this._currentItem();
        /* §12. This used to be `item?.rate ?? 1.0`, which — since no queue item
           has ever carried a `rate` — was an unconditional reset to 1x on every
           `itemLoaded`, i.e. at the first play AND at every seam. That is the
           whole "the speed silently reverts mid-listen" defect, and it was ours
           rather than the engine's. An authored per-item rate still wins; the
           listener's speed is the floor under it. */
        return this.backend.setRate(item?.rate ?? this._rate);
      }

      case "playTransitionTTS":
        return this._playTransitionBridge();

      case "emitTelemetry":
        return this._emit(effect.message);

      default:
        throw new Error(`unhandled PlayerEffect: ${effect.type}`);
    }
  }

  async _loadItem(ref) {
    /* Claim this load. A wait that comes back to find this changed has been
       superseded and must not start audio for an item nobody is on — see
       `_transport` for why the comparison cannot be made any earlier. */
    const seq = ++this._loadSeq;
    const item = this._itemFor(ref);
    if (!item) {
      // Above the try, so the catch's cut does not cover it — drop the deadline
      // here or it outlives the seam that armed it.
      this._endSeamGap("unknownRef");
      return this._handle(E.error(`loadItem: unknown ref ${ref.id}`));
    }
    // Resume offset rides on the LOAD, exactly as the Swift does
    // (`backend.load(url:startOffset:)`) — not as a seek afterwards.
    //
    // Seeking after the fact cannot work here anyway: on a cold launch the
    // state is `idle`, and the reducer rejects a seek in `idle`. The first
    // draft did that and silently restored nothing, which the cold-launch test
    // caught. Carrying the offset into the load also removes the race the
    // pendingSeek contract exists to manage, and means the user never hears a
    // half-second of the episode's opening before being yanked to 30:00.
    //
    // TTS bridges always start at zero — resuming into the middle of a
    // one-line transition would be nonsense.
    const forced = this._forceNextOffset;
    this._forceNextOffset = null;
    // A segment's in-point OVERRIDES any saved position, always (#65 §4).
    // Resuming to where the listener last left this episode would drop them
    // outside the segment entirely — usually into a different story.
    const bounds = boundsOf(item);
    this._targetIndex = null;
    // Bounds beat `forced` too, and that is the point of putting them first:
    // skipToPrevious means "restart this item", and for a segment the start of
    // the item is `start_sec`, not 0:00 of a two-hour episode.
    //
    // ...except when we are re-entering the item we are already inside. Every
    // resume path in this class routes back through loadItem — a paused
    // player, a declined call, a car reconnecting — so a flat "segments always
    // load at start_sec" replays the whole segment when the listener takes a
    // phone call 100 seconds in. Observed, not declared (principle 2): if the
    // playhead is inside THIS item's slice and nothing asked for a restart,
    // that is a resume.
    const playhead = this.backend.currentTime;
    const resumingInPlace = Boolean(
      bounds && forced == null && this._loadedId === item.id &&
      typeof playhead === "number" && Number.isFinite(playhead) &&
      playhead > bounds.startSec &&
      (bounds.endSec == null || playhead < bounds.endSec)
    );
    const startOffset = bounds
      ? (resumingInPlace ? playhead : bounds.startSec)
      : (forced ?? (item.kind === TTS ? 0 : this._savedPositionFor(item.id)));

    // Move the index only now — after savePosition has already run against the
    // outgoing item. currentIndex tracks what is actually loaded, never what we
    // intend to load.
    const idx = this.queue.findIndex((i) => i.id === item.id);
    if (idx >= 0) this.currentIndex = idx;

    try {
      await this.backend.load(item, { startOffset });
      this._loadedId = item.id;
      // The ladder's rung 3 runs HERE and nowhere earlier: this is the first
      // moment the duration of the copy the listener actually received exists.
      const gate = this._segmentGate(item);
      if (!gate.ok) {
        this._emit(`foray.segment.skipped.atLoad ${item.id}: ${gate.reason}`);
        return this._skipUnplayableSegment();
      }
      if (gate.note) this._emit(`foray.segment.${item.id}: ${gate.note}`);
      /* The seam beat is spent HERE, between a loaded-and-positioned asset and
         the `itemLoaded` that arms the out-point and starts it. Everything
         expensive already happened, so the remaining silence is the beat and
         nothing else. A load that FAILED never reaches this line — an error
         must not wait two seconds to be reported. */
      if (!(await this._awaitSeamGap(seq))) {
        return this._emit(`seam.gap.superseded ${item.id} — a newer load owns the player`);
      }
      await this._handle(E.itemLoaded());
    } catch (err) {
      // Drop the deadline with the item it belonged to. `_awaitSeamGap` is the
      // only other place that clears it and this path never reaches it, so
      // without this a failed seam leaves a live deadline that the NEXT load —
      // possibly a cold-launch restore, which touches no transport method —
      // would sit out for up to two seconds for no reason.
      this._endSeamGap("loadFailed");
      await this._handle(E.error(`loadItem(${ref.id}) failed: ${err?.message ?? err}`));
    }
  }

  /* ---------- the seam beat ---------- */

  /** Milliseconds still owed at this seam. Zero when no beat is running. */
  get seamGapRemainingMs() {
    if (this._gapUntil == null) return 0;
    return Math.max(0, this._gapUntil - this._scheduler.nowMs());
  }

  /** True from the moment a seam is armed until the beat is spent or cut —
      which includes the load happening inside it, because that load is silence
      the listener is already hearing as part of the beat.

      The surface reads this so it can say "a beat is running" instead of
      "Loading…", and so the main button means STOP for those two seconds
      rather than START. `_gapUntil` is the single source of truth: every path
      that ends a beat nulls it. */
  get inSeamGap() {
    return this._gapUntil != null;
  }

  /** The one writer of `_gapUntil`, so the "a beat started / ended" hook can
      never disagree with the flag the surface reads. */
  _setGapDeadline(untilMs) {
    const was = this._gapUntil != null;
    this._gapUntil = untilMs;
    if (was !== (untilMs != null) && this._onSeamGapChange) {
      // The page has no media event to repaint on during a beat — the element
      // is paused and `timeupdate` has stopped — so without this the UI sits on
      // its last frame for the whole 2 s and the `gap` flag never reaches it.
      try { this._onSeamGapChange(untilMs != null); } catch (_) { /* a surface must never break the player */ }
    }
  }

  /**
   * Decide whether this transition is a seam, and if so stamp the deadline.
   * Called at the moment the out-point (or a natural end) fires, which is the
   * only moment that makes the beat absorb the load rather than follow it.
   */
  _armSeamGap(from, to, bridged) {
    const seam = { from, to, bridged, cause: AUTO_ADVANCE, gapSec: this.seamGapSec };
    const sec = seamGapSec(seam);
    if (sec <= 0) return;
    this._setGapDeadline(this._scheduler.nowMs() + sec * 1000);
    this._emit(`seam.gap.armed ${describeSeam(seam)}`);
  }

  /**
   * The backend's playhead watch says the boundary is `PREFETCH_LEAD_SEC` of
   * wall clock away. Name the segment that boundary will advance to, and where
   * it starts, so that its load happens while the current one is still audible.
   *
   * Synchronous on purpose: it is called from inside a media event, it touches
   * no state of ours and dispatches no event, so it cannot interleave with the
   * reducer. Everything about HOW the load happens — the second element, the
   * readiness condition, the handover — is the backend's, and stays there.
   *
   * A warmed segment can still be refused at load time by the ADR-0007 ladder
   * (`_segmentGate`), in which case the bytes are wasted and the skip proceeds
   * exactly as it does today. A wasted warm load is the cheapest failure here
   * and is not worth a guard.
   */
  _warmNextSegment() {
    if (this._disposed) return;
    // Only a running item is approaching a boundary. A beat, a pause or a load
    // in flight has no seam to cover yet — and `_cursor()` would answer for an
    // in-flight skip rather than for what is playing.
    if (this.state.type !== "playing") return;
    const next = this._nextItem(this._cursor(), false);
    if (!next) return this._emit("prefetch.none: nothing follows this item");
    const from = this._currentItem();
    const to = next.item;
    const seam = { from, to, bridged: to.kind === TTS, cause: AUTO_ADVANCE, gapSec: this.seamGapSec };
    // The beat's own rule, CALLED rather than re-implemented (§11): warm exactly
    // the transitions that get a beat, and the two cannot drift apart.
    if (seamGapSec(seam) <= 0) return this._emit(`prefetch.skipped ${to.id}: ${describeSeam(seam)}`);
    const bounds = boundsOf(to);
    // The in-point, which is the same offset `_loadItem` will ask for. A warm
    // element parked anywhere else is not promoted — see the backend's
    // `_warmReadyFor` — so getting this wrong costs a slow seam, never a
    // segment that starts in the wrong place.
    this.backend.prefetch(to, { startOffset: bounds ? bounds.startSec : 0 });
  }

  /**
   * Hold the remainder of the beat, then say whether this load still owns the
   * player.
   *
   * Three ways out, and the reducer — not this method — decides what each one
   * means, which is why none of them needs a new state:
   *
   *   1. the timer runs out. `itemLoaded` in `loadingItem`: the out-point is
   *      armed and the segment starts. The ordinary case.
   *   2. a transport action cut the beat and issued no replacement load. A
   *      pause left us `interrupted` and a stop left us `idle`, and the reducer
   *      ignores a stray `itemLoaded` in both — so the beat ends and NOTHING
   *      becomes audible, which is exactly what pause has to mean. A seek left
   *      us in `loadingItem` with a `pendingSeek`, so `itemLoaded` applies the
   *      seek and starts playback there: scrubbing ends the beat early. This is
   *      why a cut must not abandon by itself — a scrub that abandoned would
   *      strand the player in `loadingItem` with nothing left to start it.
   *   3. a newer load claimed `_loadSeq` — a skip, a row tap, or the ADR-0007
   *      ladder walking past an unplayable segment. This returns false and the
   *      caller abandons quietly; the newer load is already carrying the queue.
   *
   * 2 and 3 are told apart by WHEN the comparison happens, not by a flag the
   * caller sets: `_transport` releases a parked wait only after the action's
   * own effects are done, so `_loadSeq` has already moved if it was going to.
   */
  _awaitSeamGap(seq) {
    const ms = this.seamGapRemainingMs;
    if (ms <= 0) {
      this._setGapDeadline(null);
      return Promise.resolve(this._loadSeq === seq);
    }
    this._emit(`seam.gap.hold ${Math.round(ms)}ms`);
    return new Promise((resolve) => {
      let settled = false;
      // Idempotent, and it stops its own timer, so the timer path and the
      // release path are one function. Assigned BEFORE the timer is scheduled:
      // a scheduler that fires synchronously would otherwise have `finish`
      // clear the field and the next line put it straight back.
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this._gapStopTimer) this._gapStopTimer();
        this._gapStopTimer = null;
        this._gapFinish = null;
        this._gapCut = false;
        this._setGapDeadline(null);
        resolve(this._loadSeq === seq);
      };
      this._gapFinish = finish;
      this._gapCut = false;
      this._gapStopTimer = this._scheduler.schedule(ms, finish);
    });
  }

  /** Stop a running beat's clock and forget its deadline, so the NEXT load does
      not inherit it. The waiting load is left PARKED rather than released —
      `_releaseSeamGap` finishes the job. Safe when no beat is running. */
  _cutSeamGap(why) {
    this._setGapDeadline(null);
    if (this._gapFinish == null || this._gapCut) return;
    this._gapCut = true;
    if (this._gapStopTimer) this._gapStopTimer();
    this._gapStopTimer = null;
    this._emit(`seam.gap.cut.${why}`);
  }

  /** Let a parked wait go, now that the action which cut it has finished its
      own effects and `_loadSeq` tells the truth. See `_transport`. */
  _releaseSeamGap() {
    if (this._gapFinish && this._gapCut) this._gapFinish();
  }

  /** Cut and release in one go, for the internal paths that end a seam without
      being a transport action — a load that failed, a queue that ran out, a ref
      that does not resolve. None of them has a wait parked (they all run before
      `_awaitSeamGap`, or after it has already resolved), so this is belt and
      braces: it guarantees no path can leave one parked forever. */
  _endSeamGap(why) {
    this._cutSeamGap(why);
    this._releaseSeamGap();
  }

  /**
   * ADR-0007's ladder, evaluated against the copy in hand.
   *
   * Only segments on a DAI source reach the interesting part; everything else
   * settled at build time. A failure here is a SKIP, never a play at the stale
   * offset — ADR-0007's "honest failure, never a bad cut", and #111's
   * acceptance criterion that the drift case is logged rather than silent.
   */
  _segmentGate(item) {
    if (!item?.needs_drift_check) return { ok: true };

    const observed = this.backend.duration;
    if (typeof observed !== "number" || !Number.isFinite(observed)) {
      return {
        ok: false,
        reason: "the copy in hand reports no duration, so the ad load cannot be compared to the reference",
      };
    }

    const { precision, reason } = seekPrecision(
      { id: item.source_item_id, dai_suspected: item.dai_suspected },
      {
        isLocalFile: this._forayOptions.isLocalFile,
        source: FOREIGN,
        observedDuration: observed,
        recordedDuration: item.reference_duration_sec,
        adPadSec: item.ad_pad_sec ?? undefined,
        allowAdPad: this._forayOptions.allowAdPad,
      }
    );
    if (precision === APPROXIMATE) return { ok: false, reason };
    return { ok: true, note: `${precision} — ${reason}` };
  }

  /** Leave a segment we refused, without ever making it audible. The state is
      still `loadingItem` — nothing has been started, because `itemLoaded` was
      never dispatched — and `skipToNext` from there replaces the in-flight
      target rather than stacking a second load, the same path a fast double-
      skip uses. With nothing left it lands on `ended`, so a Foray whose every
      segment fails the ladder terminates instead of looping.

      Deliberately no direct `backend.pause()`: the reducer owns every
      transition (see the file header), and nothing is audible here anyway —
      `load()` stops the element, and every route into this point has already
      paused or ended. */
  async _skipUnplayableSegment() {
    const next = this._nextItem(this._cursor(), false);
    if (next) this._targetIndex = next.index;
    // With something left, the deadline is deliberately kept: the refusal
    // happened INSIDE the beat, so the replacement segment spends what remains
    // of it rather than starting a second one. With nothing left there is no
    // load coming to spend it, so drop it — see the note in the catch above.
    else this._endSeamGap("queueExhausted");
    await this._handle(E.skipToNext(next ? refOf(next.item) : null));
  }

  _savedPositionFor(id) {
    if (!this.positionStore) return 0;
    const saved = this.positionStore.load(id);
    const s = saved && typeof saved.seconds === "number" ? saved.seconds : 0;
    return Number.isFinite(s) && s > 0 ? s : 0;
  }

  /** A missing bridge must never stall the queue — corner case #12's spirit
      extended: don't let a missing transition line block episode audio. */
  async _playTransitionBridge() {
    if (this.state.type !== "transitioning") return this._emit("playTransitionTTS.withoutTransitioningState");
    const bridge = this._itemFor(this.state.to);
    if (!bridge) return this._advancePastBridgeFailure();
    const bIdx = this.queue.findIndex((i) => i.id === bridge.id);
    if (bIdx >= 0) this.currentIndex = bIdx;
    try {
      await this.backend.load(bridge, { startOffset: 0 });
      this.backend.play();
    } catch (err) {
      this._emit(`transitionTTS.loadFailed: ${err?.message ?? err}`);
      await this._advancePastBridgeFailure();
    }
  }

  async _advancePastBridgeFailure() {
    const next = this._nextItem(this._cursor(), true);
    await this._handle(E.itemEnded(next ? refOf(next.item) : null, false));
  }

  /** Backend says the asset finished. Resolve what "next" means from the queue,
      then feed exactly one itemEnded into the reducer.
      `reason` reaches telemetry and stops there — the reducer must not be able
      to tell an out-point from a file running out, because the entire value of
      reusing this path is that every downstream transition stays identical. */
  async _handleBackendItemEnded(reason = END_NATURAL) {
    if (reason === END_OUT_POINT) {
      const item = this._currentItem();
      this._emit(`item.ended.outPoint ${item?.id ?? "?"}@${Math.round(item?.end_sec ?? 0)}s`);
    }
    if (this.state.type === "transitioning") {
      const next = this._nextItem(this._cursor(), true);
      return this._handle(E.itemEnded(next ? refOf(next.item) : null, false));
    }
    if (this.state.type === "playing") {
      const next = this._nextItem(this._cursor(), false);
      // Nothing follows: the Foray is over and a beat before silence is just
      // silence. Same for the state above — a bridge already marks its seam.
      if (!next) return this._handle(E.itemEnded(null, false));
      const bridged = next.item.kind === TTS;
      // Stamp the deadline BEFORE dispatching: `itemEnded` runs the next
      // `loadItem` synchronously down this same call, and the whole point is
      // for that load to happen inside the beat.
      this._armSeamGap(this._currentItem(), next.item, bridged);
      return this._handle(E.itemEnded(refOf(next.item), bridged));
    }
    return this._emit(`backend.itemEnded.ignored.state=${this.state.type}`);
  }

  /* ---------- queue lookups ---------- */

  /** Where the next lookup should count from: the in-flight skip target if one
      is pending, otherwise what is loaded. */
  _cursor() { return this._targetIndex ?? this.currentIndex; }

  _itemFor(ref) { return this.queue.find((i) => i.id === ref.id) ?? null; }
  _currentItem() { return this.queue[this.currentIndex] ?? null; }

  _nextItem(from, skipBridges) {
    for (let i = from + 1; i < this.queue.length; i++) {
      if (skipBridges && this.queue[i].kind === TTS) continue;
      return { index: i, item: this.queue[i] };
    }
    return null;
  }

  /* ---------- position ---------- */

  /** The periodic half of the persistence rule. The event-driven half is the
      reducer's savePosition effect; both call the same code path. */
  _syncTimer() {
    if (this.state.type === "playing") this._startTimer();
    else this._stopTimer();
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this.state.type === "playing") this._persistPosition();
    }, POSITION_INTERVAL_MS);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  _stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  _persistPosition() {
    if (!this.positionStore) return;
    const item = this._currentItem();
    if (!item) return;
    // A segment has no resume point worth keeping. It is ~110 s long, its id is
    // synthetic (`foray#3`) so the position would never be read back for the
    // episode, and `_loadItem` ignores saved positions for bounded items
    // anyway. Writing one is pure localStorage litter plus a cp_events row.
    if (boundsOf(item)) return;
    const seconds = this.backend.currentTime;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return;
    this.positionStore.save(item.id, seconds, { duration: this.backend.duration ?? null });
  }

  _emit(message) {
    if (this._telemetry) this._telemetry(message);
  }
}

/** Is this queue item a bounded slice, and if so which one? The single
    definition lives in the reducer (`itemBounds`) so the capability check, the
    in-point, the out-point and position persistence cannot drift apart on a
    malformed item. */
function boundsOf(item) {
  return itemBounds({ startSec: item?.start_sec, endSec: item?.end_sec });
}

/** Queue items are plain catalogue-shaped objects; the reducer only needs
    identity, kind, and (for a segment) the slice it occupies. */
function refOf(item) {
  return itemRef(item.id, item.kind ?? "episode", boundsOf(item));
}

/** Test-only: forget the live instance without disposing a real one. */
export function __resetInstanceForTests() { liveInstance = null; }

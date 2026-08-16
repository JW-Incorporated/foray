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
*/

import { reduce, S, E, itemRef, itemBounds, TTS, END_NATURAL, END_OUT_POINT } from "./queue-state.js";
import { SINGLE_ITEM, assertStrategy } from "./queue-strategy.js";
import { seekPrecision, FOREIGN, APPROXIMATE } from "./seek-policy.js";
import { buildForayQueue } from "./foray-queue.js";

const POSITION_INTERVAL_MS = 15_000;

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
   */
  constructor({ backend, positionStore = null, strategy = SINGLE_ITEM, telemetry = null, allowMultiple = false } = {}) {
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

    /** A backend with no out-point watch cannot play a Foray at all — it would
        run each segment to the end of its whole episode. Recorded once here so
        the refusal below can name the cause instead of the symptom. */
    this._outPointCapable = typeof backend.setOutPoint === "function";

    backend.onItemEnded = (reason) => this._handleBackendItemEnded(reason);
    backend.onError = (msg) => this._handle(E.error(String(msg)));
  }

  /* ---------- lifecycle ---------- */

  dispose() {
    this._stopTimer();
    this._disposed = true;
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

  /* ---------- transport ---------- */

  async play(index = 0) {
    const item = this.queue[index];
    if (!item) return this._emit(`play.ignored.noItemAt=${index}`);
    this.currentIndex = index;
    await this._handle(E.play(refOf(item)));
  }

  async resume() {
    const item = this._currentItem();
    if (!item) return this._emit("resume.ignored.noCurrentItem");
    await this._handle(E.play(refOf(item)));
  }

  /** Pause is modelled as an interruption, matching the Swift. This slightly
      overloads `interrupted`'s telemetry meaning but keeps "why are we paused"
      as a single code path — see the note in PlayerQueueState.swift. */
  async pause() {
    await this._handle(E.interruptionBegan());
  }

  async skipToNext() {
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
    // "Restart" must mean zero. Without this the reducer's savePosition fires
    // first, stores the current playhead, and the reload then resumes to the
    // exact spot the user just asked to leave.
    this._forceNextOffset = 0;
    await this._handle(E.skipToPrevious(null));
  }

  async stop() {
    await this._handle(E.stop());
    this._stopTimer();
  }

  /** @param {object} [opts] `{ precise }` — decided by seek-policy.js (#30),
      never by this manager. */
  async seek(seconds, opts = {}) {
    await this._handle(E.seek(seconds, Boolean(opts.precise)));
  }

  /* ---------- interruptions and routes ---------- */

  async interruptionBegan() { await this._handle(E.interruptionBegan()); }
  async interruptionEnded(shouldResume) { await this._handle(E.interruptionEnded(Boolean(shouldResume))); }

  /** Corner case #13. The reducer never auto-resumes; that policy lives here.
      A route reappearing only resumes if we have seen it before as a car route
      — otherwise plugging in headphones would blast audio unasked. */
  async routeChanged({ oldDeviceUnavailable, routeName = null, isCarRoute = false }) {
    if (isCarRoute && routeName) this._knownCarRoutes.add(routeName);
    await this._handle(E.routeChanged(Boolean(oldDeviceUnavailable)));

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
        return this.backend.setRate(1.0);

      case "restoreRate": {
        const item = this._currentItem();
        return this.backend.setRate(item?.rate ?? 1.0);
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
    const item = this._itemFor(ref);
    if (!item) return this._handle(E.error(`loadItem: unknown ref ${ref.id}`));
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
      await this._handle(E.itemLoaded());
    } catch (err) {
      await this._handle(E.error(`loadItem(${ref.id}) failed: ${err?.message ?? err}`));
    }
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
      if (!next) return this._handle(E.itemEnded(null, false));
      return this._handle(E.itemEnded(refOf(next.item), next.item.kind === TTS));
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

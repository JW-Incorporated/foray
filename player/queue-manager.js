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

     async load(item, { startOffset })   resolve when ready to produce audio
     play() / pause()
     seek(seconds, { precise })
     setRate(rate)
     get currentTime()  -> seconds
     get duration()     -> seconds | null
     release()
     onItemEnded = fn   assigned by this manager
     onError = fn       assigned by this manager
*/

import { reduce, S, E, itemRef, TTS } from "./queue-state.js";
import { SINGLE_ITEM, assertStrategy } from "./queue-strategy.js";

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

    backend.onItemEnded = () => this._handleBackendItemEnded();
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
    // Two distinct notions of "where we are", conflated in the Swift:
    //   currentIndex  what is actually LOADED — savePosition writes against it
    //   _targetIndex  where a skip is HEADING, before the load resolves
    // Keeping them apart is what lets a fast double-skip advance two items
    // while still saving the outgoing episode's playhead against the right id.
    this._targetIndex = null;
    const startOffset = forced ?? (item.kind === TTS ? 0 : this._savedPositionFor(item.id));

    // Move the index only now — after savePosition has already run against the
    // outgoing item. currentIndex tracks what is actually loaded, never what we
    // intend to load.
    const idx = this.queue.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      this.currentIndex = idx;
      if (this._targetIndex === idx) this._targetIndex = null; // arrived
    }

    try {
      await this.backend.load(item, { startOffset });
      await this._handle(E.itemLoaded());
    } catch (err) {
      await this._handle(E.error(`loadItem(${ref.id}) failed: ${err?.message ?? err}`));
    }
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
      then feed exactly one itemEnded into the reducer. */
  async _handleBackendItemEnded() {
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
    const seconds = this.backend.currentTime;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return;
    this.positionStore.save(item.id, seconds, { duration: this.backend.duration ?? null });
  }

  _emit(message) {
    if (this._telemetry) this._telemetry(message);
  }
}

/** Queue items are plain catalogue-shaped objects; the reducer only needs
    identity and kind. */
function refOf(item) {
  return itemRef(item.id, item.kind ?? "episode");
}

/** Test-only: forget the live instance without disposing a real one. */
export function __resetInstanceForTests() { liveInstance = null; }

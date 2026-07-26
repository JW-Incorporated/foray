/* Foray player queue — formal state machine.

   Direct JS port of ios/ForayKit/Sources/ForayKit/PlayerQueueState.swift.
   The two files are meant to be diffable by eye: same states, same events,
   same effects, same transition table, same telemetry strings. If you change
   behaviour here, change it there too (or retire the Swift — see #28).

   `reduce(state, event) -> [nextState, effects]` is pure. No DOM, no timers,
   no Capacitor, no I/O. The *caller* (player/queue-manager.js, issue #33) is
   responsible for interpreting effects against a real audio backend. That
   split is what makes every corner case in docs/brief/05_CORNER_CASES.md
   #11-19 testable without a device.

   Design decisions carried over from the Swift (read its header for the full
   reasoning — these are choices, not accidents):

   1. Ownership split: this state machine does NOT own "what's the next item
      in the queue" — that's the manager's job. Events that need a target
      item carry an item ref supplied by the caller, keeping the reducer a
      pure, context-free function of its own inputs.

   2. `interrupted` doubles as both "actively paused by an interruption,
      awaiting a resume signal" AND "paused-but-ready, not auto-resuming"
      (corner case #11). `wasPlaying` distinguishes them.

   3. `transitioning(from, to)` models the whole bridge-TTS phase as one
      state rather than routing back through `loadingItem`, because bridge
      assets are presumed local. `itemLoaded` while transitioning triggers
      playback without changing the state value.

   4. Single-player invariant (corner case #19): `play` arriving while
      already playing a *different* item is exactly the "two players alive"
      bug shape. The reducer forces a `pausePlayback` before the new
      `loadItem` and always emits telemetry, so it's observable in
      production, not just in tests.

   Extension beyond the Swift: seek. See §"seek" below and issue #30 — the
   `precise` flag is passed through, never decided here.
*/

/* ---------- value types ---------- */

/** Item kinds. TTS items always play at 1.0x (corner case #18). */
export const EPISODE = "episode";
export const TTS = "tts";

/** A minimal, opaque reference to a queue item. The reducer needs nothing
    beyond identity and kind; the manager resolves `id` to an actual URL. */
export function itemRef(id, kind = EPISODE) {
  return Object.freeze({ id, kind });
}

/* ---------- states ---------- */

export const S = Object.freeze({
  /** Nothing loaded, nothing playing. Initial state, and the state after stop. */
  idle: () => Object.freeze({ type: "idle" }),

  /** Asset for `target` is being prepared. `previous` is carried for
      telemetry/UX continuity only. `pendingSeek` is applied on itemLoaded,
      before playback starts — see §seek. */
  loadingItem: (target, previous = null, pendingSeek = null) =>
    Object.freeze({ type: "loadingItem", target, previous, pendingSeek }),

  /** `item` is actively playing. */
  playing: (item) => Object.freeze({ type: "playing", item }),

  /** The bridge TTS between `from` and `to` is loading/playing. */
  transitioning: (from, to) => Object.freeze({ type: "transitioning", from, to }),

  /** Paused by interruption or route loss, or paused-but-ready afterwards.
      `wasPlaying` records whether audio was actually audible at the moment of
      interruption — it gates whether a resume signal actually resumes. */
  interrupted: (item, wasPlaying) =>
    Object.freeze({ type: "interrupted", item, wasPlaying }),

  /** Queue exhausted. Distinct from idle so the UI can tell "never pressed
      play" from "played everything" (corner case #29, auto-extend). */
  ended: () => Object.freeze({ type: "ended" }),
});

/* ---------- events ---------- */

export const E = Object.freeze({
  play: (item) => Object.freeze({ type: "play", item }),
  itemLoaded: () => Object.freeze({ type: "itemLoaded" }),

  /** `next` is what the manager decided plays next (null = queue exhausted).
      `bridged` true means a transition TTS should play first. */
  itemEnded: (next, bridged) => Object.freeze({ type: "itemEnded", next, bridged }),

  interruptionBegan: () => Object.freeze({ type: "interruptionBegan" }),
  interruptionEnded: (shouldResume) =>
    Object.freeze({ type: "interruptionEnded", shouldResume }),

  /** `oldDeviceUnavailable` true models the output route disappearing
      (corner case #13: Bluetooth drop = I turned the car off) -> pause
      immediately. The reducer never auto-resumes on reconnect; that policy
      lives in the manager, which issues an explicit `play`. */
  routeChanged: (oldDeviceUnavailable) =>
    Object.freeze({ type: "routeChanged", oldDeviceUnavailable }),

  /** null item means "no explicit target": for skipToNext that's queue
      exhausted; for skipToPrevious it's "restart the current item in place". */
  skipToNext: (item) => Object.freeze({ type: "skipToNext", item }),
  skipToPrevious: (item) => Object.freeze({ type: "skipToPrevious", item }),

  stop: () => Object.freeze({ type: "stop" }),
  error: (message) => Object.freeze({ type: "error", message }),

  /** Seek to an absolute position. `precise` is decided by the caller from
      dai_suspected + whether the file is local (issue #30's seek-policy);
      the reducer only passes it through. */
  seek: (seconds, precise = false) => Object.freeze({ type: "seek", seconds, precise }),
});

/* ---------- effects ---------- */

export const F = Object.freeze({
  loadItem: (item) => Object.freeze({ type: "loadItem", item }),
  startPlayback: () => Object.freeze({ type: "startPlayback" }),
  pausePlayback: () => Object.freeze({ type: "pausePlayback" }),

  /** Persist current item id + position. Fired on interruption, route loss,
      skip, seek, and stop. The periodic 15s timer is NOT modelled here — it
      isn't event-driven; the manager runs it and calls the same code path. */
  savePosition: () => Object.freeze({ type: "savePosition" }),

  playTransitionTTS: () => Object.freeze({ type: "playTransitionTTS" }),
  /** Force rate to 1.0 before a TTS item becomes audible (corner case #18). */
  resetRateForTTS: () => Object.freeze({ type: "resetRateForTTS" }),
  restoreRate: () => Object.freeze({ type: "restoreRate" }),
  emitTelemetry: (message) => Object.freeze({ type: "emitTelemetry", message }),

  seekTo: (seconds, precise) => Object.freeze({ type: "seekTo", seconds, precise }),
  seekRejected: (reason) => Object.freeze({ type: "seekRejected", reason }),
});

/* ---------- helpers ---------- */

/** Readable state label for telemetry. Mirrors the Swift's `\(state)`
    interpolation without reproducing Swift's enum-printing noise. */
function describe(state) {
  switch (state.type) {
    case "loadingItem": return `loadingItem(${state.target.id})`;
    case "playing": return `playing(${state.item.id})`;
    case "transitioning": return `transitioning(${state.from.id} -> ${state.to.id})`;
    case "interrupted": return `interrupted(${state.item.id}, wasPlaying: ${state.wasPlaying})`;
    default: return state.type;
  }
}

function sameRef(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.kind === b.kind;
}

/** The item currently "in focus" for a state, if any. */
function currentItem(state) {
  switch (state.type) {
    case "playing": return state.item;
    case "transitioning": return state.to;
    case "interrupted": return state.item;
    case "loadingItem": return state.target;
    default: return null; // idle, ended
  }
}

/* ---------- reducer ---------- */

/**
 * Pure state transition function.
 *
 * Any (state, event) combination not explicitly handled is treated as a no-op
 * that still surfaces via telemetry, so unexpected event delivery (a stray
 * callback after a fast double-skip, say) can never corrupt state — it is
 * logged and ignored.
 *
 * @returns {[object, object[]]} [nextState, effects]
 */
export function reduce(state, event) {
  switch (event.type) {
    case "play": return handlePlay(state, event.item);
    case "itemLoaded": return handleItemLoaded(state);
    case "itemEnded": return handleItemEnded(state, event.next, event.bridged);
    case "interruptionBegan": return handleInterruptionBegan(state);
    case "interruptionEnded": return handleInterruptionEnded(state, event.shouldResume);
    case "routeChanged": return handleRouteChanged(state, event.oldDeviceUnavailable);
    case "skipToNext": return handleSkip(state, event.item, "next");
    case "skipToPrevious": return handleSkip(state, event.item, "previous");
    case "seek": return handleSeek(state, event.seconds, event.precise);
    case "stop": return handleStop(state);
    case "error":
      return [S.idle(), [F.pausePlayback(), F.emitTelemetry(`player.error: ${event.message}`)]];
    default:
      return [state, [F.emitTelemetry(`event.ignored: unknown event ${event.type}`)]];
  }
}

/* ---------- play ---------- */

function handlePlay(state, target) {
  switch (state.type) {
    case "idle":
    case "ended":
      return [S.loadingItem(target, null), [F.loadItem(target)]];

    case "interrupted":
      // Manual resume from paused-but-ready. Re-prime the load rather than
      // assuming the backend kept the asset warm — cheap if it did (backend
      // no-ops), correct if it didn't.
      return [S.loadingItem(target, state.item), [F.loadItem(target)]];

    case "loadingItem":
      if (sameRef(state.target, target)) return [state, []]; // redundant, no-op
      return [S.loadingItem(target, state.previous), [
        F.loadItem(target),
        F.emitTelemetry("play.replacedInFlightLoad"),
      ]];

    case "playing":
      if (sameRef(state.item, target)) return [state, []]; // idempotent
      // Single-player invariant (corner case #19): never allow a second
      // startPlayback while one item is already audible.
      return [S.loadingItem(target, state.item), [
        F.pausePlayback(),
        F.loadItem(target),
        F.emitTelemetry(`player.doubleEntryGuard: play(${target.id}) while playing ${state.item.id}`),
      ]];

    case "transitioning":
      return [S.loadingItem(target, state.to), [
        F.pausePlayback(),
        F.loadItem(target),
        F.emitTelemetry(`player.doubleEntryGuard: play(${target.id}) while transitioning to ${state.to.id}`),
      ]];

    default:
      return [state, []];
  }
}

/* ---------- itemLoaded ---------- */

function handleItemLoaded(state) {
  switch (state.type) {
    case "loadingItem": {
      const rate = state.target.kind === TTS ? F.resetRateForTTS() : F.restoreRate();
      const effects = [rate];
      // A seek queued while loading lands here: after the rate is set,
      // before anything becomes audible. Never mid-playback.
      if (state.pendingSeek) {
        effects.push(F.seekTo(state.pendingSeek.seconds, state.pendingSeek.precise));
      }
      effects.push(F.startPlayback());
      return [S.playing(state.target), effects];
    }

    case "transitioning":
      // Bridge asset ready; start it audible. State value unchanged — we
      // were already "in the bridge phase" (design note 3).
      return [state, [F.resetRateForTTS(), F.startPlayback()]];

    default:
      // Stray/late callback that no longer applies (e.g. a race after a fast
      // double-skip already moved us on). Never let it clobber the present.
      return [state, [F.emitTelemetry(`itemLoaded.ignored: unexpected in state ${describe(state)}`)]];
  }
}

/* ---------- itemEnded ---------- */

function handleItemEnded(state, next, bridged) {
  switch (state.type) {
    case "playing":
      if (!next) return [S.ended(), [F.emitTelemetry("queue.ended")]];
      if (bridged) {
        return [S.transitioning(state.item, next), [
          F.resetRateForTTS(),
          F.playTransitionTTS(),
        ]];
      }
      return [S.loadingItem(next, state.item), [F.loadItem(next)]];

    case "transitioning": {
      // The bridge TTS finished; move into the real next item. Trust a
      // caller-provided `next` (the manager may have re-resolved it, e.g. a
      // skip arrived during the bridge), else fall back to the queued `to`.
      const target = next ?? state.to;
      return [S.loadingItem(target, state.to), [F.restoreRate(), F.loadItem(target)]];
    }

    default:
      return [state, [F.emitTelemetry(`itemEnded.ignored: unexpected in state ${describe(state)}`)]];
  }
}

/* ---------- interruption ---------- */

function handleInterruptionBegan(state) {
  switch (state.type) {
    case "playing":
      return [S.interrupted(state.item, true), [
        F.savePosition(),
        F.pausePlayback(),
        F.emitTelemetry("interruption.began"),
      ]];

    case "transitioning":
      // The audible thing was an ephemeral bridge TTS, not a real queue
      // item. We deliberately don't resume mid-bridge (corner case #12's
      // spirit: never replay episode audio); on resume we land on `to`.
      return [S.interrupted(state.to, true), [
        F.savePosition(),
        F.pausePlayback(),
        F.emitTelemetry("interruption.began.duringTransition"),
      ]];

    case "loadingItem":
      // Nothing audible yet; nothing to pause or save. Recording the
      // interruption still matters so a stray itemLoaded doesn't start
      // playback into a call.
      return [S.interrupted(state.target, false), [
        F.emitTelemetry("interruption.began.duringLoad"),
      ]];

    default:
      // Idempotent guard against duplicate interruption notifications.
      return [state, []];
  }
}

function handleInterruptionEnded(state, shouldResume) {
  if (state.type !== "interrupted") {
    return [state, [F.emitTelemetry(`interruptionEnded.ignored: unexpected in state ${describe(state)}`)]];
  }

  if (shouldResume && state.wasPlaying) {
    // Route the resume through loadingItem rather than jumping straight to
    // playing: if the interruption began during a TTS bridge, `item` is the
    // *upcoming* episode while the player still holds the half-played
    // bridge — a blind startPlayback would resume the wrong audio at the
    // wrong rate. The manager no-ops the load when the backend already holds
    // `item`, and loadingItem -> itemLoaded re-applies the correct rate.
    return [S.loadingItem(state.item, state.item), [
      F.loadItem(state.item),
      F.emitTelemetry("interruption.ended.resumed"),
    ]];
  }

  // Either the system says don't auto-resume, or nothing was audible when we
  // were interrupted. Stay paused but ready (corner case #11): the lock
  // screen must still show a correct, resumable state.
  return [S.interrupted(state.item, false), [
    F.emitTelemetry("interruption.ended.staysPaused"),
  ]];
}

/* ---------- route change ---------- */

function handleRouteChanged(state, oldDeviceUnavailable) {
  if (!oldDeviceUnavailable) {
    // A route became available (e.g. BT reconnect). The reducer does not
    // auto-resume — "resume only for previously-known car routes" is a
    // policy that lives in the manager, which issues an explicit play.
    return [state, [F.emitTelemetry("route.changed.available")]];
  }

  switch (state.type) {
    case "playing":
      return [S.interrupted(state.item, true), [
        F.savePosition(),
        F.pausePlayback(),
        F.emitTelemetry("route.oldDeviceUnavailable.paused"),
      ]];

    case "transitioning":
      return [S.interrupted(state.to, true), [
        F.savePosition(),
        F.pausePlayback(),
        F.emitTelemetry("route.oldDeviceUnavailable.pausedDuringTransition"),
      ]];

    case "loadingItem":
      // Halt the in-flight load from starting playback into a dead route:
      // once interrupted, a subsequent itemLoaded is ignored.
      return [S.interrupted(state.target, false), [
        F.emitTelemetry("route.oldDeviceUnavailable.duringLoad"),
      ]];

    default:
      return [state, []];
  }
}

/* ---------- skip ---------- */

function handleSkip(state, target, direction) {
  if (!target) {
    // "Restart in place" only makes sense for skipToPrevious(null); for
    // skipToNext(null) there is genuinely nothing left.
    const restart = direction === "previous" ? currentItem(state) : null;
    if (restart) {
      return [S.loadingItem(restart, restart), [
        F.savePosition(),
        F.pausePlayback(),
        F.loadItem(restart),
        F.emitTelemetry("skip.previous.restartInPlace"),
      ]];
    }
    return [S.ended(), [F.emitTelemetry(`skip.${direction}.queueExhausted`)]];
  }

  switch (state.type) {
    case "loadingItem":
      // Fast double-skip serialisation (corner case #19-adjacent): a second
      // skip arriving before the first finished loading replaces the
      // in-flight target rather than stacking a second concurrent load.
      // Exactly one loadItem effect results.
      if (sameRef(state.target, target)) return [state, []];
      return [S.loadingItem(target, state.previous), [
        F.loadItem(target),
        F.emitTelemetry(`skip.${direction}.debounced.replacedInFlightLoad`),
      ]];

    case "playing":
    case "transitioning":
    case "interrupted":
      return [S.loadingItem(target, currentItem(state)), [
        F.savePosition(),
        F.pausePlayback(),
        F.loadItem(target),
        F.emitTelemetry(`skip.${direction}`),
      ]];

    default:
      // Nothing playing to skip from; treat like a fresh play.
      return [S.loadingItem(target, null), [F.loadItem(target)]];
  }
}

/* ---------- seek ----------

   Not in the Swift original. Added per issue #20 §5 so the reducer never has
   to be reopened for it later.

   The reducer does NOT decide whether precision is available — that depends
   on dai_suspected (issue #22) and whether the file is local (issue #29), and
   lives in the caller's seek-policy (issue #30). We pass `precise` through so
   the backend can pick its strategy.
*/

function handleSeek(state, seconds, precise) {
  switch (state.type) {
    case "playing":
    case "interrupted":
      // Save first: the old position is about to be lost, and corner case
      // #17 says position loss must be <= 15s.
      return [state, [F.savePosition(), F.seekTo(seconds, precise)]];

    case "loadingItem":
      // Queue it. Applied on itemLoaded, before playback starts — this is
      // the resume-mid-episode path and it must not race the load.
      // A later seek replaces an earlier pending one (last wins), matching
      // the fast-double-skip philosophy.
      return [S.loadingItem(state.target, state.previous, { seconds, precise }), []];

    default:
      // idle / ended: nothing to seek in. transitioning: seeking inside an
      // ephemeral bridge TTS is meaningless.
      return [state, [F.seekRejected(`cannot seek in state ${describe(state)}`)]];
  }
}

/* ---------- stop ---------- */

function handleStop(state) {
  switch (state.type) {
    case "idle":
    case "ended":
      return [S.idle(), []];

    case "playing":
    case "transitioning":
      return [S.idle(), [F.savePosition(), F.pausePlayback(), F.emitTelemetry("player.stopped")]];

    default: // loadingItem, interrupted — nothing audible to pause
      return [S.idle(), [F.emitTelemetry("player.stopped")]];
  }
}

// COPIED (card NE-02, docs/native-engine-plan.md §4.1) from
//   ios/ForayKit/Sources/ForayKit/PlayerQueueState.swift @ adde5e12
// and then extended (NE-07s, below). The ios/ copy is FROZEN REFERENCE: nothing
// ships from ios/ (it is the dead SwiftUI scaffold), and this file is the one
// the native engine builds on. Edit this copy, never that one.
//
// WHY A COPY AND NOT A MOVE. ios/App/ForayApp.swift and
// ios/App/Player/PlayerQueueManager.swift reach these types through ForayKit,
// and ForayKit's own host `swift test` (ci.yml's ios-kit) runs against the
// original, so moving the file breaks both and would put a human merge (G-2)
// on the engine's critical path. Nor can the plugin simply depend on
// ForayKit: it declares .iOS(.v17), above the iOS 15 floor this package
// builds for. Freezing or deleting the scaffold is optional card NE-44.
//
// WHAT NE-07s CHANGED. This copy is now at parity with player/queue-state.js,
// which is the REFERENCE: bounds on QueueItemRef and identity that includes
// them (sameRef), `.seek` with `pendingSeek` on `.loadingItem`, the out-point
// (`.setOutPoint` on itemLoaded), `.elementResumed`, the queue-exhausted skip
// that pauses what is audible, and telemetry strings that are BYTE-IDENTICAL
// to the JS ones (`describe`, below). The contract is the queue-state fixture
// family (player/parity/fixtures/queue-state), run by ForayEngineParity's
// QueueStateFamily; a rule change lands in JS first, is re-recorded, and only
// then is ported here. Drifting from the ios/ original is intended.
//
// The 34 copied tests are Tests/ForayEngineCoreTests/PlayerQueueStateTests.swift;
// tools/mobile/shell-invariants.test.mjs pins that every one of the original's
// test methods survives there. One of them changed its expectation with the
// JS (testSkipToNextWithNoTargetEndsQueue, #111): see its comment.

import Foundation

// MARK: - PlayerQueueState
//
// Formal state machine for Foray's player queue, per
// docs/brief/04_VOICE_AUDIO_SPEC.md ("Custom PlayerQueueManager over
// AVPlayer... Formal state machine: idle -> loadingItem -> playing ->
// transitioning -> interrupted -> ended, with unit tests for every edge").
//
// This file has ZERO dependency on AVFoundation. `reduce(state:event:)` is a
// pure function: (state, event) -> (newState, [effects]). The *caller*
// (PlayerQueueManager, in the App target) is responsible for interpreting
// PlayerEffect values against a real AVPlayer/AVAudioSession. That split is
// what makes every corner case in docs/brief/05_CORNER_CASES.md #11-19
// testable without a simulator.
//
// Design decisions worth calling out (not AVFoundation-uncertainty, just
// choices made while turning prose rules into a state machine):
//
// 1. Ownership split: this state machine does NOT own "what's the next item
//    in the queue" — that's the manager's job (it holds the flat item list
//    built from the Session document). Events that need a target item
//    (`play`, `skipToNext`, `skipToPrevious`, the `next` payload of
//    `itemEnded`) carry a `QueueItemRef` supplied by the caller. This keeps
//    the reducer a pure, context-free function of its own inputs.
//
// 2. `.interrupted` doubles as both "actively paused by an interruption/
//    route-loss, awaiting an ended/resume signal" AND "paused-but-ready,
//    not auto-resuming" (05_CORNER_CASES.md #11: "ended without
//    shouldResume -> stay paused but ready; lock screen shows correct
//    state"). Both are representable with `wasPlaying` distinguishing
//    "should auto-resume when told to" from "just sitting there paused."
//
// 3. `.transitioning(from:to:)` models the whole bridge-TTS phase (load +
//    play of the transition_tts item) as one state, rather than routing it
//    back through `.loadingItem`, because bridge assets are presumed
//    predownloaded/local (05_VOICE_AUDIO_SPEC "Everything local before
//    play"), so there's no meaningfully-long "loading" sub-phase worth a
//    separate state value. `itemLoaded` received while `.transitioning`
//    just triggers the playback-start effects; the state itself doesn't
//    change value (it was already "the bridge phase").
//
// 4. Single-player invariant (05_CORNER_CASES.md #19): `.play(item:)`
//    arriving while already `.playing`/`.transitioning` a *different* item
//    is exactly the "two AVPlayers alive" bug shape. The reducer never lets
//    that produce two concurrent "start playback" effects: it forces a
//    `.pausePlayback` before the new `.loadItem`, and always emits
//    `.emitTelemetry` so this is observable in production, not just in
//    tests.

// MARK: - Supporting value types

/// What kind of asset a queue item is. TTS items (intros/transitions) always
/// play at 1.0x regardless of the per-show rate (05_CORNER_CASES.md #18);
/// episode items play at the show's configured rate.
public enum PlayerItemKind: Equatable, Hashable, Sendable {
    case episode
    case tts
}

/// A minimal, opaque reference to a queue item. The state machine doesn't
/// need to know anything about an item beyond its identity, its kind and (for
/// a Foray segment) its bounds; the manager resolves `id` to an actual local
/// file URL / AVPlayerItem.
///
/// `bounds` is queue-state.js's `itemRef(id, kind, bounds)`: the slice of the
/// SOURCE audio the item occupies, nil for an ordinary unbounded item. It is an
/// `ItemBounds`, whose only public constructor is `ItemBounds.make` (the port
/// of `itemBounds`, the ONE definition of "bounded"), so a ref cannot carry a
/// backwards, empty or non-finite slice: JS normalises in `itemRef`, and here
/// the type does it. The caller supplies bounds, as it supplies the item
/// (design note 1).
public struct QueueItemRef: Equatable, Hashable, Sendable {
    public let id: String
    public let kind: PlayerItemKind
    public let bounds: ItemBounds?

    public init(id: String, kind: PlayerItemKind, bounds: ItemBounds? = nil) {
        self.id = id
        self.kind = kind
        self.bounds = bounds
    }

    /// queue-state.js `sameRef`: identity INCLUDES the bounds, and that is
    /// load-bearing rather than tidy. Two segments of the same episode are two
    /// queue items over one source, and every "is this the thing I am already
    /// doing?" guard in the reducer (play's idempotence, the skip debounce,
    /// the in-flight-load replacement) would otherwise drop the second as a
    /// repeat of the first. Consecutive same-episode segments are the normal
    /// case in a Foray. Spelled out field by field rather than as `==` so the
    /// guards read like the JS they port, and so a field added later that is
    /// NOT identity cannot slip into them unnoticed.
    public static func sameRef(_ a: QueueItemRef?, _ b: QueueItemRef?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return a.id == b.id && a.kind == b.kind && a.bounds == b.bounds
    }
}

/// A seek that arrived while its item was still loading: applied on
/// `itemLoaded`, after the rate is set and before anything is audible
/// (queue-state.js §seek). `precise` is the caller's decision (seek-policy);
/// the reducer only carries it.
public struct PendingSeek: Equatable, Hashable, Sendable {
    public let seconds: Double
    public let precise: Bool

    public init(seconds: Double, precise: Bool) {
        self.seconds = seconds
        self.precise = precise
    }
}

// MARK: - State

public enum PlayerQueueState: Equatable, Sendable {
    /// Nothing loaded, nothing playing. Initial state, and the state after
    /// an explicit `.stop`.
    case idle

    /// Asset for `target` is being prepared. `previous` is carried through
    /// only for telemetry/UX continuity (e.g. "was this a skip or the very
    /// first item of the session?"); the reducer does not require it.
    /// `pendingSeek` is a seek queued while loading, applied on `itemLoaded`
    /// (NE-07s). It defaults to nil so the original two-field spelling still
    /// builds, which is what keeps the 34 copied tests' constructions as-is.
    case loadingItem(target: QueueItemRef, previous: QueueItemRef?, pendingSeek: PendingSeek? = nil)

    /// `item` is actively playing.
    case playing(item: QueueItemRef)

    /// The bridge TTS between `from` (the item that just ended) and `to`
    /// (the upcoming item) is loading/playing. See design note 3 above.
    case transitioning(from: QueueItemRef, to: QueueItemRef)

    /// Paused because of an interruption (phone call) or a route loss (BT
    /// disconnect), or paused-but-ready after an interruption ended without
    /// `shouldResume`. `wasPlaying` records whether audio was actually
    /// audible at the moment of interruption (vs. e.g. interrupted mid-load,
    /// nothing audible yet) — it gates whether `interruptionEnded(shouldResume:
    /// true)` should actually resume playback.
    case interrupted(item: QueueItemRef, wasPlaying: Bool)

    /// Queue exhausted; nothing left to play. Distinct from `.idle` so the
    /// UI/manager can tell "user never pressed play" from "we played
    /// everything" (relevant to auto-extend, 05_CORNER_CASES.md #29).
    case ended
}

// MARK: - Events

public enum PlayerEvent: Equatable, Sendable {
    /// Play a specific item (initial play from the Today picker, or a
    /// manual resume after `.interrupted`/`.ended`).
    case play(QueueItemRef)

    /// The item targeted by the current `.loadingItem` (or the bridge asset
    /// of the current `.transitioning`) finished preparing and is ready to
    /// produce audio.
    case itemLoaded

    /// The currently-playing item finished on its own. `next` is the item
    /// the manager has decided should play next (nil if the queue is
    /// exhausted). `bridged` is true when a transition_tts item should play
    /// first ("episode ends -> play transition_tts -> next episode",
    /// 04_VOICE_AUDIO_SPEC.md); false for a hard cut straight into `next`.
    case itemEnded(next: QueueItemRef?, bridged: Bool)

    case interruptionBegan
    case interruptionEnded(shouldResume: Bool)

    /// `oldDeviceUnavailable == true` models AVAudioSession route-change
    /// reason `.oldDeviceUnavailable` (05_CORNER_CASES.md #13: "Bluetooth
    /// drop = I turned the car off" -> pause immediately). `false` models
    /// any other route change (e.g. a new route becoming available); the
    /// reducer does not itself decide to auto-resume on reconnect — that
    /// "was this a known car route" policy lives in the manager, which
    /// issues an explicit `.play` if it decides to resume.
    case routeChanged(oldDeviceUnavailable: Bool)

    /// `item` nil means "no explicit target" — for `skipToNext` that means
    /// "queue is exhausted" (-> `.ended`); for `skipToPrevious` that means
    /// "no previous item, restart the current one in place."
    case skipToNext(QueueItemRef?)
    case skipToPrevious(QueueItemRef?)

    case stop
    case error(String)

    /// Seek to an absolute position in the current source (queue-state.js
    /// `E.seek`). `precise` is decided by the caller from `dai_suspected` and
    /// whether the file is local (seek-policy); the reducer passes it through.
    case seek(seconds: Double, precise: Bool)

    /// The player is producing audio for the item held as `.interrupted`:
    /// something outside the reducer resumed it (a lock-screen or car press
    /// the platform honoured itself). An OBSERVATION, never a request (Q-9,
    /// "observe, don't believe"): see `handleElementResumed`.
    case elementResumed
}

// MARK: - Effects

/// Side effects the reducer wants performed. `PlayerQueueManager` maps each
/// case onto real AVPlayer/AVAudioSession/MPNowPlayingInfoCenter calls.
public enum PlayerEffect: Equatable, Sendable {
    case loadItem(QueueItemRef)
    case startPlayback
    case pausePlayback
    /// Persist the current item id + position locally. Fired on
    /// interruption-began, route loss, skip, and stop — per
    /// 04_VOICE_AUDIO_SPEC.md "Position persistence": every 15s AND on
    /// every pause/interruption/route-change/skip. The periodic 15s timer
    /// itself is not modeled here (it's not event-driven); the manager
    /// runs that independently and also calls the same persistence code
    /// path directly.
    case savePosition
    /// Play the (pre-downloaded, local) transition TTS bridging the item
    /// that just ended into the next one.
    case playTransitionTTS
    /// Force playback rate to 1.0 before a TTS item becomes audible
    /// (05_CORNER_CASES.md #18).
    case resetRateForTTS
    /// Restore the per-show playback rate after leaving a TTS item.
    case restoreRate
    case emitTelemetry(String)
    /// Seek the current source to `seconds`, with the caller's precision.
    case seekTo(seconds: Double, precise: Bool)
    /// A seek that cannot apply in the current state; the text is telemetry.
    case seekRejected(String)
    /// Arm the backend's out-point watch at `seconds` on the current source's
    /// timeline. Emitted only for a bounded item and only on `itemLoaded`:
    /// after the in-point has landed, before anything is audible. There is no
    /// `clear` counterpart: a load drops any armed boundary, so a stale
    /// out-point cannot outlive its item, and an unbounded item's
    /// `itemLoaded` stays effect-for-effect what it was before out-points.
    case setOutPoint(Double)
}

// MARK: - Reducer entry point

extension PlayerQueueState {
    /// Convenience static entry point matching the spec's
    /// `reduce(state:event:) -> (PlayerQueueState, [PlayerEffect])` shape
    /// exactly. Implementation lives in `PlayerQueueStateMachine` to keep
    /// this file's primary type declarations (the enum itself) uncluttered
    /// by the transition table.
    public static func reduce(
        state: PlayerQueueState,
        event: PlayerEvent
    ) -> (PlayerQueueState, [PlayerEffect]) {
        PlayerQueueStateMachine.reduce(state: state, event: event)
    }
}

// MARK: - Reducer

public enum PlayerQueueStateMachine {

    /// Pure state transition function. No I/O, no AVFoundation, safe to
    /// call from any thread/actor context, and exhaustively unit tested in
    /// PlayerQueueStateTests.swift.
    ///
    /// Any (state, event) combination not explicitly handled below is
    /// treated as a no-op that still surfaces via telemetry, so unexpected
    /// event delivery (e.g. a stray notification from AVFoundation while we
    /// are already `.idle`) can never crash the app or corrupt state — it
    /// is simply logged and ignored.
    public static func reduce(
        state: PlayerQueueState,
        event: PlayerEvent
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch event {
        case .play(let target):
            return handlePlay(state: state, target: target)

        case .itemLoaded:
            return handleItemLoaded(state: state)

        case .itemEnded(let next, let bridged):
            return handleItemEnded(state: state, next: next, bridged: bridged)

        case .interruptionBegan:
            return handleInterruptionBegan(state: state)

        case .interruptionEnded(let shouldResume):
            return handleInterruptionEnded(state: state, shouldResume: shouldResume)

        case .routeChanged(let oldDeviceUnavailable):
            return handleRouteChanged(state: state, oldDeviceUnavailable: oldDeviceUnavailable)

        case .skipToNext(let item):
            return handleSkip(state: state, target: item, direction: "next")

        case .skipToPrevious(let item):
            return handleSkip(state: state, target: item, direction: "previous")

        case .stop:
            return handleStop(state: state)

        case .error(let message):
            return (.idle, [.pausePlayback, .emitTelemetry("player.error: \(message)")])

        case .seek(let seconds, let precise):
            return handleSeek(state: state, seconds: seconds, precise: precise)

        case .elementResumed:
            return handleElementResumed(state: state)
        }
    }

    // MARK: play

    private static func handlePlay(
        state: PlayerQueueState,
        target: QueueItemRef
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch state {
        case .idle, .ended:
            return (.loadingItem(target: target, previous: nil), [.loadItem(target)])

        case .interrupted(let item, _):
            // Manual resume from a paused-but-ready (or still-interrupted)
            // state. Re-prime the load rather than assuming the backend
            // kept the asset warm — cheap if it did (backend can no-op),
            // correct if it didn't.
            return (.loadingItem(target: target, previous: item), [.loadItem(target)])

        case .loadingItem(let currentTarget, let previous, _):
            if QueueItemRef.sameRef(currentTarget, target) {
                // Redundant play() for the thing already loading; no-op.
                return (state, [])
            }
            return (.loadingItem(target: target, previous: previous), [
                .loadItem(target),
                .emitTelemetry("play.replacedInFlightLoad")
            ])

        case .playing(let currentItem):
            if QueueItemRef.sameRef(currentItem, target) {
                // Already playing this exact item; idempotent no-op.
                return (state, [])
            }
            // Single-player invariant (05_CORNER_CASES.md #19): never allow
            // a second `startPlayback` while one item is already audible.
            // Force a pause before loading the new target.
            return (.loadingItem(target: target, previous: currentItem), [
                .pausePlayback,
                .loadItem(target),
                .emitTelemetry("player.doubleEntryGuard: play(\(target.id)) while playing \(currentItem.id)")
            ])

        case .transitioning(_, let to):
            return (.loadingItem(target: target, previous: to), [
                .pausePlayback,
                .loadItem(target),
                .emitTelemetry("player.doubleEntryGuard: play(\(target.id)) while transitioning to \(to.id)")
            ])
        }
    }

    // MARK: itemLoaded

    private static func handleItemLoaded(
        state: PlayerQueueState
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch state {
        case .loadingItem(let target, _, let pendingSeek):
            var effects: [PlayerEffect] = [target.kind == .tts ? .resetRateForTTS : .restoreRate]
            // A seek queued while loading lands here: after the rate is set,
            // before anything becomes audible. Never mid-playback.
            if let pendingSeek {
                effects.append(.seekTo(seconds: pendingSeek.seconds, precise: pendingSeek.precise))
            }
            // Arm the out-point here and nowhere else: the in-point is already
            // applied (it rode on the load, or on the pendingSeek above), so
            // the backend decides from a settled playhead whether the boundary
            // is still ahead. Arming before the seek would arm against 0:00.
            if let bounds = target.bounds {
                effects.append(.setOutPoint(bounds.endSec))
            }
            effects.append(.startPlayback)
            return (.playing(item: target), effects)

        case .transitioning:
            // Bridge asset finished loading; start it audible. State value
            // is unchanged (still "in the bridge phase") — see design note 3.
            return (state, [.resetRateForTTS, .startPlayback])

        case .idle, .playing, .interrupted, .ended:
            // Stray/late `itemLoaded` callback that no longer applies
            // (e.g. a race after a fast double-skip already moved us on).
            // Never let it clobber whatever is actually happening now.
            return (state, [.emitTelemetry("itemLoaded.ignored: unexpected in state \(describe(state))")])
        }
    }

    // MARK: itemEnded

    private static func handleItemEnded(
        state: PlayerQueueState,
        next: QueueItemRef?,
        bridged: Bool
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch state {
        case .playing(let current):
            guard let next else {
                return (.ended, [.emitTelemetry("queue.ended")])
            }
            if bridged {
                return (.transitioning(from: current, to: next), [
                    .resetRateForTTS,
                    .playTransitionTTS
                ])
            }
            return (.loadingItem(target: next, previous: current), [.loadItem(next)])

        case .transitioning(_, let to):
            // The bridge TTS itself finished; move into the real next item.
            // Trust the caller-provided `next` if given (the manager may
            // have re-resolved it, e.g. because of a skip that arrived
            // during the bridge), otherwise fall back to the previously
            // queued `to`.
            let target = next ?? to
            return (.loadingItem(target: target, previous: to), [.restoreRate, .loadItem(target)])

        case .idle, .loadingItem, .interrupted, .ended:
            return (state, [.emitTelemetry("itemEnded.ignored: unexpected in state \(describe(state))")])
        }
    }

    // MARK: interruption began

    private static func handleInterruptionBegan(
        state: PlayerQueueState
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch state {
        case .playing(let item):
            return (.interrupted(item: item, wasPlaying: true), [
                .savePosition,
                .pausePlayback,
                .emitTelemetry("interruption.began")
            ])

        case .transitioning(_, let to):
            // The audible thing was an ephemeral bridge TTS, not a real
            // queue item. We deliberately do not try to resume mid-bridge
            // (05_CORNER_CASES.md #12: "never replay episode audio" — by
            // the same spirit, don't resume a half-played transition
            // either); on resume we land back on `to`, the upcoming item.
            return (.interrupted(item: to, wasPlaying: true), [
                .savePosition,
                .pausePlayback,
                .emitTelemetry("interruption.began.duringTransition")
            ])

        case .loadingItem(let target, _, _):
            // Nothing audible yet; nothing to pause or save. Recording the
            // interruption still matters so a subsequent stray
            // `itemLoaded` doesn't start playback into a call.
            return (.interrupted(item: target, wasPlaying: false), [
                .emitTelemetry("interruption.began.duringLoad")
            ])

        case .idle, .ended, .interrupted:
            // Idempotent guard against duplicate interruption notifications.
            return (state, [])
        }
    }

    // MARK: interruption ended

    private static func handleInterruptionEnded(
        state: PlayerQueueState,
        shouldResume: Bool
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch state {
        case .interrupted(let item, let wasPlaying):
            if shouldResume && wasPlaying {
                // Route the resume through .loadingItem rather than jumping
                // straight to .playing: if the interruption began during a
                // TTS bridge, `item` is the *upcoming* episode and the
                // player's current asset is the half-played bridge — a blind
                // startPlayback would resume the wrong audio at the wrong
                // rate. The manager no-ops the load when the player already
                // holds `item` (same contract as manual resume via .play),
                // and the .loadingItem -> itemLoaded path re-applies the
                // correct per-kind rate.
                return (.loadingItem(target: item, previous: item), [
                    .loadItem(item),
                    .emitTelemetry("interruption.ended.resumed")
                ])
            }
            // Either the system says don't auto-resume, or nothing was
            // actually audible when we got interrupted. Stay paused but
            // ready (05_CORNER_CASES.md #11): lock screen must still show
            // the correct, resumable state.
            return (.interrupted(item: item, wasPlaying: false), [
                .emitTelemetry("interruption.ended.staysPaused")
            ])

        case .idle, .loadingItem, .playing, .transitioning, .ended:
            return (state, [.emitTelemetry("interruptionEnded.ignored: unexpected in state \(describe(state))")])
        }
    }

    // MARK: route changed

    private static func handleRouteChanged(
        state: PlayerQueueState,
        oldDeviceUnavailable: Bool
    ) -> (PlayerQueueState, [PlayerEffect]) {
        guard oldDeviceUnavailable else {
            // A route became available (e.g. BT reconnect). The state
            // machine does not auto-resume itself — "auto-resume on car
            // reconnect" is a policy decision (only for previously-known
            // car routes) that lives in PlayerQueueManager, which will
            // issue an explicit `.play` event if it decides to resume.
            return (state, [.emitTelemetry("route.changed.available")])
        }

        // Old device unavailable == the output route just disappeared
        // (05_CORNER_CASES.md #13: "Bluetooth drop = I turned the car
        // off") -> pause immediately, unconditionally.
        switch state {
        case .playing(let item):
            return (.interrupted(item: item, wasPlaying: true), [
                .savePosition,
                .pausePlayback,
                .emitTelemetry("route.oldDeviceUnavailable.paused")
            ])

        case .transitioning(_, let to):
            return (.interrupted(item: to, wasPlaying: true), [
                .savePosition,
                .pausePlayback,
                .emitTelemetry("route.oldDeviceUnavailable.pausedDuringTransition")
            ])

        case .loadingItem(let target, _, _):
            // Halt the in-flight load from starting playback into a dead
            // route: once state is `.interrupted`, a subsequent
            // `itemLoaded` is ignored (see handleItemLoaded).
            return (.interrupted(item: target, wasPlaying: false), [
                .emitTelemetry("route.oldDeviceUnavailable.duringLoad")
            ])

        case .idle, .ended, .interrupted:
            return (state, [])
        }
    }

    // MARK: skip

    private static func handleSkip(
        state: PlayerQueueState,
        target: QueueItemRef?,
        direction: String
    ) -> (PlayerQueueState, [PlayerEffect]) {
        // "Restart in place" only makes sense for skipToPrevious(nil); for
        // skipToNext(nil) there is genuinely nothing left.
        func currentItem() -> QueueItemRef? {
            switch state {
            case .playing(let item): return item
            case .transitioning(_, let to): return to
            case .interrupted(let item, _): return item
            case .loadingItem(let target, _, _): return target
            case .idle, .ended: return nil
            }
        }

        guard let target else {
            if direction == "previous", let restart = currentItem() {
                return (.loadingItem(target: restart, previous: restart), [
                    .savePosition,
                    .pausePlayback,
                    .loadItem(restart),
                    .emitTelemetry("skip.previous.restartInPlace")
                ])
            }
            // Queue genuinely exhausted. STOP WHAT IS AUDIBLE: the scaffold
            // returned `.ended` with telemetry alone, which left the player
            // running while the state said the session was over. JS fixed it
            // in #111 (a short last Foray segment is exactly where someone
            // presses skip); this is that fix, ported.
            let done = PlayerEffect.emitTelemetry("skip.\(direction).queueExhausted")
            switch state {
            case .playing, .transitioning:
                return (.ended, [.savePosition, .pausePlayback, done])
            case .idle, .loadingItem, .interrupted, .ended:
                return (.ended, [done])
            }
        }

        switch state {
        case .loadingItem(let inFlightTarget, let previous, _):
            // Fast double-skip serialization (05_CORNER_CASES.md #19-adjacent):
            // a second skip arriving before the first finished loading
            // replaces the in-flight target rather than stacking a second
            // concurrent load. Exactly one `loadItem` effect results. The
            // replacement drops any pendingSeek: it belonged to the old target.
            if QueueItemRef.sameRef(inFlightTarget, target) {
                return (state, [])
            }
            return (.loadingItem(target: target, previous: previous), [
                .loadItem(target),
                .emitTelemetry("skip.\(direction).debounced.replacedInFlightLoad")
            ])

        case .playing, .transitioning, .interrupted:
            return (.loadingItem(target: target, previous: currentItem()), [
                .savePosition,
                .pausePlayback,
                .loadItem(target),
                .emitTelemetry("skip.\(direction)")
            ])

        case .idle, .ended:
            // Nothing playing to skip from; treat like a fresh play.
            return (.loadingItem(target: target, previous: nil), [.loadItem(target)])
        }
    }

    // MARK: seek
    //
    // Not in the scaffold (queue-state.js §seek). The reducer does NOT decide
    // whether precision is available; that depends on dai_suspected and on
    // whether the file is local, and lives in the caller's seek-policy.

    private static func handleSeek(
        state: PlayerQueueState,
        seconds: Double,
        precise: Bool
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch state {
        case .playing, .interrupted:
            // Save first: the old position is about to be lost, and
            // 05_CORNER_CASES.md #17 says position loss must be <= 15s.
            return (state, [.savePosition, .seekTo(seconds: seconds, precise: precise)])

        case .loadingItem(let target, let previous, _):
            // Queue it, applied on itemLoaded before playback starts: the
            // resume-mid-episode path, which must not race the load. A later
            // seek replaces an earlier pending one (last wins), the same
            // philosophy as the fast double-skip.
            return (.loadingItem(target: target, previous: previous,
                                 pendingSeek: PendingSeek(seconds: seconds, precise: precise)), [])

        case .idle, .ended, .transitioning:
            // idle / ended: nothing to seek in. transitioning: seeking inside
            // an ephemeral bridge TTS is meaningless.
            return (state, [.seekRejected("cannot seek in state \(describe(state))")])
        }
    }

    // MARK: elementResumed
    //
    // Not in the scaffold (queue-state.js, 2026-09-22, founder report 1).
    // `.interrupted` is the only state this moves from, and to `.playing` with
    // NO audio effect: the sound is already coming out, so `startPlayback`
    // would be a second start and `loadItem` would re-point a player that is
    // playing. What the transition buys is everything downstream that keys off
    // `.playing` (the position writer, the transport label, the reconcile that
    // catches the NEXT external stop). Every other state either already says
    // audio is flowing or must not be overruled by a player event: a seam beat
    // is `.loadingItem` with the player paused on purpose.

    private static func handleElementResumed(
        state: PlayerQueueState
    ) -> (PlayerQueueState, [PlayerEffect]) {
        guard case .interrupted(let item, _) = state else { return (state, []) }
        return (.playing(item: item), [.emitTelemetry("reconcile.elementResumed")])
    }

    // MARK: stop

    private static func handleStop(
        state: PlayerQueueState
    ) -> (PlayerQueueState, [PlayerEffect]) {
        switch state {
        case .idle, .ended:
            return (.idle, [])

        case .playing, .transitioning:
            return (.idle, [.savePosition, .pausePlayback, .emitTelemetry("player.stopped")])

        case .loadingItem, .interrupted:
            return (.idle, [.emitTelemetry("player.stopped")])
        }
    }

    // MARK: telemetry labels

    /// queue-state.js `describe(state)`: the state as telemetry spells it.
    ///
    /// WHY NOT `\(state)`, as the scaffold had it. Swift's enum printing
    /// (`loadingItem(target: ForayEngineCore.QueueItemRef(id: ...`) is noise
    /// no JS string matches, and the telemetry the engine writes must read the
    /// same as the page's, byte for byte (card NE-07s). The queue-state
    /// fixtures pin every spelling here.
    public static func describe(_ state: PlayerQueueState) -> String {
        switch state {
        case .idle: return "idle"
        case .ended: return "ended"
        case .loadingItem(let target, _, _): return "loadingItem(\(name(target)))"
        case .playing(let item): return "playing(\(name(item)))"
        case .transitioning(let from, let to): return "transitioning(\(name(from)) -> \(name(to)))"
        case .interrupted(let item, let wasPlaying): return "interrupted(\(name(item)), wasPlaying: \(wasPlaying))"
        }
    }

    /// queue-state.js `name(ref)`: an unbounded item reads as its bare id,
    /// exactly as before segments existed; a segment says which slice
    /// (`id[start-end]`, rounded), because "playing(gastropod-fire)" is
    /// ambiguous the moment two items share a source.
    static func name(_ ref: QueueItemRef) -> String {
        guard let bounds = ref.bounds else { return ref.id }
        return "\(ref.id)[\(jsRoundedText(bounds.startSec))-\(jsRoundedText(bounds.endSec))]"
    }

    /// `${Math.round(x)}` for the values `ItemBounds` admits (finite, >= 0).
    ///
    /// `Math.round` rounds half UP; for a non-negative number that is
    /// `.toNearestOrAwayFromZero`, and unlike `floor(x + 0.5)` it does not
    /// turn 0.49999999999999994 into 1. The text is JavaScript's
    /// `String(number)` for an integral double: plain digits below 2^53 (where
    /// every integer is exact); above that JavaScript prints the SHORTEST
    /// round-tripping digits padded with zeros (2^60 is "1152921504606847000",
    /// not "...976"), and exponent form from 1e21. Swift's `description` gives
    /// the same shortest digits, so above 2^53 they come from it and only the
    /// layout is rebuilt.
    static func jsRoundedText(_ value: Double) -> String {
        let rounded = value.rounded(.toNearestOrAwayFromZero)
        if rounded < 9_007_199_254_740_992 { return String(Int64(rounded)) }
        let text = "\(rounded)"
        if rounded >= 1e21 { return text } // "1e+21", "1.5e+300": spelled the same in both
        let parts = text.split(separator: "e")
        // Swift may still print a value just above 2^53 positionally
        // ("9007199254740994.0"); those digits are exact, as JavaScript's are.
        guard parts.count == 2 else { return String(text.split(separator: ".")[0]) }
        // Otherwise Swift writes "d.ddde+N"; JavaScript writes those digits
        // followed by zeros, N + 1 places in all.
        let exponent = Int(parts[1].replacingOccurrences(of: "+", with: "")) ?? 0
        let digits = parts[0].replacingOccurrences(of: ".", with: "")
        return digits + String(repeating: "0", count: max(0, exponent + 1 - digits.count))
    }
}

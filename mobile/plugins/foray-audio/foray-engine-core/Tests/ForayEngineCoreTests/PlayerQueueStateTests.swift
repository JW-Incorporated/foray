// COPIED (card NE-02, docs/native-engine-plan.md §4.1) from
//   ios/ForayKit/Tests/ForayKitTests/PlayerQueueStateTests.swift @ adde5e12
// with the import changed to name this package's module instead of
// ForayKit, and (since NE-07s) one expectation, explained below.
// The ios/ copy is FROZEN REFERENCE; this is the suite that guards the
// engine's reducer (Sources/ForayEngineCore/Reducer/PlayerQueueState.swift)
// on every host `swift test` of foray-engine-core (ci.yml's ios-kit on macOS,
// and G-1a's engine-parity on Linux once it exists).
//
// A plain import, not the original's `@testable import`: every type these
// tests touch is public, and a plain import also compiles under
// `swift test -c release`, where @testable does not.
//
// All 34 of the original's test methods must stay here (shell-invariants pins
// the names against the ios/ original, and test/suite-integrity.test.js
// floors the count). NE-07s ADDS cases as the reducer reaches JS parity; it
// never rewrites these, because they are the proof the extension kept the
// behaviour the scaffold already had. The one exception is a behaviour JS
// changed ON PURPOSE before the port (testSkipToNextWithNoTargetEndsQueue,
// #111), whose expectation follows the reference and says so in place.

import XCTest
import ForayEngineCore

final class PlayerQueueStateTests: XCTestCase {

    // MARK: fixtures

    let episodeA = QueueItemRef(id: "episode-a", kind: .episode)
    let episodeB = QueueItemRef(id: "episode-b", kind: .episode)
    let introTTS = QueueItemRef(id: "intro-tts", kind: .tts)
    let bridgeTTS = QueueItemRef(id: "bridge-tts", kind: .tts)

    // MARK: idle -> loadingItem -> playing

    func testPlayFromIdleTransitionsToLoadingItem() {
        let (state, effects) = PlayerQueueState.reduce(state: .idle, event: .play(episodeA))
        XCTAssertEqual(state, .loadingItem(target: episodeA, previous: nil))
        XCTAssertEqual(effects, [.loadItem(episodeA)])
    }

    func testItemLoadedForEpisodeStartsPlaybackAndRestoresRate() {
        let loading = PlayerQueueState.loadingItem(target: episodeA, previous: nil)
        let (state, effects) = PlayerQueueState.reduce(state: loading, event: .itemLoaded)
        XCTAssertEqual(state, .playing(item: episodeA))
        XCTAssertEqual(effects, [.restoreRate, .startPlayback])
    }

    func testItemLoadedForTTSResetsRateInsteadOfRestoring() {
        let loading = PlayerQueueState.loadingItem(target: introTTS, previous: nil)
        let (state, effects) = PlayerQueueState.reduce(state: loading, event: .itemLoaded)
        XCTAssertEqual(state, .playing(item: introTTS))
        XCTAssertEqual(effects, [.resetRateForTTS, .startPlayback])
        XCTAssertFalse(effects.contains(.restoreRate), "TTS items must never restore the per-show rate on load")
    }

    func testItemLoadedIgnoredWhenNotLoading() {
        let (state, effects) = PlayerQueueState.reduce(state: .idle, event: .itemLoaded)
        XCTAssertEqual(state, .idle)
        XCTAssertEqual(effects.count, 1)
        guard case .emitTelemetry = effects[0] else {
            return XCTFail("expected telemetry-only effect, got \(effects)")
        }
    }

    // MARK: itemEnded / transitions (bridge TTS)

    func testItemEndedWithNoNextItemEndsQueue() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .itemEnded(next: nil, bridged: false))
        XCTAssertEqual(state, .ended)
        XCTAssertEqual(effects, [.emitTelemetry("queue.ended")])
    }

    func testItemEndedDirectCutLoadsNextEpisodeWithoutBridge() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .itemEnded(next: episodeB, bridged: false))
        XCTAssertEqual(state, .loadingItem(target: episodeB, previous: episodeA))
        XCTAssertEqual(effects, [.loadItem(episodeB)])
    }

    func testItemEndedBridgedEntersTransitioningAndPlaysTransitionTTSAtFullRate() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .itemEnded(next: episodeB, bridged: true))
        XCTAssertEqual(state, .transitioning(from: episodeA, to: episodeB))
        XCTAssertEqual(effects, [.resetRateForTTS, .playTransitionTTS])
    }

    func testItemLoadedDuringTransitioningStartsPlaybackWithoutChangingStateValue() {
        let transitioning = PlayerQueueState.transitioning(from: episodeA, to: episodeB)
        let (state, effects) = PlayerQueueState.reduce(state: transitioning, event: .itemLoaded)
        XCTAssertEqual(state, transitioning)
        XCTAssertEqual(effects, [.resetRateForTTS, .startPlayback])
    }

    func testItemEndedAfterTransitioningMovesToNextEpisodeAndRestoresRate() {
        let transitioning = PlayerQueueState.transitioning(from: episodeA, to: episodeB)
        let (state, effects) = PlayerQueueState.reduce(state: transitioning, event: .itemEnded(next: episodeB, bridged: false))
        XCTAssertEqual(state, .loadingItem(target: episodeB, previous: episodeB))
        XCTAssertEqual(effects, [.restoreRate, .loadItem(episodeB)])
    }

    func testItemEndedAfterTransitioningFallsBackToQueuedToWhenNoNextGiven() {
        let transitioning = PlayerQueueState.transitioning(from: episodeA, to: episodeB)
        let (state, effects) = PlayerQueueState.reduce(state: transitioning, event: .itemEnded(next: nil, bridged: false))
        XCTAssertEqual(state, .loadingItem(target: episodeB, previous: episodeB))
        XCTAssertEqual(effects, [.restoreRate, .loadItem(episodeB)])
    }

    // MARK: interruption — phone call declined / answered / long call

    func testInterruptionBeganWhilePlayingSavesPositionAndPauses() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .interruptionBegan)
        XCTAssertEqual(state, .interrupted(item: episodeA, wasPlaying: true))
        XCTAssertEqual(effects, [.savePosition, .pausePlayback, .emitTelemetry("interruption.began")])
    }

    func testDeclinedCall_InterruptionEndsQuicklyWithShouldResume_ResumesPlayback() {
        // Simulates: playing -> phone rings, call declined immediately ->
        // interruption ends almost instantly with shouldResume == true.
        let playing = PlayerQueueState.playing(item: episodeA)
        let (interrupted, _) = PlayerQueueState.reduce(state: playing, event: .interruptionBegan)

        let (resumed, effects) = PlayerQueueState.reduce(state: interrupted, event: .interruptionEnded(shouldResume: true))
        // Resume routes through .loadingItem so the manager can re-prime the
        // asset (no-op if the player still holds it) and re-apply the
        // correct per-kind rate on itemLoaded.
        XCTAssertEqual(resumed, .loadingItem(target: episodeA, previous: episodeA))
        XCTAssertEqual(effects, [.loadItem(episodeA), .emitTelemetry("interruption.ended.resumed")])

        let (playing2, loadedEffects) = PlayerQueueState.reduce(state: resumed, event: .itemLoaded)
        XCTAssertEqual(playing2, .playing(item: episodeA))
        XCTAssertEqual(loadedEffects, [.restoreRate, .startPlayback])
    }

    func testInterruptionDuringTransition_ResumeLandsOnUpcomingItemNotBridgeTTS() {
        // Phone call arrives while the bridge TTS is audible. On resume we
        // must land on the upcoming episode via a fresh load — never resume
        // the half-played bridge, and never inherit the TTS 1.0x rate.
        let transitioning = PlayerQueueState.transitioning(from: episodeA, to: episodeB)
        let (interrupted, _) = PlayerQueueState.reduce(state: transitioning, event: .interruptionBegan)
        XCTAssertEqual(interrupted, .interrupted(item: episodeB, wasPlaying: true))

        let (resumed, effects) = PlayerQueueState.reduce(state: interrupted, event: .interruptionEnded(shouldResume: true))
        XCTAssertEqual(resumed, .loadingItem(target: episodeB, previous: episodeB))
        XCTAssertEqual(effects, [.loadItem(episodeB), .emitTelemetry("interruption.ended.resumed")])

        let (playing, loadedEffects) = PlayerQueueState.reduce(state: resumed, event: .itemLoaded)
        XCTAssertEqual(playing, .playing(item: episodeB))
        XCTAssertEqual(loadedEffects, [.restoreRate, .startPlayback])
    }

    func testAnsweredCall_InterruptionEndsWithoutShouldResume_StaysPausedButReady() {
        // Simulates: playing -> call answered -> after hangup, system says
        // shouldResume == false (common when the call was actually
        // answered and used).
        let playing = PlayerQueueState.playing(item: episodeA)
        let (interrupted, _) = PlayerQueueState.reduce(state: playing, event: .interruptionBegan)

        let (paused, effects) = PlayerQueueState.reduce(state: interrupted, event: .interruptionEnded(shouldResume: false))
        XCTAssertEqual(paused, .interrupted(item: episodeA, wasPlaying: false))
        XCTAssertEqual(effects, [.emitTelemetry("interruption.ended.staysPaused")])

        // Lock screen must show correct (paused, resumable) state, and a
        // manual play() must work from here.
        let (resumedManually, resumeEffects) = PlayerQueueState.reduce(state: paused, event: .play(episodeA))
        XCTAssertEqual(resumedManually, .loadingItem(target: episodeA, previous: episodeA))
        XCTAssertEqual(resumeEffects, [.loadItem(episodeA)])
    }

    func testLongCall_PositionAndItemIdentityPreservedThroughoutInterruption() {
        // 20-minute call: began -> (OS may deactivate our session, but the
        // reducer doesn't care about that) -> ended. Item identity must
        // survive unchanged the whole time so "restore exactly" holds.
        let playing = PlayerQueueState.playing(item: episodeA)
        let (interrupted, beganEffects) = PlayerQueueState.reduce(state: playing, event: .interruptionBegan)
        XCTAssertTrue(beganEffects.contains(.savePosition))

        guard case .interrupted(let item, let wasPlaying) = interrupted else {
            return XCTFail("expected .interrupted")
        }
        XCTAssertEqual(item, episodeA)
        XCTAssertTrue(wasPlaying)

        let (resumed, _) = PlayerQueueState.reduce(state: interrupted, event: .interruptionEnded(shouldResume: true))
        XCTAssertEqual(resumed, .loadingItem(target: episodeA, previous: episodeA))
        let (playing2, _) = PlayerQueueState.reduce(state: resumed, event: .itemLoaded)
        XCTAssertEqual(playing2, .playing(item: episodeA))
    }

    func testInterruptionBeganDuringLoadDoesNotPauseOrSavePosition() {
        // Nothing audible yet; no position exists to save, nothing to pause.
        let loading = PlayerQueueState.loadingItem(target: episodeA, previous: nil)
        let (state, effects) = PlayerQueueState.reduce(state: loading, event: .interruptionBegan)
        XCTAssertEqual(state, .interrupted(item: episodeA, wasPlaying: false))
        XCTAssertEqual(effects, [.emitTelemetry("interruption.began.duringLoad")])
    }

    func testInterruptionBeganIsIdempotent() {
        let interrupted = PlayerQueueState.interrupted(item: episodeA, wasPlaying: true)
        let (state, effects) = PlayerQueueState.reduce(state: interrupted, event: .interruptionBegan)
        XCTAssertEqual(state, interrupted)
        XCTAssertEqual(effects, [])
    }

    // MARK: route change (Bluetooth)

    func testRouteChangedOldDeviceUnavailableWhilePlayingPausesImmediately() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .routeChanged(oldDeviceUnavailable: true))
        XCTAssertEqual(state, .interrupted(item: episodeA, wasPlaying: true))
        XCTAssertEqual(effects, [.savePosition, .pausePlayback, .emitTelemetry("route.oldDeviceUnavailable.paused")])
    }

    func testRouteChangedMidTTSTransitionPausesAndTracksUpcomingItem() {
        let transitioning = PlayerQueueState.transitioning(from: episodeA, to: episodeB)
        let (state, effects) = PlayerQueueState.reduce(state: transitioning, event: .routeChanged(oldDeviceUnavailable: true))
        XCTAssertEqual(state, .interrupted(item: episodeB, wasPlaying: true))
        XCTAssertEqual(effects, [.savePosition, .pausePlayback, .emitTelemetry("route.oldDeviceUnavailable.pausedDuringTransition")])
    }

    func testRouteChangedNewDeviceAvailableDoesNotAutoResumeStateMachine() {
        // Policy of "resume only for known car routes" lives in the
        // manager; the reducer must not unilaterally resume.
        let interrupted = PlayerQueueState.interrupted(item: episodeA, wasPlaying: true)
        let (state, effects) = PlayerQueueState.reduce(state: interrupted, event: .routeChanged(oldDeviceUnavailable: false))
        XCTAssertEqual(state, interrupted)
        XCTAssertEqual(effects, [.emitTelemetry("route.changed.available")])
    }

    func testRouteChangedOldDeviceUnavailableDuringLoadSuppressesSubsequentAutoPlay() {
        let loading = PlayerQueueState.loadingItem(target: episodeA, previous: nil)
        let (interrupted, _) = PlayerQueueState.reduce(state: loading, event: .routeChanged(oldDeviceUnavailable: true))
        XCTAssertEqual(interrupted, .interrupted(item: episodeA, wasPlaying: false))

        // A stray itemLoaded arriving after the route died must not start
        // audio into a dead route.
        let (state, effects) = PlayerQueueState.reduce(state: interrupted, event: .itemLoaded)
        XCTAssertEqual(state, interrupted)
        guard case .emitTelemetry = effects.first else {
            return XCTFail("expected itemLoaded to be ignored")
        }
    }

    // MARK: single-player invariant (corner case 19)

    func testPlayWhileAlreadyPlayingDifferentItemForcesPauseBeforeLoadingNew() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .play(episodeB))
        XCTAssertEqual(state, .loadingItem(target: episodeB, previous: episodeA))
        XCTAssertEqual(effects, [
            .pausePlayback,
            .loadItem(episodeB),
            .emitTelemetry("player.doubleEntryGuard: play(episode-b) while playing episode-a")
        ])
        // Exactly one pausePlayback — never two concurrent "start" effects.
        XCTAssertEqual(effects.filter { $0 == .pausePlayback }.count, 1)
    }

    func testPlaySameItemAlreadyPlayingIsNoOp() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .play(episodeA))
        XCTAssertEqual(state, playing)
        XCTAssertEqual(effects, [])
    }

    func testPlayWhileTransitioningForcesPauseBeforeLoadingNew() {
        let transitioning = PlayerQueueState.transitioning(from: episodeA, to: episodeB)
        let (state, effects) = PlayerQueueState.reduce(state: transitioning, event: .play(episodeA))
        XCTAssertEqual(state, .loadingItem(target: episodeA, previous: episodeB))
        XCTAssertTrue(effects.contains(.pausePlayback))
        XCTAssertEqual(effects.filter { $0 == .pausePlayback }.count, 1)
    }

    // MARK: fast double-skip serialization

    func testFastDoubleSkipToNextReplacesInFlightLoadWithoutStackingLoads() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (afterFirstSkip, firstEffects) = PlayerQueueState.reduce(state: playing, event: .skipToNext(episodeB))
        XCTAssertEqual(afterFirstSkip, .loadingItem(target: episodeB, previous: episodeA))
        XCTAssertEqual(firstEffects, [.savePosition, .pausePlayback, .loadItem(episodeB), .emitTelemetry("skip.next")])

        let episodeC = QueueItemRef(id: "episode-c", kind: .episode)
        let (afterSecondSkip, secondEffects) = PlayerQueueState.reduce(state: afterFirstSkip, event: .skipToNext(episodeC))
        XCTAssertEqual(afterSecondSkip, .loadingItem(target: episodeC, previous: episodeA))

        // Exactly one loadItem effect in the second reduction — the
        // in-flight load for episodeB is replaced, never run alongside it.
        let loadEffects = secondEffects.filter { if case .loadItem = $0 { return true } else { return false } }
        XCTAssertEqual(loadEffects, [.loadItem(episodeC)])
        XCTAssertFalse(secondEffects.contains(.loadItem(episodeB)))
    }

    func testDoubleSkipToSameInFlightTargetIsNoOp() {
        let loading = PlayerQueueState.loadingItem(target: episodeB, previous: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: loading, event: .skipToNext(episodeB))
        XCTAssertEqual(state, loading)
        XCTAssertEqual(effects, [])
    }

    func testSkipToPreviousWithNoTargetRestartsCurrentItemInPlace() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .skipToPrevious(nil))
        XCTAssertEqual(state, .loadingItem(target: episodeA, previous: episodeA))
        XCTAssertEqual(effects, [.savePosition, .pausePlayback, .loadItem(episodeA), .emitTelemetry("skip.previous.restartInPlace")])
    }

    func testSkipToNextWithNoTargetEndsQueue() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .skipToNext(nil))
        XCTAssertEqual(state, .ended)
        // THE ONE EXPECTATION NE-07s CHANGED, because JS changed it first
        // (#111, player/queue-state.test.js's test of the same name): the
        // scaffold ended the queue with telemetry alone and left the audio
        // playing while the state said the session was over. JS is the
        // reference (plan §6), and the fixture case covering this test
        // pins the new effects, so keeping the scaffold's line here would
        // hold two contradictory answers to one question.
        XCTAssertEqual(effects, [.savePosition, .pausePlayback, .emitTelemetry("skip.next.queueExhausted")])
    }

    func testSkipFromIdleActsLikeFreshPlay() {
        let (state, effects) = PlayerQueueState.reduce(state: .idle, event: .skipToNext(episodeA))
        XCTAssertEqual(state, .loadingItem(target: episodeA, previous: nil))
        XCTAssertEqual(effects, [.loadItem(episodeA)])
    }

    // MARK: stop

    func testStopWhilePlayingSavesPositionAndReturnsToIdle() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .stop)
        XCTAssertEqual(state, .idle)
        XCTAssertEqual(effects, [.savePosition, .pausePlayback, .emitTelemetry("player.stopped")])
    }

    func testStopWhileIdleIsNoOp() {
        let (state, effects) = PlayerQueueState.reduce(state: .idle, event: .stop)
        XCTAssertEqual(state, .idle)
        XCTAssertEqual(effects, [])
    }

    func testStopWhileTransitioningSavesPositionAndPauses() {
        let transitioning = PlayerQueueState.transitioning(from: episodeA, to: episodeB)
        let (state, effects) = PlayerQueueState.reduce(state: transitioning, event: .stop)
        XCTAssertEqual(state, .idle)
        XCTAssertEqual(effects, [.savePosition, .pausePlayback, .emitTelemetry("player.stopped")])
    }

    // MARK: error / degrade path

    func testErrorFromAnyStateDropsToIdleAndPauses() {
        let playing = PlayerQueueState.playing(item: episodeA)
        let (state, effects) = PlayerQueueState.reduce(state: playing, event: .error("missing file"))
        XCTAssertEqual(state, .idle)
        XCTAssertEqual(effects, [.pausePlayback, .emitTelemetry("player.error: missing file")])
    }

    // MARK: ended -> play (starting a fresh session after exhausting one)

    func testPlayFromEndedStartsFreshLoad() {
        let (state, effects) = PlayerQueueState.reduce(state: .ended, event: .play(episodeA))
        XCTAssertEqual(state, .loadingItem(target: episodeA, previous: nil))
        XCTAssertEqual(effects, [.loadItem(episodeA)])
    }
}

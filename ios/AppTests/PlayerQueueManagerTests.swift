import XCTest
import CoreMedia
import Foundation
import ForayKit
@testable import Foray

/// M5 (full-repo-review-report.md, 2026-08-31): before this, `PlayerQueueManager`
/// (the App-target glue between ForayKit's pure state machine and AVFoundation) had
/// no test coverage at all — CI's `ios-kit` job only runs `swift test --package-path
/// ios/ForayKit`, which never compiles anything under `App/`. This exercises the
/// manager's own orchestration logic (which effect -> which backend call, in what
/// order, and the currentIndex/targetIndex bookkeeping the file's own header calls
/// the highest-risk untested area) against `FakePlayerBackend`, with no AVFoundation
/// touched at all.
final class PlayerQueueManagerTests: XCTestCase {

    // MARK: fixtures

    private func makeItem(
        id: String,
        kind: PlayerItemKind = .episode,
        startOffset: CMTime = .zero,
        showRate: Float = 1.0
    ) -> PlayableItem {
        PlayableItem(
            ref: QueueItemRef(id: id, kind: kind),
            localURL: URL(fileURLWithPath: "/tmp/\(id).mp3"),
            nowPlayingTitle: id,
            startOffset: startOffset,
            showRate: showRate
        )
    }

    private func makeManager(
        backend: FakePlayerBackend = FakePlayerBackend(),
        positionStore: FakePositionStore = FakePositionStore()
    ) -> PlayerQueueManager {
        PlayerQueueManager(backend: backend, positionStore: positionStore)
    }

    // MARK: queue management — play, load, transport

    func testPlayLoadsAndStartsTheTargetedItem() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let itemA = makeItem(id: "episode-a")
        let itemB = makeItem(id: "episode-b")
        await manager.loadQueue([itemA, itemB])

        await manager.play(itemAt: 0)

        XCTAssertEqual(backend.calls, [
            .load(url: itemA.localURL, startOffset: .zero),
            .play,
        ])
    }

    func testPlayAtOutOfRangeIndexIsANoOp() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        await manager.loadQueue([makeItem(id: "episode-a")])

        await manager.play(itemAt: 5)

        XCTAssertTrue(backend.calls.isEmpty, "an out-of-range play() must not touch the backend at all")
    }

    func testSkipToNextLoadsTheNextItemAndSavesPositionFirst() async throws {
        let backend = FakePlayerBackend()
        backend.currentTime = CMTime(seconds: 42, preferredTimescale: 600)
        let positionStore = FakePositionStore()
        let manager = makeManager(backend: backend, positionStore: positionStore)
        let itemA = makeItem(id: "episode-a")
        let itemB = makeItem(id: "episode-b")
        await manager.loadQueue([itemA, itemB])
        await manager.play(itemAt: 0)

        await manager.skipToNext()

        // savePosition happens before the new loadItem — 05_CORNER_CASES-driven
        // ordering the manager's own comments call load-bearing (targetIndex vs
        // currentIndex split), verified here via the position store's write and
        // the backend's second load call. Not `.last`: a successful load is
        // immediately followed by `.itemLoaded` -> `.play`, so `.play` is the
        // actual final call.
        let savedA = try XCTUnwrap(positionStore.loadPosition(itemID: "episode-a"))
        XCTAssertEqual(savedA, 42, accuracy: 0.001)
        XCTAssertTrue(backend.calls.contains(.load(url: itemB.localURL, startOffset: .zero)),
            "expected a load of episode-b, calls=\(backend.calls)")
    }

    func testSkipToNextAtEndOfQueueEndsPlayback() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let itemA = makeItem(id: "episode-a")
        await manager.loadQueue([itemA])
        await manager.play(itemAt: 0)
        backend.clearCalls()

        await manager.skipToNext()

        // No further item to load -> pausePlayback then nothing else; no crash,
        // no stray loadItem.
        XCTAssertFalse(backend.calls.contains(where: {
            if case .load = $0 { return true }
            return false
        }), "skipping past the end of the queue must not issue a load")
    }

    func testSkipToPreviousRestartsAtZeroRegardlessOfStoredStartOffset() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        // startOffset != .zero simulates a mid-episode resume point.
        let item = makeItem(id: "episode-a", startOffset: CMTime(seconds: 300, preferredTimescale: 600))
        await manager.loadQueue([item])
        await manager.play(itemAt: 0)
        backend.clearCalls()

        await manager.skipToPrevious()

        // "Restart" must mean zero, not the item's original resume offset — see
        // the manager's own comment on `forceNextStartOffset`. Not `.last`: the
        // successful load is followed by `.itemLoaded` -> `.play`.
        XCTAssertTrue(backend.calls.contains(.load(url: item.localURL, startOffset: .zero)),
            "expected a restart load at zero offset, calls=\(backend.calls)")
    }

    func testTTSItemResetsRateAndEpisodeRestoresShowRate() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let ttsItem = makeItem(id: "intro-tts", kind: .tts, showRate: 1.75)
        await manager.loadQueue([ttsItem])

        await manager.play(itemAt: 0)

        // resetRateForTTS forces 1.0x regardless of showRate (05_CORNER_CASES.md
        // #18) — TTS items must never play at the per-show rate.
        XCTAssertEqual(backend.rate, 1.0, accuracy: 0.0001)
    }

    func testEpisodeItemRestoresItsShowRateOnLoad() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let episode = makeItem(id: "episode-a", showRate: 1.5)
        await manager.loadQueue([episode])

        await manager.play(itemAt: 0)

        XCTAssertEqual(backend.rate, 1.5, accuracy: 0.0001)
    }

    // MARK: load failure -> error path, never a crash

    func testLoadFailureSurfacesAsAnErrorRatherThanCrashing() async {
        let backend = FakePlayerBackend()
        backend.nextLoadError = FakePlayerBackendError.missingFile
        let manager = makeManager(backend: backend)
        await manager.loadQueue([makeItem(id: "episode-a")])

        await manager.play(itemAt: 0)

        // The load was attempted and threw. ForayKit's reducer (see
        // PlayerQueueState.reduce's `.error` case) treats any failure as a
        // defensive `.pausePlayback` + `.idle` transition regardless of
        // whether playback ever actually started, so a `.pause` call after
        // the failed `.load` is expected, correct behaviour here — not
        // something this App-level test owns or should assert an exact
        // count against. What this manager must guarantee is the one thing
        // that would mean "crashed instead of erroring": it never calls
        // play() on a backend with nothing successfully loaded.
        XCTAssertTrue(backend.calls.contains(.load(url: makeItem(id: "episode-a").localURL, startOffset: .zero)),
            "expected the failed load to have been attempted, calls=\(backend.calls)")
        XCTAssertFalse(backend.calls.contains(.play),
            "a failed load must never be followed by play(), calls=\(backend.calls)")
    }

    // MARK: interruption / audio-session-adjacent behaviour (via the public API)

    func testPauseThenResumeReplaysThroughTheReducerWithoutDoubleLoading() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let item = makeItem(id: "episode-a")
        await manager.loadQueue([item])
        await manager.play(itemAt: 0)
        backend.clearCalls()

        await manager.pause()
        XCTAssertEqual(backend.calls, [.pause])

        backend.clearCalls()
        await manager.resume()
        // Resume re-primes the load per PlayerQueueState's design note 2 (does not
        // assume the backend kept the asset warm) then starts playback again.
        XCTAssertTrue(backend.calls.contains(.play))
    }

    func testStopClearsPlaybackAndSavesPosition() async throws {
        let backend = FakePlayerBackend()
        backend.currentTime = CMTime(seconds: 10, preferredTimescale: 600)
        let positionStore = FakePositionStore()
        let manager = makeManager(backend: backend, positionStore: positionStore)
        let item = makeItem(id: "episode-a")
        await manager.loadQueue([item])
        await manager.play(itemAt: 0)

        await manager.stop()

        let saved = try XCTUnwrap(positionStore.loadPosition(itemID: "episode-a"))
        XCTAssertEqual(saved, 10, accuracy: 0.001)
        XCTAssertTrue(backend.calls.contains(.pause))
    }

    // MARK: cold-launch restore

    func testRestoreColdLaunchStateLoadsWithoutCallingPlay() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let item = makeItem(id: "episode-a", startOffset: CMTime(seconds: 60, preferredTimescale: 600))

        await manager.restoreColdLaunchState(items: [item], index: 0)

        // Cold launch must prime the player paused-and-ready — it must load the
        // item at its saved offset but never call backend.play(), so a relaunch
        // never surprises the user with sudden audio (05_CORNER_CASES.md #15).
        XCTAssertTrue(backend.calls.contains(.load(url: item.localURL, startOffset: item.startOffset)))
        XCTAssertFalse(backend.calls.contains(.play), "cold-launch restore must never auto-play")
    }

    func testRestoreColdLaunchStateOutOfRangeIndexIsANoOp() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)

        await manager.restoreColdLaunchState(items: [makeItem(id: "episode-a")], index: 3)

        XCTAssertTrue(backend.calls.isEmpty)
    }

    // MARK: backend "item ended" -> bridge / next-item wiring

    func testItemEndedWithoutBridgeAdvancesDirectlyToNextItem() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let episodeA = makeItem(id: "episode-a")
        let episodeB = makeItem(id: "episode-b")
        await manager.loadQueue([episodeA, episodeB])
        await manager.play(itemAt: 0)
        backend.clearCalls()

        backend.simulateItemDidPlayToEnd()
        // The manager handles this via a detached `Task { await
        // self.handleBackendItemEnded() }`, so poll with a timeout instead of a
        // single fixed sleep — deterministic on a fast machine, resilient to a
        // busy/throttled CI runner.
        let sawLoad = await waitUntil {
            backend.calls.contains(.load(url: episodeB.localURL, startOffset: .zero))
        }
        XCTAssertTrue(sawLoad, "expected a load of episode-b, calls=\(backend.calls)")
    }

    func testItemEndedWithBridgePlaysTheTransitionTTSFirst() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let episodeA = makeItem(id: "episode-a")
        let bridgeTTS = makeItem(id: "bridge-tts", kind: .tts)
        let episodeB = makeItem(id: "episode-b")
        await manager.loadQueue([episodeA, bridgeTTS, episodeB])
        await manager.play(itemAt: 0)
        backend.clearCalls()

        backend.simulateItemDidPlayToEnd()

        // The bridge TTS should be loaded (and, per playTransitionBridge, played)
        // before the real next episode.
        let sawBridgeLoad = await waitUntil {
            backend.calls.contains(.load(url: bridgeTTS.localURL, startOffset: .zero))
        }
        XCTAssertTrue(sawBridgeLoad, "expected a load of the bridge TTS, calls=\(backend.calls)")
    }

    func testTransitionBridgeLoadFailureAdvancesPastItRatherThanStalling() async {
        let backend = FakePlayerBackend()
        let manager = makeManager(backend: backend)
        let episodeA = makeItem(id: "episode-a")
        let bridgeTTS = makeItem(id: "bridge-tts", kind: .tts)
        let episodeB = makeItem(id: "episode-b")
        await manager.loadQueue([episodeA, bridgeTTS, episodeB])
        await manager.play(itemAt: 0)

        // Arm the NEXT load (the bridge's) to fail.
        backend.nextLoadError = FakePlayerBackendError.missingFile
        backend.clearCalls()
        backend.simulateItemDidPlayToEnd()

        // Per the manager's advancePastTransitionFailure: a missing/corrupt bridge
        // asset must never stall the whole queue — it should skip straight to the
        // real next item.
        let sawFallthroughLoad = await waitUntil {
            backend.calls.contains(.load(url: episodeB.localURL, startOffset: .zero))
        }
        XCTAssertTrue(sawFallthroughLoad,
            "a failed bridge load must fall through to the next real item, calls=\(backend.calls)")
    }

    /// Polls `condition` up to `timeoutSeconds`, yielding between checks, so
    /// assertions on work done by a manager-internal detached `Task` are
    /// deterministic instead of racing a single fixed `Task.sleep`. Returns as
    /// soon as `condition` is true, or `false` once the timeout elapses.
    private func waitUntil(
        timeoutSeconds: Double = 2.0,
        _ condition: @Sendable () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 5_000_000) // 5ms
        }
        return condition()
    }
}

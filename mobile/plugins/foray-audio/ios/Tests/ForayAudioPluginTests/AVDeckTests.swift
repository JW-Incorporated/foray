import XCTest
import AVFoundation
@testable import ForayAudioPlugin

/// AVDeck against a REAL AVPlayer in the iOS Simulator (card NE-15,
/// docs/native-engine-plan.md §14), on the two bundled click tracks in
/// `Fixtures/` (20 s mono; `tools/mobile/click-tracks/make-click-tracks.mjs`
/// is the recipe):
///
///   - `click-cbr-64k.mp3`: CBR MP3 with no Xing/LAME tag, the encoding whose
///     seek table is pure byte arithmetic;
///   - `click-11k.wav`: PCM, where a seek is exact by construction.
///
/// RUN ON CI ONLY: `ci.yml`'s ios-kit runs `xcodebuild test -scheme
/// ForayAudio` on an iOS Simulator. Nothing here runs on the Windows machine
/// the repo is written on.
///
/// Each test names the rule it guards and the edit that turns it red.
final class AVDeckTests: XCTestCase {
    private var deck: AVDeck!
    private var events: [DeckEvent] = []
    private var rows: [String] = []
    private var faults: [String] = []
    private var sessionActive = true
    private var stallingLoader: NeverAnsweringLoader?

    override func setUp() {
        super.setUp()
        deck = makeDeck()
    }

    override func tearDown() {
        deck?.send(.unload)
        deck = nil
        super.tearDown()
    }

    private func makeDeck(
        deadlineSec: Double = AVDeck.defaultLoadDeadlineSec,
        makeAsset: ((URL, Bool) -> AVURLAsset)? = nil
    ) -> AVDeck {
        let config = AVDeck.Config(
            loadDeadlineSec: deadlineSec,
            sessionIsActive: { [unowned self] in self.sessionActive },
            writeRow: { [unowned self] in self.rows.append($0) },
            debugFault: { [unowned self] in self.faults.append($0) },
            makeAsset: makeAsset ?? AVDeck.defaultAsset
        )
        let deck = AVDeck(config: config)
        deck.onEvent = { [unowned self] in self.events.append($0) }
        return deck
    }

    private func fixture(_ name: String, _ ext: String) throws -> URL {
        try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"),
            "missing bundled fixture Fixtures/\(name).\(ext)"
        )
    }

    /// Spins the main run loop (where every deck callback lands) until an
    /// event matches, or fails with the events seen so far.
    @discardableResult
    private func waitFor(
        _ what: String,
        timeout: TimeInterval = 15,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ match: (DeckEvent) -> Bool
    ) -> DeckEvent? {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until {
            if let hit = events.first(where: match) { return hit }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTFail("timed out after \(timeout) s waiting for \(what); events: \(events)", file: file, line: line)
        return nil
    }

    private func spin(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func readyEvent(_ token: DeckToken, file: StaticString = #filePath, line: UInt = #line)
        -> (landedSec: Double, prerolled: Bool, elapsedMs: Int)? {
        let hit = waitFor("ready(token: \(token))", file: file, line: line) {
            if case .ready(token, _, _, _) = $0 { return true }
            if case .failed(token, _) = $0 { return true }
            return false
        }
        switch hit {
        case let .ready(_, landed, prerolled, elapsed)?:
            return (landed, prerolled, elapsed)
        case let .failed(_, message)?:
            XCTFail("load \(token) failed: \(message)", file: file, line: line)
            return nil
        default:
            return nil
        }
    }

    private func loadAndWaitReady(
        _ url: URL, token: DeckToken, startSec: Double, precise: Bool = true,
        file: StaticString = #filePath, line: UInt = #line
    ) -> (landedSec: Double, prerolled: Bool, elapsedMs: Int)? {
        deck.send(.load(token: token, url: url, startSec: startSec, preciseTiming: precise))
        return readyEvent(token, file: file, line: line)
    }

    // MARK: - Settings

    /// Plan §4.3's deck settings. TO SEE IT FAIL: drop any of the three
    /// assignments in AVDeck (`init` / `load`).
    func testDeckSettingsAreThePlans() throws {
        XCTAssertEqual(deck.player.actionAtItemEnd, .pause)
        XCTAssertTrue(deck.player.automaticallyWaitsToMinimizeStalling)
        deck.send(.load(token: 1, url: try fixture("click-11k", "wav"), startSec: 0, preciseTiming: true))
        XCTAssertEqual(deck.player.currentItem?.audioTimePitchAlgorithm, .timeDomain)
    }

    // MARK: - Offset landing, and the measurement the card asks for

    /// The zero-tolerance seek lands the start offset, and the preroll is
    /// issued once, AFTER both statuses were `.readyToPlay` and at rate 0 (the
    /// deck writes what it saw into the primitive). The landing error and the
    /// time to ready go into the job summary as MEASUREMENTS.
    /// TO SEE IT FAIL: give `gateSeek` a tolerance (`.positiveInfinity`), or
    /// call `becomeReady` from `advanceIfReady` without the seek.
    func testOffsetLandsOnTheCbrMp3AndTheWav() throws {
        let start = 7.3
        let cases: [(name: String, ext: String, precise: Bool, label: String)] = [
            ("click-cbr-64k", "mp3", true, "CBR MP3, precise"),
            ("click-cbr-64k", "mp3", false, "CBR MP3, approximate"),
            ("click-11k", "wav", true, "WAV, precise")
        ]
        for (index, item) in cases.enumerated() {
            events.removeAll()
            let token = index + 1
            guard let ready = loadAndWaitReady(try fixture(item.name, item.ext), token: token, startSec: start, precise: item.precise)
            else { return }
            let errorMs = (ready.landedSec - start) * 1000
            DeckMeasurements.record(
                "\(item.label): landing error \(String(format: "%+.3f", errorMs)) ms "
                + "(currentTime after the zero-tolerance seek, target \(start) s), "
                + "time to ready \(ready.elapsedMs) ms, prerolled=\(ready.prerolled)"
            )
            // One-sided and generous: this is a landing check, not the
            // measurement (NE-25a measures the audible landing with a tap).
            XCTAssertLessThan(abs(errorMs), 100, "\(item.label) landed \(errorMs) ms from the target")
            // This load's primitives only: everything since its attach.
            let attach = try XCTUnwrap(deck.primitives.lastIndex(of: "attach"))
            let ops = Array(deck.primitives[attach...])
            let prerolls = ops.filter { $0.hasPrefix("preroll") }
            XCTAssertEqual(prerolls.count, 1, "\(item.label): expected exactly one preroll, got \(ops)")
            if let preroll = prerolls.first {
                // AVPlayer.Status.readyToPlay == 1, AVPlayerItem.Status.readyToPlay == 1.
                XCTAssertEqual(preroll, "preroll player=1 item=1 rate=0.0")
            }
            let seek = ops.firstIndex(of: "seek 7.300")
            let prerollAt = ops.firstIndex { $0.hasPrefix("preroll") }
            XCTAssertNotNil(seek, "\(ops)")
            if let seek, let prerollAt { XCTAssertLessThan(seek, prerollAt, "the preroll must follow the seek") }
            deck.send(.unload)
        }
    }

    /// A seek that arrives before `.ready` moves the start; the gate lands
    /// there rather than at the load's original offset.
    /// TO SEE IT FAIL: make `seek(to:)` ignore `.loading`/`.gating`.
    func testASeekBeforeReadyMovesTheStart() throws {
        deck.send(.load(token: 1, url: try fixture("click-11k", "wav"), startSec: 2, preciseTiming: true))
        deck.send(.seek(toSec: 11))
        guard let ready = readyEvent(1) else { return }
        XCTAssertEqual(ready.landedSec, 11, accuracy: 0.1)
    }

    // MARK: - Nothing audible before ready

    /// Plan §4.3: `deckPlay` is legal only after `ready`. A play sent the
    /// moment a load starts is refused, the player's rate stays 0, and no
    /// play primitive is issued; the same play after `.ready` runs.
    /// TO SEE IT FAIL: drop the `stage == .ready` guard in `play()`.
    func testNothingIsAudibleBeforeReady() throws {
        deck.send(.load(token: 1, url: try fixture("click-cbr-64k", "mp3"), startSec: 3, preciseTiming: true))
        deck.send(.play)
        XCTAssertTrue(events.contains(.refused(command: "play", reason: "not-ready")), "\(events)")
        XCTAssertEqual(deck.player.rate, 0)
        guard readyEvent(1) != nil else { return }
        XCTAssertEqual(deck.player.rate, 0, "a prerolled deck must still be silent until play")
        XCTAssertFalse(deck.primitives.contains { $0.hasPrefix("play") }, "\(deck.primitives)")
        deck.send(.play)
        XCTAssertEqual(deck.player.rate, 1)
    }

    /// A new load stops whatever the deck was playing BEFORE it attaches the
    /// next item, so the previous rate never carries the new item into sound
    /// ahead of its gate. TO SEE IT FAIL: remove the pause at the top of
    /// `load(...)`.
    func testALoadSilencesTheDeckBeforeTheNextItemAttaches() throws {
        guard loadAndWaitReady(try fixture("click-11k", "wav"), token: 1, startSec: 0) != nil else { return }
        deck.send(.play)
        XCTAssertEqual(deck.player.rate, 1)
        deck.send(.load(token: 2, url: try fixture("click-cbr-64k", "mp3"), startSec: 4, preciseTiming: true))
        XCTAssertEqual(deck.player.rate, 0, "the next item attached to a playing player")
        guard readyEvent(2) != nil else { return }
        XCTAssertEqual(deck.player.rate, 0)
    }

    /// A superseded load reports nothing after it is superseded: every late
    /// callback carries the old generation. TO SEE IT FAIL: drop the
    /// `gen == generation` guard in `gateSeekCompleted` or `becomeReady`'s
    /// callers.
    func testASupersededLoadIsSilent() throws {
        deck.send(.load(token: 1, url: try fixture("click-cbr-64k", "mp3"), startSec: 5, preciseTiming: true))
        deck.send(.load(token: 2, url: try fixture("click-11k", "wav"), startSec: 6, preciseTiming: true))
        guard let ready = readyEvent(2) else { return }
        XCTAssertEqual(ready.landedSec, 6, accuracy: 0.1)
        spin(0.5)
        let late = events.filter {
            switch $0 {
            case .ready(1, _, _, _), .durationLoaded(1, _), .notReady(1, _, _), .failed(1, _), .deadlineExceeded(1, _):
                return true
            default:
                return false
            }
        }
        XCTAssertEqual(late, [], "the superseded load (token 1) still reported")
    }

    // MARK: - Rate

    /// The listener's rate is held by the deck and re-applied on every play,
    /// across three loads (alternating encodings).
    /// TO SEE IT FAIL: apply `rate` only in `setRate` (not in
    /// `applyRateAndPlay`), or reset it in `load(...)`.
    func testRateIsHeldAcrossThreeLoads() throws {
        deck.send(.setRate(1.5))
        let files = [("click-cbr-64k", "mp3"), ("click-11k", "wav"), ("click-cbr-64k", "mp3")]
        for (index, file) in files.enumerated() {
            events.removeAll()
            let token = index + 1
            guard loadAndWaitReady(try fixture(file.0, file.1), token: token, startSec: Double(index)) != nil else { return }
            XCTAssertEqual(deck.player.rate, 0, "load \(token) was not silent at ready")
            deck.send(.play)
            XCTAssertEqual(deck.player.rate, 1.5, accuracy: 0.001, "load \(token) played at the wrong rate")
            if #available(iOS 16.0, *) {
                XCTAssertEqual(deck.player.defaultRate, 1.5, accuracy: 0.001)
            }
        }
        let plays = deck.primitives.filter { $0.hasPrefix("play") }
        XCTAssertEqual(plays.count, 3)
        XCTAssertTrue(plays.allSatisfy { $0.hasSuffix("=1.5") }, "\(plays)")
    }

    // MARK: - Deadline

    /// A URL that never becomes ready hits the deadline, the item is detached,
    /// and NO preroll was ever issued (the uncatchable exception path). The
    /// asset's resource loader accepts every request and never answers, so
    /// the load hangs deterministically with no network involved.
    /// TO SEE IT FAIL: remove `armDeadline` from `load(...)`, or let
    /// `advanceIfReady` proceed without `item.status == .readyToPlay` (the
    /// preroll then throws on a non-ready item).
    func testANeverReadyUrlHitsTheDeadlineWithNoPreroll() throws {
        let loader = NeverAnsweringLoader()
        stallingLoader = loader
        deck.send(.unload)
        deck = makeDeck(deadlineSec: 1.0) { url, precise in
            let asset = AVDeck.defaultAsset(url, precise)
            asset.resourceLoader.setDelegate(loader, queue: loader.queue)
            return asset
        }
        let never = try XCTUnwrap(URL(string: "foray-never://deck.test/never.mp3"))
        deck.send(.load(token: 7, url: never, startSec: 12, preciseTiming: true))
        let hit = waitFor("deadlineExceeded(token: 7)", timeout: 10) {
            if case .deadlineExceeded(7, _) = $0 { return true }
            return false
        }
        if case let .deadlineExceeded(_, afterMs)? = hit {
            XCTAssertGreaterThanOrEqual(afterMs, 1000)
        }
        XCTAssertGreaterThan(loader.requests, 0, "the stalling loader was never asked; the test proved nothing")
        XCTAssertFalse(deck.primitives.contains { $0.hasPrefix("preroll") }, "\(deck.primitives)")
        XCTAssertFalse(events.contains { if case .ready = $0 { return true }; return false })
        XCTAssertNil(deck.player.currentItem, "the deadline must detach the item")
        events.removeAll()
        deck.send(.play)
        XCTAssertEqual(events, [.refused(command: "play", reason: "failed")])
        XCTAssertEqual(deck.player.rate, 0)
    }

    /// The deadline's production value is the plan's provisional 20 s.
    func testTheProvisionalDeadlineIsTwentySeconds() {
        XCTAssertEqual(AVDeck.defaultLoadDeadlineSec, 20)
    }

    // MARK: - Observation

    /// A pause the deck did not command (the system's, stood in for by
    /// pausing the real player behind the deck's back) becomes ONE reconcile
    /// input; a commanded pause does not.
    /// TO SEE IT FAIL: remove the `rate` KVO in `observePlayer`, or drop the
    /// `intendsToPlay = false` in `pause()`.
    func testAnExternalPauseBecomesAReconcileInput() throws {
        guard loadAndWaitReady(try fixture("click-cbr-64k", "mp3"), token: 3, startSec: 2) != nil else { return }
        deck.send(.play)
        spin(0.3)
        events.removeAll()
        deck.player.pause()
        let hit = waitFor("pausedUncommanded(token: 3)", timeout: 5) {
            if case .pausedUncommanded(3, _) = $0 { return true }
            return false
        }
        if case let .pausedUncommanded(_, atSec)? = hit {
            XCTAssertGreaterThanOrEqual(atSec, 2 - 0.05)
        }

        deck.send(.play)
        spin(0.3)
        events.removeAll()
        deck.send(.pause)
        spin(1.0)
        XCTAssertFalse(
            events.contains { if case .pausedUncommanded = $0 { return true }; return false },
            "a commanded pause was reported as uncommanded: \(events)"
        )
    }

    /// Reaching the end is `.ended`, not an uncommanded pause, even though
    /// `actionAtItemEnd = .pause` drops the rate to 0 there.
    /// TO SEE IT FAIL: remove the end-slack check in `checkUncommandedPause`
    /// or the `didPlayToEndTime` observer.
    func testTheEndIsEndedNotAnUncommandedPause() throws {
        guard loadAndWaitReady(try fixture("click-11k", "wav"), token: 4, startSec: 19.2) != nil else { return }
        deck.send(.play)
        waitFor("ended(token: 4)", timeout: 10) { $0 == .ended(token: 4) }
        spin(0.3)
        XCTAssertFalse(
            events.contains { if case .pausedUncommanded = $0 { return true }; return false },
            "the item's end was reported as an uncommanded pause: \(events)"
        )
    }

    // MARK: - Implicit activation

    /// Plan §4.4: `AVPlayer.play()` activates an inactive session implicitly.
    /// A play while the session owner is not `.active` writes the fault row
    /// and trips the DEBUG fault (injected here so the test process survives).
    /// TO SEE IT FAIL: remove the `sessionIsActive()` check in `play()`.
    func testAPlayWithoutAnActiveSessionWritesTheFaultRow() throws {
        guard loadAndWaitReady(try fixture("click-11k", "wav"), token: 5, startSec: 1) != nil else { return }
        sessionActive = true
        deck.send(.play)
        deck.send(.pause)
        XCTAssertEqual(rows, [])
        XCTAssertEqual(faults, [])

        sessionActive = false
        deck.send(.play)
        XCTAssertEqual(rows, ["fault implicit-activation deck token=5"])
        XCTAssertEqual(faults, ["fault implicit-activation deck token=5"])
    }
}

/// A resource-loader delegate that accepts every request and answers none,
/// so an asset on a custom scheme never loads: a deterministic "never ready"
/// URL with no network.
final class NeverAnsweringLoader: NSObject, AVAssetResourceLoaderDelegate {
    let queue = DispatchQueue(label: "ai.jwlabs.foura.tests.never-answering-loader")
    private let lock = NSLock()
    private var held: [AVAssetResourceLoadingRequest] = []

    var requests: Int {
        lock.lock()
        defer { lock.unlock() }
        return held.count
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        lock.lock()
        held.append(loadingRequest)
        lock.unlock()
        return true
    }
}

/// The card's measurement sink: every line goes to the test log with a
/// greppable prefix and, when ios-kit passes `TEST_RUNNER_GITHUB_STEP_SUMMARY`
/// (xcodebuild strips the prefix before the test process sees it), into the
/// job summary under one heading.
enum DeckMeasurements {
    private static var wroteHeading = false

    static func record(_ line: String) {
        print("AVDECK-MEASURE \(line)")
        guard let path = ProcessInfo.processInfo.environment["GITHUB_STEP_SUMMARY"], !path.isEmpty else { return }
        var text = ""
        if !wroteHeading {
            wroteHeading = true
            text += "\n### AVDeck (NE-15): Simulator measurements\n\n"
        }
        text += "- \(line)\n"
        guard let data = text.data(using: .utf8), let handle = FileHandle(forWritingAtPath: path) else {
            print("AVDECK-MEASURE could not open the job summary at \(path)")
            return
        }
        handle.seekToEndOfFile()
        handle.write(data)
        handle.closeFile()
    }
}

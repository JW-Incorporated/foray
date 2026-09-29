import XCTest
import AVFoundation
import ForayEngineCore
@testable import ForayAudioPlugin

/// AVDeck against a REAL AVPlayer in the iOS Simulator (card NE-15,
/// docs/native-engine-plan.md §14), on two of NE-25a's click tracks in
/// `Fixtures/ClickTracks/` (`tools/audio/make-click-tracks.py` is the
/// recipe, `click-tracks.json` the descriptor):
///
///   - `click-cbr.mp3`: 90 s CBR MP3 with no Xing/LAME header frame, the
///     encoding whose seek table is pure byte arithmetic;
///   - `click.wav`: 60 s PCM, where a seek is exact by construction.
///
/// WHY NOT A SET OF ITS OWN. NE-15 first bundled two 20 s tracks of its own
/// (601 KB). NE-25a landed a set of the same shape first, and the repo's two
/// audio guards exempt exactly one descriptor-named, hash-checked set under
/// 1 MB (`tools/audio/click-tracks.mjs`); a second set would have broken that
/// cap or needed a second exemption. So the deck plays NE-25a's files.
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
    /// The deck's structured `deck` rows (`Config.diag`), as the ring gets them.
    private var diags: [DiagEntry] = []
    private var faults: [String] = []
    private var sessionActive = true
    private var stallingLoader: NeverAnsweringLoader?

    /// The deadline these tests give the deck. NOT the production value
    /// (`AVDeck.defaultLoadDeadlineSec`, pinned by its own test): the first
    /// CI run (35961598950) had a Simulator load that had not even loaded its
    /// duration after 15 s, while every other load was ready in under 1 s. A
    /// behaviour test must not fail because the runner's media stack is
    /// slow; the deadline itself is tested with an asset that never answers.
    private static let testDeadlineSec: Double = 40
    private var testStartedAt = Date()

    /// Warm the Simulator's media stack ONCE, before any deck exists, and
    /// record how long the cold first load took (a measurement, not a check).
    override class func setUp() {
        super.setUp()
        DeckMeasurements.warmUpOnce()
    }

    override func setUp() {
        super.setUp()
        testStartedAt = Date()
        deck = makeDeck()
    }

    override func tearDown() {
        deck?.send(.unload)
        deck = nil
        super.tearDown()
    }

    /// `timers` nil is production's wall clock; a `VirtualDeckTimers` puts
    /// the deck's deadline and pause settle (and the clock its elapsed times
    /// read) under the test's control.
    private func makeDeck(
        deadlineSec: Double = AVDeckTests.testDeadlineSec,
        timers: VirtualDeckTimers? = nil,
        makeAsset: ((URL, Bool) -> AVURLAsset)? = nil,
        idleClockMs: (() -> Double)? = nil
    ) -> AVDeck {
        var config = AVDeck.Config(
            loadDeadlineSec: deadlineSec,
            sessionIsActive: { [unowned self] in self.sessionActive },
            writeRow: { [unowned self] in self.rows.append($0) },
            debugFault: { [unowned self] in self.faults.append($0) },
            makeAsset: makeAsset ?? AVDeck.defaultAsset
        )
        if let timers {
            config.after = { timers.after($0, $1) }
            config.nowMs = { timers.nowMs }
        }
        config.diag = { [unowned self] in self.diags.append($0) }
        if let idleClockMs { config.idleClockMs = idleClockMs }
        let deck = AVDeck(config: config)
        deck.onEvent = { [unowned self] event in
            // Timestamped in the log, so a slow CI load shows WHERE it was slow.
            print("AVDECK-EVENT +\(Int(Date().timeIntervalSince(self.testStartedAt) * 1000)) ms \(event)")
            self.events.append(event)
        }
        return deck
    }

    private func fixture(_ name: String, _ ext: String) throws -> URL {
        try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "ClickTracks"),
            "missing bundled fixture ClickTracks/\(name).\(ext)"
        )
    }

    /// Spins the main run loop (where every deck callback lands) until an
    /// event matches, or fails with the events seen so far.
    @discardableResult
    private func waitFor(
        _ what: String,
        timeout: TimeInterval = 45,
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

    /// Spins the main run loop until `done` holds or `timeout` passes. The
    /// timeout is only how long a starved runner may take: no assertion that
    /// follows depends on it.
    private func spin(until done: () -> Bool, timeout: TimeInterval = 45) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until {
            if done() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        return done()
    }

    /// Waits for the deck's `.timeControl(.playing)` under `token`.
    private func waitPlaying(_ token: DeckToken, file: StaticString = #filePath, line: UInt = #line) {
        waitFor("timeControl(token: \(token), .playing)", file: file, line: line) {
            if case .timeControl(token, .playing, _) = $0 { return true }
            return false
        }
    }

    private func readyEvent(_ token: DeckToken, file: StaticString = #filePath, line: UInt = #line)
        -> (landedSec: Double, prerolled: Bool, elapsedMs: Int)? {
        let hit = waitFor("ready(token: \(token))", file: file, line: line) {
            if case .ready(token, _, _, _) = $0 { return true }
            if case .failed(token, _) = $0 { return true }
            if case .deadlineExceeded(token, _) = $0 { return true }
            return false
        }
        switch hit {
        case let .ready(_, landed, prerolled, elapsed)?:
            return (landed, prerolled, elapsed)
        case let .failed(_, message)?:
            XCTFail("load \(token) failed: \(message)", file: file, line: line)
            return nil
        case let .deadlineExceeded(_, afterMs)?:
            XCTFail("load \(token) hit the deadline after \(afterMs) ms; events: \(events)", file: file, line: line)
            return nil
        default:
            return nil
        }
    }

    private func loadAndWaitReady(
        _ url: URL, token: DeckToken, startSec: Double, precise: Bool = true,
        file: StaticString = #filePath, line: UInt = #line
    ) -> (landedSec: Double, prerolled: Bool, elapsedMs: Int)? {
        deck.send(.loadURL(token: token, url: url, startSec: startSec, preciseTiming: precise))
        return readyEvent(token, file: file, line: line)
    }

    // MARK: - Settings

    /// Plan §4.3's deck settings. TO SEE IT FAIL: drop the `actionAtItemEnd`
    /// or the stall-waiting assignment in `init`. Dropping the
    /// `.timeDomain` line in `load(...)` does NOT fail here (mutation run
    /// 35963951606): the Simulator's default is already `.timeDomain`. The
    /// line stays explicit, and `shell-invariants.test.mjs` pins it, because
    /// that default has changed before and is not documented as fixed.
    func testDeckSettingsAreThePlans() throws {
        XCTAssertEqual(deck.player.actionAtItemEnd, .pause)
        XCTAssertTrue(deck.player.automaticallyWaitsToMinimizeStalling)
        deck.send(.loadURL(token: 1, url: try fixture("click", "wav"), startSec: 0, preciseTiming: true))
        XCTAssertEqual(deck.player.currentItem?.audioTimePitchAlgorithm, .timeDomain)
    }

    // MARK: - Offset landing, and the measurement the card asks for

    /// The zero-tolerance seek lands the start offset, and the preroll is
    /// issued once, AFTER both statuses were `.readyToPlay` and at rate 0 (the
    /// deck writes what it saw into the primitive). The landing error and the
    /// time to ready go into the job summary as MEASUREMENTS.
    /// TO SEE IT FAIL: skip the seek (call `prerollWhenReady` straight from
    /// `advanceIfReady`). A TOLERANT seek does not fail here (mutation run
    /// 35963951606 landed both fixtures on exactly 7.300 s with infinite
    /// tolerance): CBR and PCM seek exactly anyway, and `currentTime` is the
    /// requested time, not the audible one. The zero tolerance is pinned by
    /// `shell-invariants.test.mjs`; the audible landing, on VBR fixtures, is
    /// NE-25a's measurement.
    func testOffsetLandsOnTheCbrMp3AndTheWav() throws {
        let start = 7.3
        let cases: [(name: String, ext: String, precise: Bool, label: String)] = [
            ("click-cbr", "mp3", true, "CBR MP3, precise"),
            ("click-cbr", "mp3", false, "CBR MP3, approximate"),
            ("click", "wav", true, "WAV, precise")
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
        deck.send(.loadURL(token: 1, url: try fixture("click", "wav"), startSec: 2, preciseTiming: true))
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
        deck.send(.loadURL(token: 1, url: try fixture("click-cbr", "mp3"), startSec: 3, preciseTiming: true))
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
        guard loadAndWaitReady(try fixture("click", "wav"), token: 1, startSec: 0) != nil else { return }
        deck.send(.play)
        XCTAssertEqual(deck.player.rate, 1)
        deck.send(.loadURL(token: 2, url: try fixture("click-cbr", "mp3"), startSec: 4, preciseTiming: true))
        XCTAssertEqual(deck.player.rate, 0, "the next item attached to a playing player")
        guard readyEvent(2) != nil else { return }
        XCTAssertEqual(deck.player.rate, 0)
    }

    /// A superseded load reports nothing after it is superseded. Two
    /// defences stand in the way: `load(...)` detaches (and cancels) the old
    /// asset, and every callback carries the generation it was issued under.
    /// A late callback would be reported under the CURRENT token, so the test
    /// counts events rather than trusting their tokens: exactly one duration
    /// and one ready, both the second load's.
    /// TO SEE IT FAIL: drop BOTH the `detachItem()` in `load(...)` and the
    /// `gen == generation` guard in `durationLoaded` (either one alone still
    /// holds; that is what having two is for).
    func testASupersededLoadIsSilent() throws {
        deck.send(.loadURL(token: 1, url: try fixture("click-cbr", "mp3"), startSec: 5, preciseTiming: true))
        deck.send(.loadURL(token: 2, url: try fixture("click", "wav"), startSec: 6, preciseTiming: true))
        guard let ready = readyEvent(2) else { return }
        XCTAssertEqual(ready.landedSec, 6, accuracy: 0.1)
        spin(1.0)
        let durations = events.filter { if case .durationLoaded = $0 { return true }; return false }
        let readies = events.filter { if case .ready = $0 { return true }; return false }
        XCTAssertEqual(durations.count, 1, "the superseded load still reported its duration: \(events)")
        XCTAssertEqual(readies.count, 1, "the superseded load still reported ready: \(events)")
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

    // MARK: - Same source is a seek

    /// `DeckPolicy.sameSourceIsSeek` (plan §4.4: the in-place resume costs no
    /// network round trip). The core resumes a paused item with a fresh
    /// `.load` of the URL the deck holds; the deck keeps the ITEM (and its
    /// buffer), runs the same gate under the new token (the zero-tolerance
    /// seek, then the preroll), and reports `.ready` for it with no new
    /// duration load. A different URL, or a different timing option, is a
    /// cold load again. The 2026-09-28 paste is why: every play after a pause
    /// refetched a 2 h 20 m file from scratch, and the second one missed the
    /// 20 s deadline. TO SEE IT FAIL: drop the `coldReason` branch at the
    /// top of `load(...)`.
    func testASameSourceLoadKeepsTheItemAndRunsTheGate() throws {
        let url = try fixture("click-cbr", "mp3")
        guard loadAndWaitReady(url, token: 1, startSec: 3) != nil else { return }
        let item = try XCTUnwrap(deck.player.currentItem)
        deck.send(.play)
        deck.send(.pause)
        events.removeAll()
        diags.removeAll()

        guard let ready = loadAndWaitReady(url, token: 2, startSec: 10) else { return }
        XCTAssertTrue(deck.player.currentItem === item, "a same-source load made a new item")
        XCTAssertEqual(ready.landedSec, 10, accuracy: 0.1)
        XCTAssertEqual(deck.player.rate, 0, "a reused item must still be silent until play")
        XCTAssertFalse(events.contains { if case .durationLoaded = $0 { return true }; return false },
                       "a reused item loaded its duration again: \(events)")
        let reuse = try XCTUnwrap(deck.primitives.lastIndex(of: "reuse"), "\(deck.primitives)")
        let ops = Array(deck.primitives[reuse...])
        XCTAssertFalse(ops.contains("attach"), "\(ops)")
        let seek = ops.firstIndex(of: "seek 10.000")
        let preroll = ops.firstIndex { $0.hasPrefix("preroll") }
        XCTAssertNotNil(seek, "the reused load skipped the gate seek: \(ops)")
        if let seek, let preroll { XCTAssertLessThan(seek, preroll, "the preroll must follow the seek") }
        deck.send(.play)
        XCTAssertEqual(deck.player.rate, 1)

        // The rows say which it was, and pass the gate whole.
        let deckRows = diags.filter { $0.kind == "deck" }
        XCTAssertTrue(deckRows.contains { $0[field: "kind"] == .string("reuse") && $0[field: "token"] == .number(2) },
                      "\(deckRows)")
        XCTAssertTrue(deckRows.contains { $0[field: "kind"] == .string("ready") && $0[field: "reuse"] == .bool(true) },
                      "\(deckRows)")
        for row in deckRows {
            XCTAssertNil(DiagGate.admit(row)?[field: DiagGate.droppedField], "the gate dropped part of \(row)")
        }

        // Another timing option is another asset: a cold load.
        deck.send(.loadURL(token: 3, url: url, startSec: 0, preciseTiming: false))
        XCTAssertFalse(deck.player.currentItem === item, "a different timing option reused the item")
        guard readyEvent(3) != nil else { return }
        let cold = try XCTUnwrap(deck.player.currentItem)
        // And a different URL is one too.
        deck.send(.loadURL(token: 4, url: try fixture("click", "wav"), startSec: 0, preciseTiming: false))
        XCTAssertFalse(deck.player.currentItem === cold, "a different URL reused the item")
        guard readyEvent(4) != nil else { return }
        let colds = diags.filter { $0.kind == "deck" && $0[field: "kind"] == .string("attach") }
            .map { $0[field: "cold"] }
        XCTAssertEqual(colds, [.string("timing"), .string("other-source")], "\(diags)")
    }

    /// A held item idle past `reuseMaxIdleSec` is NOT reused: the load is
    /// cold, as every load was before same-source reuse. The milestone-1 car
    /// test passed on a cold resume after a day parked; an item that old may
    /// sit at `.readyToPlay` over a dead connection or an expired signed
    /// redirect, and fail mid-drive. TO SEE IT FAIL: drop the `stale` guard
    /// in `coldReason`.
    func testASameSourceLoadAfterALongIdleIsCold() throws {
        var clockMs: Double = 0
        deck.send(.unload)
        deck = makeDeck(idleClockMs: { clockMs })
        let url = try fixture("click-cbr", "mp3")
        guard loadAndWaitReady(url, token: 1, startSec: 3) != nil else { return }
        let item = try XCTUnwrap(deck.player.currentItem)
        deck.send(.play)
        deck.send(.pause)
        // Let every observation of that play and pause land first: each one
        // is "live" at the clock's current reading.
        spin(0.5)
        clockMs += (AVDeck.defaultReuseMaxIdleSec + 1) * 1000
        diags.removeAll()

        deck.send(.loadURL(token: 2, url: url, startSec: 10, preciseTiming: true))
        XCTAssertFalse(deck.player.currentItem === item, "an item idle past the bound was reused")
        let attach = try XCTUnwrap(diags.last { $0.kind == "deck" && $0[field: "kind"] == .string("attach") },
                                   "no attach row: \(diags)")
        XCTAssertEqual(attach[field: "cold"], .string("stale"))
        XCTAssertEqual(attach[field: "idleSec"], .number(AVDeck.defaultReuseMaxIdleSec + 1))
        XCTAssertNil(DiagGate.admit(attach)?[field: DiagGate.droppedField], "the gate dropped part of \(attach)")
        guard let ready = readyEvent(2) else { return }
        XCTAssertEqual(ready.landedSec, 10, accuracy: 0.1)
    }

    // MARK: - Rate

    /// The listener's rate is held by the deck and re-applied on every play,
    /// across three loads (alternating encodings).
    /// TO SEE IT FAIL: apply `rate` only in `setRate` (not in
    /// `applyRateAndPlay`), or reset it in `load(...)`.
    func testRateIsHeldAcrossThreeLoads() throws {
        deck.send(.setRate(1.5))
        let files = [("click-cbr", "mp3"), ("click", "wav"), ("click-cbr", "mp3")]
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
    ///
    /// WHY THE DEADLINE RUNS IN VIRTUAL TIME (ci.yml runs 36095220051,
    /// 36176478568, 36283086977: "the stalling loader was never asked", a
    /// 10 s wait for the deadline that ran out, an item still attached). The test
    /// used to give the deck a REAL 1 s deadline. On a loaded Simulator
    /// AVFoundation had not yet asked the resource loader for a byte when that
    /// second was up, so the deadline detached the item and cancelled the
    /// asset first and the loader was never asked; on a starved main queue
    /// the deadline itself fired late. Two clocks raced the one event the
    /// test is about. Now the deck's timers are `VirtualDeckTimers`: the test
    /// waits (as long as the runner needs) for the loader to be asked, THEN
    /// lets the deadline's time pass. The deadline is the PRODUCTION 20 s
    /// (`AVDeck.defaultLoadDeadlineSec`), not a test value, and it must not
    /// fire a millisecond early.
    func testANeverReadyUrlHitsTheDeadlineWithNoPreroll() throws {
        let loader = NeverAnsweringLoader()
        stallingLoader = loader
        let timers = VirtualDeckTimers()
        deck.send(.unload)
        deck = makeDeck(deadlineSec: AVDeck.defaultLoadDeadlineSec, timers: timers) { url, precise in
            let asset = AVDeck.defaultAsset(url, precise)
            asset.resourceLoader.setDelegate(loader, queue: loader.queue)
            return asset
        }
        let never = try XCTUnwrap(URL(string: "foray-never://deck.test/never.mp3"))
        deck.send(.loadURL(token: 7, url: never, startSec: 12, preciseTiming: true))
        XCTAssertEqual(timers.pending.map { $0.sec }, [AVDeck.defaultLoadDeadlineSec], "one deadline, the production 20 s")

        // The event the test is about: AVFoundation asks the loader, which
        // never answers. Nothing may settle the load meanwhile.
        XCTAssertTrue(spin(until: { loader.requests > 0 }), "the stalling loader was never asked; the test proved nothing")
        let settled: (DeckEvent) -> Bool = {
            switch $0 {
            case .ready, .failed, .deadlineExceeded: return true
            default: return false
            }
        }
        XCTAssertFalse(events.contains(where: settled), "the never-answering load settled by itself: \(events)")

        let deadlineMs = AVDeck.defaultLoadDeadlineSec * 1000
        timers.advance(ms: deadlineMs - 1)
        XCTAssertFalse(events.contains(where: settled), "the deadline fired early: \(events)")
        timers.advance(ms: 1)
        let hit = events.first {
            if case .deadlineExceeded(7, _) = $0 { return true }
            return false
        }
        guard case let .deadlineExceeded(_, afterMs)? = hit else {
            return XCTFail("no deadlineExceeded(token: 7) at the deadline; events: \(events)")
        }
        XCTAssertEqual(afterMs, Int(deadlineMs))
        // The row says WHERE it was stuck: the duration never loaded.
        let row = try XCTUnwrap(diags.last { $0.kind == "deck" && $0[field: "kind"] == .string("deadline") },
                                "no deck kind=deadline row: \(diags)")
        XCTAssertEqual(row[field: "token"], .number(7))
        XCTAssertEqual(row[field: "step"], .string("duration"))
        XCTAssertEqual(row[field: "durationKnown"], .bool(false))
        XCTAssertEqual(row[field: "afterMs"], .number(deadlineMs))
        XCTAssertEqual(row[field: "class"], .string("clip"), "a load with no class is a clip's (NE-38)")
        XCTAssertNil(DiagGate.admit(row)?[field: DiagGate.droppedField], "the gate dropped part of \(row)")
        XCTAssertFalse(deck.primitives.contains { $0.hasPrefix("preroll") }, "\(deck.primitives)")
        XCTAssertFalse(events.contains { if case .ready = $0 { return true }; return false })
        XCTAssertNil(deck.player.currentItem, "the deadline must detach the item")
        events.removeAll()
        deck.send(.play)
        XCTAssertEqual(events, [.refused(command: "play", reason: "failed")])
        XCTAssertEqual(deck.player.rate, 0)
    }

    /// The provisional field values (card NE-38; measurements §12): P-13 is
    /// 20 s for a clip and 8 s for a rendered line, and a held item is reused
    /// for up to 600 s idle. A change to any of them is NE-38f's, from the
    /// field's rows, and moves this pin and the measurements table together.
    func testTheProvisionalDeadlinesAreTwentySecondsForAClipAndEightForALine() {
        XCTAssertEqual(AVDeck.defaultLoadDeadlineSec, 20)
        XCTAssertEqual(AVDeck.defaultLineLoadDeadlineSec, 8)
        XCTAssertEqual(AVDeck.defaultReuseMaxIdleSec, 600)
        let config = AVDeck.Config(sessionIsActive: { true })
        XCTAssertEqual(config.deadlineSec(for: .clip), 20)
        XCTAssertEqual(config.deadlineSec(for: .line), 8)
    }

    /// NE-38: a RENDERED LINE whose file never answers gives up at the line's
    /// 8 s, not a clip's 20 s, and the `deadline` row says `class=line` (the
    /// row NE-38e's `P13-line` verdict reads). The core then reads the line
    /// aloud on a fresh token (ForayCatchUpTests
    /// `testARenderedLinesDeadlineFallsBackToSpeechOnAFreshToken`). Virtual
    /// time, for the reason `testANeverReadyUrlHitsTheDeadlineWithNoPreroll`
    /// gives. TO SEE IT FAIL: arm `config.loadDeadlineSec` for every class in
    /// `armDeadline`, or drop `classField` from the deadline row.
    func testARenderedLineThatNeverLoadsHitsTheLineDeadlineAtEightSeconds() throws {
        let loader = NeverAnsweringLoader()
        stallingLoader = loader
        let timers = VirtualDeckTimers()
        deck.send(.unload)
        deck = makeDeck(deadlineSec: AVDeck.defaultLoadDeadlineSec, timers: timers) { url, precise in
            let asset = AVDeck.defaultAsset(url, precise)
            asset.resourceLoader.setDelegate(loader, queue: loader.queue)
            return asset
        }
        let never = try XCTUnwrap(URL(string: "foray-never://deck.test/line.mp3"))
        deck.send(.load(token: 9, itemId: "f1#0", url: never.absoluteString, startSec: 0, preciseTiming: false,
                        deadlineClass: .line))
        XCTAssertEqual(timers.pending.map { $0.sec }, [AVDeck.defaultLineLoadDeadlineSec], "one deadline, the line's 8 s")
        let attach = try XCTUnwrap(diags.last { $0.kind == "deck" && $0[field: "kind"] == .string("attach") },
                                   "no attach row: \(diags)")
        XCTAssertEqual(attach[field: "class"], .string("line"))

        XCTAssertTrue(spin(until: { loader.requests > 0 }), "the stalling loader was never asked; the test proved nothing")
        let settled: (DeckEvent) -> Bool = {
            switch $0 {
            case .ready, .failed, .deadlineExceeded: return true
            default: return false
            }
        }
        XCTAssertFalse(events.contains(where: settled), "the never-answering load settled by itself: \(events)")
        let deadlineMs = AVDeck.defaultLineLoadDeadlineSec * 1000
        timers.advance(ms: deadlineMs - 1)
        XCTAssertFalse(events.contains(where: settled), "the line's deadline fired early: \(events)")
        timers.advance(ms: 1)
        let hit = events.first {
            if case .deadlineExceeded(9, _) = $0 { return true }
            return false
        }
        guard case let .deadlineExceeded(_, afterMs)? = hit else {
            return XCTFail("no deadlineExceeded(token: 9) at 8 s; events: \(events)")
        }
        XCTAssertEqual(afterMs, Int(deadlineMs))
        let row = try XCTUnwrap(diags.last { $0.kind == "deck" && $0[field: "kind"] == .string("deadline") },
                                "no deck kind=deadline row: \(diags)")
        XCTAssertEqual(row[field: "class"], .string("line"))
        XCTAssertEqual(row[field: "afterMs"], .number(deadlineMs))
        XCTAssertNil(DiagGate.admit(row)?[field: DiagGate.droppedField], "the gate dropped part of \(row)")
        XCTAssertNil(deck.player.currentItem, "the deadline must detach the item")
    }

    /// NE-38: NO BEHAVIOUR CHANGES FOR A CLIP. A clip load that lands 19 s
    /// after it started (virtual time: the clock is moved to 19 s before the
    /// real load can land) is ready, not timed out, and its deadline is gone
    /// once it is: time well past 20 s then fires nothing. The `ready` row
    /// carries `class=clip` and the elapsed 19 s (NE-38e's `P13-clip`).
    /// TO SEE IT FAIL: arm the line's deadline for every load, or keep the
    /// deadline armed past `.ready`.
    func testAClipLoadThatLandsAtNineteenSecondsDoesNotTimeOut() throws {
        let timers = VirtualDeckTimers()
        deck.send(.unload)
        deck = makeDeck(deadlineSec: AVDeck.defaultLoadDeadlineSec, timers: timers)
        deck.send(.loadURL(token: 5, url: try fixture("click-cbr", "mp3"), startSec: 3, preciseTiming: true))
        XCTAssertEqual(timers.pending.map { $0.sec }, [AVDeck.defaultLoadDeadlineSec], "one deadline, the clip's 20 s")
        // Every deck callback hops to main, so nothing has landed yet: the
        // load is still in flight when 19 s pass.
        timers.advance(ms: 19_000)
        XCTAssertFalse(events.contains { if case .deadlineExceeded = $0 { return true }; return false },
                       "a clip timed out before 20 s: \(events)")
        guard let ready = readyEvent(5) else { return }
        XCTAssertGreaterThanOrEqual(ready.elapsedMs, 19_000, "the load landed after the 19 s passed")
        timers.advance(ms: 60_000)
        XCTAssertFalse(events.contains { if case .deadlineExceeded = $0 { return true }; return false },
                       "a deadline fired after the clip was ready: \(events)")
        XCTAssertTrue(timers.pending.isEmpty, "the deadline outlived the ready: \(timers.pending.map { $0.sec })")
        let row = try XCTUnwrap(diags.last { $0.kind == "deck" && $0[field: "kind"] == .string("ready") },
                                "no deck kind=ready row: \(diags)")
        XCTAssertEqual(row[field: "class"], .string("clip"))
        XCTAssertEqual(row[field: "elapsedMs"], .number(Double(ready.elapsedMs)))
        XCTAssertNil(DiagGate.admit(row)?[field: DiagGate.droppedField], "the gate dropped part of \(row)")
    }

    // MARK: - Observation

    /// A pause the deck did not command (the system's, stood in for by
    /// pausing the real player behind the deck's back) becomes ONE reconcile
    /// input; the play that follows it produces none, so a SECOND external
    /// pause is still reported; and a commanded pause never is.
    /// The false report after a re-play (run 35962750658) is a platform race
    /// this test cannot force: with the settle removed it went red in one run
    /// and stayed green in another (35965798877). The deterministic guard for
    /// the settle is `testAPlayInsideTheSettleWindowVoidsTheStop`.
    /// TO SEE IT FAIL: make `checkUncommandedPause` return at once, or drop
    /// the `intendsToPlay = false` in `pause()`.
    ///
    /// ITS WAITS ARE FOR THE EVENTS, NOT A BUDGET (ci.yml runs 36017393292,
    /// 36087898470, 36194671575 and 8 more; 6 passed on a re-run). The report
    /// comes `pauseSettleSec` (0.25 s) after the stop, and the test waited
    /// 5 s for it. The failing logs show the Simulator's main queue stalled
    /// far longer than that: the `.paused` observation of the external pause
    /// landed about 5 s, 13 s and 25 s after it (AVDECK-EVENT lines), so the
    /// report was still on its way when the wait gave up. Nothing here
    /// measures the settle (`testAPlayInsideTheSettleWindowVoidsTheStop` pins
    /// it, in virtual time), so the waits take the file's generous default,
    /// and the external pause waits for `.playing` instead of assuming 0.3 s
    /// of wall clock is enough for playback to start.
    func testAnExternalPauseBecomesAReconcileInput() throws {
        let uncommanded: (DeckEvent) -> Bool = { if case .pausedUncommanded = $0 { return true }; return false }
        guard loadAndWaitReady(try fixture("click-cbr", "mp3"), token: 3, startSec: 2) != nil else { return }
        deck.send(.play)
        waitPlaying(3)
        events.removeAll()
        deck.player.pause()
        let hit = waitFor("pausedUncommanded(token: 3)") {
            if case .pausedUncommanded(3, _) = $0 { return true }
            return false
        }
        if case let .pausedUncommanded(_, atSec)? = hit {
            XCTAssertGreaterThanOrEqual(atSec, 2 - 0.05)
        }

        // Re-play at once, as the core does after attributing the stop.
        events.removeAll()
        deck.send(.play)
        spin(1.0)
        XCTAssertFalse(events.contains(where: uncommanded), "the play after an external pause was reported as a stop: \(events)")

        // The deck still intends to play, so a second system pause is seen.
        events.removeAll()
        deck.player.pause()
        waitFor("a second pausedUncommanded(token: 3)") {
            if case .pausedUncommanded(3, _) = $0 { return true }
            return false
        }

        deck.send(.play)
        spin(1.0)
        events.removeAll()
        deck.send(.pause)
        spin(1.0)
        XCTAssertFalse(events.contains(where: uncommanded), "a commanded pause was reported as uncommanded: \(events)")
    }

    /// A system stop followed by a play inside `pauseSettleSec` is never
    /// reported: the play voids the suspicion. This is the deterministic half
    /// of the settle (the false report after a re-play is a race; see above).
    /// TO SEE IT FAIL: report at once in `checkUncommandedPause` (call
    /// `work.perform()` instead of scheduling it), or drop the cancel in
    /// `play()`.
    ///
    /// WHY THE SETTLE RUNS IN VIRTUAL TIME (ci.yml runs 36075659511,
    /// 36115931616, 36142783758: the stop was reported before the play). The
    /// test used to spin 0.1 s of wall clock, trusting that the KVO hop had
    /// landed and that the 0.25 s settle had NOT elapsed, then send the play.
    /// On a loaded runner the spin overran the settle, so the play came after
    /// the settle had already confirmed the stop: the test raced its own
    /// clock, not the deck. Now the deck's timers are `VirtualDeckTimers`:
    /// the test waits for the suspicion to be ARMED (at the production
    /// `pauseSettleSec`), plays while its time has provably not passed, and
    /// only then lets the settle run.
    func testAPlayInsideTheSettleWindowVoidsTheStop() throws {
        let timers = VirtualDeckTimers()
        deck.send(.unload)
        deck = makeDeck(timers: timers)
        guard loadAndWaitReady(try fixture("click-cbr", "mp3"), token: 6, startSec: 3) != nil else { return }
        deck.send(.play)
        waitPlaying(6)
        events.removeAll()
        deck.player.pause()
        let armed = spin(until: { timers.pending.contains { $0.sec == AVDeck.pauseSettleSec } })
        XCTAssertTrue(armed, "the external pause never armed a settle; events: \(events)")
        let suspicion = timers.pending.first { $0.sec == AVDeck.pauseSettleSec }
        deck.send(.play)
        XCTAssertEqual(suspicion?.work.isCancelled, true, "the play inside the settle window must void the suspicion")
        // Its 0.25 s pass. Only THIS suspicion runs: a transient observation
        // after the play may arm another one, whose own settle is the
        // platform race the external-pause test describes, not this rule.
        if let suspicion { timers.run(suspicion) }
        XCTAssertFalse(
            events.contains { if case .pausedUncommanded = $0 { return true }; return false },
            "a stop superseded by a play inside the settle window was reported: \(events)"
        )
        XCTAssertEqual(deck.player.rate, 1)
    }

    /// The uncommanded-pause rule, branch by branch, as a pure function
    /// (which order the end's signals arrive in varies by run, so the
    /// Simulator test below cannot pin these).
    /// TO SEE IT FAIL: drop any guard in `isUncommandedPause`, or the
    /// end-slack check.
    func testTheUncommandedPauseRule() {
        func rule(
            intends: Bool = true, ended: Bool = false, ready: Bool = true,
            rate: Float = 0, paused: Bool = true, at: Double = 5, duration: Double? = 20
        ) -> Bool {
            AVDeck.isUncommandedPause(
                intendsToPlay: intends, reachedEnd: ended, ready: ready,
                rate: rate, timeControlPaused: paused, atSec: at, durationSec: duration
            )
        }
        XCTAssertTrue(rule(), "a stop mid-item while intending to play is uncommanded")
        XCTAssertTrue(rule(duration: nil), "an unbounded item has no end to excuse the stop")
        XCTAssertFalse(rule(intends: false), "a commanded pause")
        XCTAssertFalse(rule(ended: true), "the item already ended")
        XCTAssertFalse(rule(ready: false), "a load in progress")
        XCTAssertFalse(rule(rate: 1), "still playing")
        XCTAssertFalse(rule(paused: false), "waiting (buffering) is not a stop")
        XCTAssertFalse(rule(at: 19.6), "inside the end slack: the end, not a stop")
        XCTAssertTrue(rule(at: 19.4), "just outside the end slack")
    }

    /// Reaching the end is `.ended`, not an uncommanded pause, even though
    /// `actionAtItemEnd = .pause` drops the rate to 0 there.
    /// TO SEE IT FAIL: remove the end-slack check alone (killed in mutation
    /// run 35963951987, before the rule required `.paused`). With both the
    /// slack and the `reachedEnd` guard removed it stayed green in run
    /// 35965798877, because there `.paused` arrived after `didPlayToEndTime`;
    /// `testTheUncommandedPauseRule` pins those branches deterministically.
    func testTheEndIsEndedNotAnUncommandedPause() throws {
        // 0.8 s before the WAV's end, read from the descriptor rather than
        // restated, so a regenerated fixture cannot strand the start past it.
        let wav = try XCTUnwrap(ClickTrackDescriptor.load().fixtures.first { $0.file == "click.wav" })
        guard loadAndWaitReady(try fixture("click", "wav"), token: 4, startSec: wav.durationSec - 0.8) != nil else { return }
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
        guard loadAndWaitReady(try fixture("click", "wav"), token: 5, startSec: 1) != nil else { return }
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

    // MARK: - The core's vocabulary (NE-15h)

    /// The core hands the page's `audio_url` through as a string, nil for an
    /// item with no audio. Nil, empty, or anything that is not an absolute URL
    /// fails THAT load at once, under its token, with nothing attached.
    /// TO SEE IT FAIL: drop the `url.scheme != nil` check (a relative path
    /// then attaches and fails later, asynchronously, with another message).
    func testALoadWithNoUsableUrlFailsThatLoad() {
        for (token, url) in [(21, nil), (22, ""), (23, "episode.mp3")] as [(Int, String?)] {
            events.removeAll()
            deck.send(.load(token: token, itemId: "x", url: url, startSec: 0, preciseTiming: false))
            XCTAssertEqual(events, [.failed(token: token, message: "no-url")], "url \(String(describing: url))")
            XCTAssertNil(deck.player.currentItem)
            XCTAssertEqual(deck.reading, .idle)
        }
    }

    /// The host reads the deck before every input. Idle reads nothing; a load
    /// still gating reads the START it will land on (never the 0 of a fresh
    /// item); a ready deck reads its playhead, silent until played.
    /// TO SEE IT FAIL: read `currentTime()` while `.loading`/`.gating`, or
    /// report `audible` from `intendsToPlay` instead of the player's rate.
    func testTheReadingFollowsTheLoadAndThePlay() throws {
        XCTAssertNil(deck.reading.positionSec)
        deck.send(.loadURL(token: 1, url: try fixture("click", "wav"), startSec: 9, preciseTiming: true))
        XCTAssertEqual(deck.reading.positionSec, 9, "a gating load reads its start")
        XCTAssertFalse(deck.reading.audible)
        guard readyEvent(1) != nil else { return }
        let ready = deck.reading
        XCTAssertEqual(try XCTUnwrap(ready.positionSec), 9, accuracy: 0.1)
        XCTAssertFalse(ready.audible)
        XCTAssertFalse(ready.ended)
        XCTAssertNotNil(ready.durationSec)
        deck.send(.play)
        XCTAssertTrue(deck.reading.audible)
        deck.send(.pause)
        XCTAssertFalse(deck.reading.audible)
    }

    /// The out-point's first layer: the item's `forwardPlaybackEndTime`, and
    /// nil disarms it.
    /// TO SEE IT FAIL: ignore `.setOutPoint`.
    func testSetOutPointSetsTheItemsForwardEndTime() throws {
        guard loadAndWaitReady(try fixture("click", "wav"), token: 1, startSec: 0) != nil else { return }
        let item = try XCTUnwrap(deck.player.currentItem)
        deck.send(.setOutPoint(sec: 10))
        XCTAssertEqual(item.forwardPlaybackEndTime.seconds, 10, accuracy: 0.001)
        deck.send(.setOutPoint(sec: nil))
        XCTAssertFalse(item.forwardPlaybackEndTime.isValid)
    }

    /// Teardown's deck half: silent, detached, no player KVO, no events, and
    /// every later command ignored.
    /// TO SEE IT FAIL: leave the player observations registered in
    /// `invalidate()`, or let `send` run after it.
    func testInvalidateSilencesDetachesAndStopsReporting() throws {
        guard loadAndWaitReady(try fixture("click", "wav"), token: 1, startSec: 0) != nil else { return }
        deck.send(.play)
        XCTAssertTrue(deck.isObservingPlayer)
        deck.invalidate()
        XCTAssertEqual(deck.player.rate, 0)
        XCTAssertNil(deck.player.currentItem)
        XCTAssertFalse(deck.isObservingPlayer)
        XCTAssertNil(deck.onEvent)
        deck.send(.loadURL(token: 2, url: try fixture("click", "wav"), startSec: 0, preciseTiming: true))
        XCTAssertNil(deck.player.currentItem, "a command after invalidate ran")
    }
}

/// AVDeck's timers and clock in virtual time (`Config.after`, `Config.nowMs`).
/// Every timer the deck arms is held with the delay it asked for; it runs
/// only when the test lets that much time pass (`advance`) or runs it by
/// hand (`run`), and never once the deck cancelled it. The clock moves only
/// with `advance`, so an elapsed time the deck reports is exactly the
/// virtual time that passed. Main-confined, like the deck.
final class VirtualDeckTimers {
    struct Armed {
        let sec: Double
        let dueMs: Double
        let work: DispatchWorkItem
    }

    private(set) var nowMs: Double = 0
    private var armed: [Armed] = []

    func after(_ sec: Double, _ work: DispatchWorkItem) {
        armed.append(Armed(sec: sec, dueMs: nowMs + sec * 1000, work: work))
    }

    /// Armed, not yet run, and not cancelled.
    var pending: [Armed] { armed.filter { !$0.work.isCancelled } }

    /// Let `ms` pass: every timer that falls due runs, in due order.
    func advance(ms: Double) {
        nowMs += ms
        while let next = pending.filter({ $0.dueMs <= nowMs }).min(by: { $0.dueMs < $1.dueMs }) {
            run(next)
        }
    }

    /// Run one armed timer now (a no-op when the deck cancelled it).
    func run(_ timer: Armed) {
        armed.removeAll { $0.work === timer.work }
        if !timer.work.isCancelled { timer.work.perform() }
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
/// greppable prefix and, when ios-kit passes `TEST_RUNNER_FORAY_MEASURE_SUMMARY`
/// (xcodebuild strips the prefix before the test process sees it), into the
/// job summary under one heading. It is the variable NE-25a's
/// `MeasurementReport` writes through: ci.yml has one hand-off, not two.
enum DeckMeasurements {
    private static var wroteHeading = false
    private static var warmed = false

    /// One cold AVPlayerItem load on the WAV, waited for up to 60 s.
    static func warmUpOnce() {
        guard !warmed else { return }
        warmed = true
        guard let url = Bundle.module.url(forResource: "click", withExtension: "wav", subdirectory: "ClickTracks") else { return }
        let started = Date()
        let player = AVPlayer(playerItem: AVPlayerItem(url: url))
        let until = started.addingTimeInterval(60)
        while Date() < until, let item = player.currentItem, item.status == .unknown {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        let status = player.currentItem?.status == .readyToPlay ? "readyToPlay" : "NOT ready"
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        record("cold start (warm-up, before any AVDeck test): the run's first AVPlayerItem was \(status) after \(ms) ms")
        player.replaceCurrentItem(with: nil)
    }

    static func record(_ line: String) {
        print("AVDECK-MEASURE \(line)")
        guard let path = ProcessInfo.processInfo.environment["FORAY_MEASURE_SUMMARY"], !path.isEmpty else { return }
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

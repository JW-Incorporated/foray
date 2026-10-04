import XCTest
import ForayEngineCore

/// §16 of queue-manager.js, the engine's half (`EngineCore.retryOrSkipClip`):
/// A FORAY CLIP THAT WILL NOT LOAD RETRIES, THEN MOVES ON.
///
/// The M2 car drive, 2026-10-01: the third clip's load passed its 20 s P-13
/// deadline, `onLoadFailure` wrote `stop cause=load-deadline` and went idle,
/// and the Foray sat silent with the clip on the lock screen. Every press of
/// play then loaded the clip again from nothing. The parity half is the
/// `manager-foray/clip-load` fixtures (the same rules over the JS manager);
/// these pin what no op log shows: the rows, the `skipped` event, the token,
/// and that the retry asks the deck for exactly the same load (the source,
/// the in-point, the timing and the class), which is what lets AVDeck keep
/// the first attempt's work (`AVDeckTests` pins the deck's half).
///
/// Each test names the one-line mutation that turns it red.
final class ClipLoadRetryTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static let threeClips = [ForayTapeTests.clip(0, "a", 100, 200), ForayTapeTests.clip(1, "b", 300, 400),
                             ForayTapeTests.clip(2, "c", 500, 600)]

    /// A Foray of three clips playing its first, then the first clip's end:
    /// the seam's load of clip 2 (`f1#1@300`) is in flight.
    static func inSeam() throws -> Host {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(threeClips)))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        host.reading.audible = false
        host.reading.ended = true
        let seam = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(seam), ["f1#1@300"], "the seam loads clip 2: \(seam)")
        return host
    }

    static func deckLoads(_ out: [EngineCommand]) -> [DeckCommand] {
        out.compactMap { if case let .deck(command) = $0, case .load = command { return command }; return nil }
    }

    static func rows(_ out: [EngineCommand], kind: String, event: String) -> [DiagEntry] {
        out.compactMap {
            if case let .diag(entry) = $0, entry.kind == kind, entry[field: "kind"] == .string(event) { return entry }
            return nil
        }
    }

    static func hasStopRow(_ out: [EngineCommand]) -> Bool {
        out.contains { if case let .diag(entry) = $0 { return entry.kind == "stop" }; return false }
    }

    static func hasError(_ out: [EngineCommand]) -> Bool {
        out.contains { if case .emit(.error) = $0 { return true }; return false }
    }

    /// DEADLINE, THEN A RETRY THAT KEEPS THE CLIP, THEN SOUND. The first
    /// deadline is not a stop: the same clip is asked for again, on a fresh
    /// token, with the same source, in-point, precise timing and class (so
    /// AVDeck can continue the load it already has), and a `deck kind=retry`
    /// row says so. When that load lands the clip plays.
    /// TO SEE IT FAIL: compare `pending.attempt` against 1 instead of
    /// `forayClipLoadAttempts` in `retryOrSkipClip` (the clip is stepped over
    /// on its first deadline).
    func testAClipWhoseLoadPassesItsDeadlineIsRetriedOnTheSameLoadAndPlays() throws {
        var host = try ClipLoadRetryTests.inSeam()
        let first = try XCTUnwrap(host.lastLoad)
        let retry = host.send(.deck(.deadlineExceeded(token: first, afterMs: 20_000)), after: 20_000)
        XCTAssertFalse(ClipLoadRetryTests.hasStopRow(retry), "the first deadline is not a stop: \(retry)")
        XCTAssertFalse(ClipLoadRetryTests.hasError(retry), "\(retry)")
        let loads = ClipLoadRetryTests.deckLoads(retry)
        guard loads.count == 1, case let .load(token, itemId, url, startSec, precise, deadlineClass) = loads[0] else {
            return XCTFail("one retry load, got \(retry)")
        }
        XCTAssertNotEqual(token, first, "a fresh token, so a late report about the first is stale")
        XCTAssertEqual(itemId, "f1#1")
        XCTAssertEqual(url, "https://cdn.test/b.mp3")
        XCTAssertEqual(startSec, 300)
        XCTAssertTrue(precise)
        XCTAssertEqual(deadlineClass, .clip)
        XCTAssertEqual(host.core.state.stateType, "loadingItem")
        let row = try XCTUnwrap(ClipLoadRetryTests.rows(retry, kind: "deck", event: "retry").first, "\(retry)")
        let admitted = try XCTUnwrap(DiagGate.admit(row))
        XCTAssertNil(admitted[field: DiagGate.droppedField], "the ring keeps the whole row: \(admitted)")
        XCTAssertEqual(admitted[field: "attempt"], .number(2))
        XCTAssertEqual(admitted[field: "why"], .string("load-deadline"))
        // The queue index, not the id: `f1#1` is not a token, and the gate
        // withheld it (`dropped: ["item"]`) the first time this ran in CI.
        XCTAssertEqual(admitted[field: "index"], .number(1))

        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertEqual(host.core.state.loadedId, "f1#1")
        XCTAssertEqual(host.core.state.skippedSegments, 0)
    }

    /// DEADLINE TWICE, THEN THE NEXT ITEM. The retry's own deadline steps over
    /// the clip in the same turn: a `skip kind=load` row, the `skipped` event
    /// the page shows, and the next clip's load. Never idle, never a stop.
    /// TO SEE IT FAIL: return false where `retryOrSkipClip` steps over (the
    /// Foray goes idle with `stop cause=load-deadline`, the drive's bug).
    func testAClipWhoseRetryPassesItsDeadlineTooIsSteppedOver() throws {
        var host = try ClipLoadRetryTests.inSeam()
        host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
        let step = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
        XCTAssertEqual(ForayTapeTests.loads(step), ["f1#2@500"], "the next clip loads: \(step)")
        XCTAssertFalse(ClipLoadRetryTests.hasStopRow(step), "\(step)")
        XCTAssertFalse(ClipLoadRetryTests.hasError(step), "\(step)")
        XCTAssertTrue(step.contains { if case let .emit(.skipped(itemId, index, _)) = $0 { return itemId == "f1#1" && index == 1 }; return false },
                      "the page's skipped event: \(step)")
        let row = try XCTUnwrap(ClipLoadRetryTests.rows(step, kind: "skip", event: "load").first, "\(step)")
        let admitted = try XCTUnwrap(DiagGate.admit(row))
        XCTAssertNil(admitted[field: DiagGate.droppedField], "\(admitted)")
        XCTAssertEqual(admitted[field: "attempts"], .number(2))
        XCTAssertEqual(host.core.state.stateType, "loadingItem")
        XCTAssertEqual(host.core.state.skippedSegments, 1)
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertEqual(host.core.state.loadedId, "f1#2")
    }

    /// A JUMP INTO A CLIP (a Foray scrub's load, 30 s into clip 2) whose load
    /// misses its deadline is retried AT THE JUMP, not the clip's in-point. The
    /// explicit offset is one-shot, spent by the first load, so the retry has
    /// to carry it. queue-manager.test.js "§16: a retry of a jump into a clip
    /// loads at the jump, not the clip's start" maps here.
    /// TO SEE IT FAIL: `load(item.ref, offsets: LoadOffsets(), ...)` in
    /// `retryOrSkipClip` (the retry loads `f1#1@300`).
    func testARetryLoadsAtTheSameOffsetAsTheLoadThatFailed() throws {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ClipLoadRetryTests.threeClips)))
        host.land()
        host.confirm()
        let jump = host.send(.queue(.playIndex(1, startSec: 330, source: .tap)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(jump), ["f1#1@330"], "\(jump)")
        let retry = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
        XCTAssertEqual(ForayTapeTests.loads(retry), ["f1#1@330"], "\(retry)")
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertEqual(host.core.state.loadedId, "f1#1")
    }

    /// An ERROR (the deck's `.failed`) is retried the same way as a deadline:
    /// the queue-manager reference retries any load failure of a clip.
    /// TO SEE IT FAIL: call `retryOrSkipClip` only for `.loadDeadline`.
    func testAClipWhoseLoadFailsIsRetriedToo() throws {
        var host = try ClipLoadRetryTests.inSeam()
        let retry = host.send(.deck(.failed(token: host.lastLoad ?? 0, message: "HTTP 503", cause: .http5xx)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(retry), ["f1#1@300"], "\(retry)")
        let row = try XCTUnwrap(ClipLoadRetryTests.rows(retry, kind: "deck", event: "retry").first, "\(retry)")
        XCTAssertEqual(row[field: "why"], .string("error"))
        XCTAssertEqual(row[field: "fileCause"], .string("http-5xx"))
    }

    /// PAUSED DURING THE LOAD (the car's own pause/play): the failed load is
    /// retried while paused, quietly, and nothing plays; the listener's play
    /// then asks the deck for the very same load. A retry that fails while
    /// paused is today's stop: idle, on the clip, nothing loading behind the
    /// pause.
    /// TO SEE IT FAIL: require `.loadingItem` for the retry (the first failure
    /// goes idle), or drop `guard waiting` (the second loads clip 3).
    func testAPausedClipLoadIsRetriedQuietlyAndAFailedRetryStopsAsBefore() throws {
        var host = try ClipLoadRetryTests.inSeam()
        host.send(try EngineCoreTests.command("pause"), after: 0)
        XCTAssertEqual(host.core.state.stateType, "interrupted")
        let retry = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
        XCTAssertEqual(ForayTapeTests.loads(retry), ["f1#1@300"], "retried while paused: \(retry)")
        XCTAssertFalse(retry.contains(.deck(.play)), "\(retry)")
        XCTAssertEqual(host.core.state.stateType, "interrupted")
        let row = try XCTUnwrap(ClipLoadRetryTests.rows(retry, kind: "deck", event: "retry").first)
        XCTAssertEqual(row[field: "waiting"], .bool(false))

        let stop = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
        XCTAssertEqual(ForayTapeTests.loads(stop), [], "nothing loads behind the pause: \(stop)")
        XCTAssertEqual(host.core.state.stateType, "idle")
        XCTAssertTrue(ClipLoadRetryTests.hasError(stop), "\(stop)")
        XCTAssertFalse(stop.contains { if case .emit(.skipped) = $0 { return true }; return false }, "\(stop)")
    }

    /// PLAY DURING AN IN-FLIGHT LOAD. A pause and a play while the clip is
    /// still loading ask the deck for the SAME load (source, in-point, timing,
    /// class), which AVDeck continues instead of starting cold when the first
    /// load is getting somewhere (`AVDeckTests
    /// .testASameSourceLoadWhileOneIsInFlightContinuesIt`). The core half.
    /// TO SEE IT FAIL: load a paused clip's resume from `savedPosition`
    /// rather than its in-point.
    func testAPlayDuringAnInFlightClipLoadAsksForTheSameLoad() throws {
        var host = try ClipLoadRetryTests.inSeam()
        host.send(try EngineCoreTests.command("pause"), after: 0)
        let play = host.send(try EngineCoreTests.command("play"), after: 0)
        let loads = ClipLoadRetryTests.deckLoads(play)
        guard loads.count == 1, case let .load(_, itemId, url, startSec, precise, deadlineClass) = loads[0] else {
            return XCTFail("one load, got \(play)")
        }
        XCTAssertEqual(itemId, "f1#1")
        XCTAssertEqual(url, "https://cdn.test/b.mp3")
        XCTAssertEqual(startSec, 300)
        XCTAssertTrue(precise)
        XCTAssertEqual(deadlineClass, .clip)
    }

    /// A PLAIN EPISODE IS NOT RETRIED (today's stop, unchanged): one load, the
    /// `load-deadline` stop, idle. queue-manager.test.js "§16: a plain episode
    /// whose load fails is not retried (today's stop)" maps here.
    /// TO SEE IT FAIL: drop `item.bounds != nil` from `retryOrSkipClip`.
    func testAPlainEpisodeWhoseLoadFailsIsNotRetried() {
        var host = Host(config: ForayTapeTests.tape)
        host.send(.queue(.load([EngineCoreTests.item("a"), EngineCoreTests.item("b")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let out = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
        XCTAssertEqual(ForayTapeTests.loads(out), [], "\(out)")
        XCTAssertEqual(host.core.state.stateType, "idle")
        XCTAssertTrue(ClipLoadRetryTests.hasStopRow(out), "\(out)")
        XCTAssertTrue(ClipLoadRetryTests.rows(out, kind: "deck", event: "retry").isEmpty)
    }

    /// The generated numbers are the JS reference's: two attempts, and the
    /// silence they bound is two clip deadlines (AVDeck's 20 s is pinned
    /// against it in AVDeckTests).
    func testTheAttemptsAndTheSilenceBoundAreTheReferences() {
        XCTAssertEqual(EngineConstants.QueueManager.forayClipLoadAttempts, 2)
        XCTAssertEqual(EngineConstants.QueueManager.forayClipMaxSilenceSec, 40)
        XCTAssertEqual(EngineConstants.QueueManager.forayClipLoadMaxSteps, 1)
    }

    static let fourClips = threeClips + [ForayTapeTests.clip(3, "d", 700, 800)]

    /// A Foray of four clips playing its first, then its end: clip 2's load
    /// (`f1#1@300`) in flight.
    static func inSeamOfFour() throws -> Host {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(fourClips)))
        host.land()
        host.confirm()
        host.reading.audible = false
        host.reading.ended = true
        let seam = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(seam), ["f1#1@300"], "\(seam)")
        return host
    }

    /// Fails the load in flight on both of its attempts; the second turn's out.
    static func failTwice(_ host: inout Host) -> [EngineCommand] {
        host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
        return host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20_000)), after: 20_000)
    }

    /// A SECOND CLIP IN A ROW THAT WILL NOT LOAD STOPS THE FORAY (the car in a
    /// dead zone: an offline load fails at once, and stepping over every clip
    /// would end the Foray in seconds and mark it Played). Clip 2 is stepped
    /// over; clip 3 stops it, idle on clip 3, with the stop row and the page's
    /// error, and clip 4 is never loaded. queue-manager.test.js "§16: a SECOND
    /// clip in a row that will not load stops the Foray instead of running
    /// through it" maps here.
    /// TO SEE IT FAIL: drop the `forayClipLoadMaxSteps` guard in
    /// `retryOrSkipClip` (clip 3 is stepped over and clip 4 loads).
    func testASecondClipInARowThatWillNotLoadStopsTheForay() throws {
        var host = try ClipLoadRetryTests.inSeamOfFour()
        let step = ClipLoadRetryTests.failTwice(&host)
        XCTAssertEqual(ForayTapeTests.loads(step), ["f1#2@500"], "clip 2 is stepped over: \(step)")
        XCTAssertEqual(host.core.state.clipLoadSteps, 1)
        let stop = ClipLoadRetryTests.failTwice(&host)
        XCTAssertEqual(ForayTapeTests.loads(stop), [], "clip 4 is never loaded: \(stop)")
        XCTAssertEqual(host.core.state.stateType, "idle")
        XCTAssertEqual(host.core.state.currentIndex, 2, "stopped on the second clip that failed")
        XCTAssertTrue(ClipLoadRetryTests.hasStopRow(stop), "\(stop)")
        XCTAssertTrue(ClipLoadRetryTests.hasError(stop), "\(stop)")
        XCTAssertEqual(host.core.state.skippedSegments, 1)
    }

    /// A clip that lands between two that will not load resets the run: two
    /// slow files are not the network, so the second is stepped over too (to
    /// the end of the Foray). queue-manager.test.js "§16: a clip that lands
    /// between two that will not load resets the run" maps here.
    /// TO SEE IT FAIL: drop `state.clipLoadSteps = 0` in `landed` (clip 4
    /// stops the Foray idle instead of ending it).
    func testAClipThatLandsBetweenTwoFailuresResetsTheRun() throws {
        var host = try ClipLoadRetryTests.inSeamOfFour()
        let step = ClipLoadRetryTests.failTwice(&host)
        XCTAssertEqual(ForayTapeTests.loads(step), ["f1#2@500"], "\(step)")
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertEqual(host.core.state.clipLoadSteps, 0, "a clip landed")
        host.reading.audible = false
        host.reading.ended = true
        let seam = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(seam), ["f1#3@700"], "\(seam)")
        let end = ClipLoadRetryTests.failTwice(&host)
        XCTAssertEqual(ForayTapeTests.loads(end), [], "\(end)")
        XCTAssertFalse(ClipLoadRetryTests.hasError(end), "stepped over, not stopped: \(end)")
        XCTAssertEqual(host.core.state.stateType, "ended")
        XCTAssertEqual(host.core.state.skippedSegments, 2)
    }
}

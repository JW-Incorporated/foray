import XCTest
import ForayEngineCore
import ForayEngineParity

/// Card NE-46: the silence node stays OFF, and the row that would show the
/// suspension it exists for. Every engine timer that fires while grace is
/// held compares its due time with now; more than `NARRATION_SUSPEND_GAP_MS`
/// (5 s) late writes `grace kind=late timer= lateMs= inSeam=y|n
/// bgRemainingMs=`. One `inSeam=y` row in a drive paste is the only evidence
/// that may turn the node on (SilenceNode.swift's header states the rule).
///
/// The clock is the Host's fake monotonic clock: `send(_, after:)` moves it,
/// so "delivered 6 s late" is a timer input fed 6 s after its due time.
final class LateTimerTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static let suspendGapMs = EngineConstants.QueueManager.narrationSuspendGapMs

    /// Every `grace kind=late` row in a turn.
    static func lateRows(_ out: [EngineCommand]) -> [DiagEntry] {
        out.compactMap {
            if case let .diag(entry) = $0, entry.kind == "grace", entry[field: "kind"]?.stringValue == "late" { return entry }
            return nil
        }
    }

    /// A Foray playing its first clip, backgrounded, reaching its out-point:
    /// the seam beat is running, grace is held (`seam`, the next clip was
    /// asked to prepare), and the next clip's load is ready, so the beat's
    /// remainder (500 ms, `SEAM_GAP_SEC`) is armed as `.seamBeat`.
    func heldSeam(config: EngineConfig = ForayTapeTests.tape, background: Bool = true) throws -> Host {
        var host = Host(config: config)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips)))
        host.land()
        host.confirm()
        host.send(.deck(.prepareWindow(token: host.lastLoad ?? 0)))
        if background {
            host.send(.lifecycle(.background))
            host.bgRemainingMs = 25_000
        }
        host.reading.audible = false
        host.reading.ended = true
        let out = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertEqual(out.contains(.graceBegin(.seam)), background, "\(out)")
        let ready = host.send(.deck(.ready(token: host.lastLoad ?? 0, landedSec: 300, prerolled: true, elapsedMs: 5)), after: 0)
        XCTAssertTrue(ready.contains(.timerArm(.seamBeat, afterMs: 500, repeating: false)), "\(ready)")
        return host
    }

    // MARK: - the acceptance pair

    /// A seam-beat timer delivered 6 s late while grace is held writes the
    /// row, before the seam lands, with the card's fields.
    func testASeamBeatSixSecondsLateUnderGraceWritesTheRow() throws {
        var host = try heldSeam()
        XCTAssertEqual(host.core.state.timerDueMono[.seamBeat], host.monoMs + 500, "the ledger keeps the beat's due time")
        let fired = host.send(.timer(.seamBeat), after: 500 + 6_000)
        let rows = LateTimerTests.lateRows(fired)
        XCTAssertEqual(rows.count, 1, "\(fired)")
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.fields.map(\.key), ["kind", "timer", "lateMs", "inSeam", "bgRemainingMs", "reason"])
        XCTAssertEqual(row[field: "timer"], .string("seam-beat"))
        XCTAssertEqual(row[field: "lateMs"], .number(6_000))
        XCTAssertEqual(row[field: "inSeam"], .string("y"))
        XCTAssertEqual(row[field: "bgRemainingMs"], .number(25_000))
        XCTAssertEqual(row[field: "reason"], .string("seam"))
        // The row decides nothing: the seam still lands, as it would on time.
        XCTAssertTrue(fired.contains(.deck(.play)), "\(fired)")
        XCTAssertNil(host.core.state.timerDueMono[.seamBeat], "a fired one-shot leaves the ledger")
        // Written first, so a paste reads the suspension before the landing.
        let rowAt = fired.firstIndex { if case let .diag(e) = $0 { return e == row }; return false }
        let playAt = fired.firstIndex(of: .deck(.play))
        XCTAssertLessThan(try XCTUnwrap(rowAt), try XCTUnwrap(playAt))
    }

    /// One 4 s late does not: a busy main thread is not a suspension.
    func testASeamBeatFourSecondsLateWritesNothing() throws {
        var host = try heldSeam()
        let fired = host.send(.timer(.seamBeat), after: 500 + 4_000)
        XCTAssertEqual(LateTimerTests.lateRows(fired), [], "\(fired)")
        XCTAssertTrue(fired.contains(.deck(.play)))
    }

    /// The threshold is exactly `NARRATION_SUSPEND_GAP_MS`, exclusive, as
    /// `_tickNarration` reads it.
    func testTheThresholdIsTheSuspendGapExclusive() throws {
        XCTAssertEqual(LateTimerTests.suspendGapMs, 5_000)
        var atGap = try heldSeam()
        XCTAssertEqual(LateTimerTests.lateRows(atGap.send(.timer(.seamBeat), after: 500 + LateTimerTests.suspendGapMs)), [])
        var past = try heldSeam()
        XCTAssertEqual(LateTimerTests.lateRows(past.send(.timer(.seamBeat), after: 500 + LateTimerTests.suspendGapMs + 1)).count, 1)
    }

    /// Without grace (the foreground: no span is opened) a late timer is not
    /// the question NE-46 asks, and writes nothing.
    func testALateTimerWithoutGraceWritesNothing() throws {
        var host = try heldSeam(background: false)
        XCTAssertNil(host.core.state.grace)
        XCTAssertEqual(LateTimerTests.lateRows(host.send(.timer(.seamBeat), after: 500 + 6_000)), [])
    }

    /// A cancelled timer leaves the ledger, so a stale delivery after a cut
    /// is never measured against a due time that no longer exists.
    func testACancelledTimerLeavesTheLedger() throws {
        var host = try heldSeam()
        let pause = host.send(try EngineCoreTests.command("pause"), after: 100)
        XCTAssertTrue(pause.contains(.timerCancel(.seamBeat)), "\(pause)")
        XCTAssertNil(host.core.state.timerDueMono[.seamBeat])
        XCTAssertEqual(LateTimerTests.lateRows(host.send(.timer(.seamBeat), after: 10_000)), [])
    }

    // MARK: - the load deadline

    /// The deck's P-13 deadline, reported more than 5 s after it was due
    /// (`afterMs` against the host's `loadDeadlineMs` for the load's class),
    /// while the seam's grace is held: `timer=load-deadline`, in the seam.
    func testALateLoadDeadlineInASeamWritesTheRow() throws {
        var config = ForayTapeTests.tape
        config.loadDeadlineMs = [.clip: 20_000, .line: 8_000]
        var host = Host(config: config)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips)))
        host.land()
        host.confirm()
        host.send(.lifecycle(.background))
        host.bgRemainingMs = 12_000
        host.reading.audible = false
        host.reading.ended = true
        let end = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertTrue(end.contains(.graceBegin(.prepareMiss)), "\(end)")
        XCTAssertEqual(host.core.state.lastLoadClass, .clip)
        let out = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 26_000)), after: 26_000)
        let row = try XCTUnwrap(LateTimerTests.lateRows(out).first, "\(out)")
        XCTAssertEqual(row[field: "timer"], .string(EngineCore.loadDeadlineTimer))
        XCTAssertEqual(row[field: "lateMs"], .number(6_000))
        XCTAssertEqual(row[field: "inSeam"], .string("y"))
        XCTAssertEqual(row[field: "bgRemainingMs"], .number(12_000))
        XCTAssertEqual(row[field: "reason"], .string("prepare-miss"))
    }

    /// On time (inside the gap), or with no deadline handed to the core (every
    /// headless test and the parity driver), a load deadline writes nothing.
    func testAnOnTimeOrUnconfiguredLoadDeadlineWritesNothing() throws {
        let cases: [([DeckDeadlineClass: Double], Int)] = [([.clip: 20_000], 21_000), ([:], 60_000)]
        for (deadlines, afterMs) in cases {
            var config = ForayTapeTests.tape
            config.loadDeadlineMs = deadlines
            var host = Host(config: config)
            host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips)))
            host.land()
            host.confirm()
            host.send(.lifecycle(.background))
            host.reading.audible = false
            host.reading.ended = true
            host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
            XCTAssertNotNil(host.core.state.grace)
            let out = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: afterMs)), after: Double(afterMs))
            XCTAssertEqual(LateTimerTests.lateRows(out), [], "\(deadlines) \(afterMs): \(out)")
        }
    }

    // MARK: - the pin

    /// The decision: `silenceNodeEnabled` defaults to false, and so the seam
    /// renders no silence and arms no silence cap. TO SEE IT FAIL: default
    /// the flag to true.
    func testTheSilenceNodeFlagDefaultsToFalse() throws {
        XCTAssertFalse(EngineConfig().silenceNodeEnabled)
        XCTAssertFalse(EngineConfig(build: "b", forayTapeEnabled: true).silenceNodeEnabled)
        XCTAssertFalse(ForayTapeTests.tape.silenceNodeEnabled)
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips)))
        host.land()
        host.confirm()
        host.reading.audible = false
        host.reading.ended = true
        let end = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertFalse(end.contains { if case .silenceStart = $0 { return true }; return false }, "\(end)")
        XCTAssertFalse(end.contains(.timerArm(.silenceCap, afterMs: Interlude.ceilingSec * 1000, repeating: false)))
        XCTAssertFalse(host.core.state.silenceActive)
    }
}

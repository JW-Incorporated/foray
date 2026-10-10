import XCTest
import ForayEngineCore
import ForayEngineParity

/// M2 drive 2026-10-01, Bug 2: the founder's "skip backwards didn't work
/// during the AI narration". The car's ↺15 (e#770, 0.2 s into a ~32 s spoken
/// line) and every press after it inside the line were `seek rejected`.
///
/// TWO CAUSES, each pinned below:
///
///  1. `onRemote` sent the car's skips and the lock screen's scrub to the
///     EPISODE seek, never the Foray clock (only the page's own `seekBy` /
///     `seekTo` commands reached `forayNudge` / `forayScrub`). During a line
///     that stepped from the clip's frozen playhead in the clip's own seconds
///     and asked the reducer for a `.seek`, which `.transitioning` (every line
///     reached by its seam) refuses. MUTATION: in `seekBy` / `seekTo`, drop
///     the `if forayTransport { return ... }` first line: the remote tests go
///     red.
///  2. On the Foray clock itself, `scrubTarget` answered a same-item target
///     with a `.seek` (refused in `.transitioning`, so a RENDERED line could
///     not be skipped inside), and the SPOKEN line sounding with nothing at
///     all (no offset). MUTATIONS: `let reload = elsewhere` in
///     `TransportPolicy.scrubTarget` (the rendered-line tests go red);
///     `let restart = false` (the spoken-line scrub goes red).
///
/// The parity half is `manager-foray/narration-skip-*` (the engine target's
/// `remote` step, against reference-engine.js) and `transport/scrub-*`.
///
/// The Foray clock here: s0 0-100, n1 (spoken, 32 s) 100-132, s1 132-232,
/// n2 (rendered, 32 s) 232-264, s2 264-364.
final class ForayNarrationSkipTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static func line(_ index: Int, _ id: String, rendered: Bool) -> JSONNode {
        .object([JSONMember("id", .string(id)), JSONMember("ord", .number(Double(index))), JSONMember("kind", .string("tts")),
                 JSONMember("audio_url", rendered ? .string("https://cdn.test/\(id).m4a") : .null),
                 JSONMember("title", .string("")), JSONMember("script", .string("A line of narration about the next clip.")),
                 JSONMember("duration_sec", .number(32)), JSONMember("duration_source", .string("measured"))])
    }

    static let items: [JSONNode] = [
        ForayTapeTests.clip(0, "a", 100, 200),
        line(1, "n1", rendered: false),
        ForayTapeTests.clip(2, "b", 300, 400),
        line(3, "n2", rendered: true),
        ForayTapeTests.clip(4, "c", 500, 600)
    ]

    /// A car's skip carries no interval: no host forwards one, and the core
    /// steps `MediaMapping.SeekSteps` whatever a press says (CH3-20, R3-08).
    static func back() -> EngineInput { .remote(RemotePress(.skipBackward)) }
    static func forward() -> EngineInput { .remote(RemotePress(.skipForward)) }
    static func scrub(_ sec: Double) -> EngineInput { .remote(RemotePress(.changePlaybackPosition, value: sec)) }

    /// The one load a press made, as (item, second).
    static func load(_ out: [EngineCommand]) -> (String, Double)? {
        let loads: [(String, Double)] = out.compactMap {
            if case let .deck(.load(_, itemId, _, startSec, _, _, _)) = $0 { return (itemId, startSec) }
            return nil
        }
        return loads.count == 1 ? loads[0] : nil
    }

    static func spoke(_ out: [EngineCommand]) -> Bool { NarrationOverlayTests.spokenSeq(out) != nil }

    static func refusedSeek(_ out: [EngineCommand]) -> Bool {
        out.contains {
            if case let .diag(entry) = $0 { return entry.kind == "seek" && entry[field: "kind"] == .string("rejected") }
            return false
        }
    }

    static func assertLoad(_ out: [EngineCommand], _ id: String, _ sec: Double,
                           file: StaticString = #filePath, line: UInt = #line) {
        guard let (item, at) = load(out) else { return XCTFail("expected one load of \(id)@\(sec): \(out)", file: file, line: line) }
        XCTAssertEqual(item, id, "\(out)", file: file, line: line)
        XCTAssertEqual(at, sec, accuracy: 0.001, "\(out)", file: file, line: line)
    }

    /// The Foray playing its first clip, at its out-point, which hands over to
    /// the SPOKEN line n1 (`.transitioning`); `accepted` answers the speak.
    func onSpokenLine(accepted: Bool = true, items: [JSONNode] = ForayNarrationSkipTests.items) throws -> Host {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(items)))
        host.land()
        host.confirm()
        host.reading.positionSec = 200
        host.reading.audible = false
        host.reading.ended = true
        let out = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        guard let seq = NarrationOverlayTests.spokenSeq(out) else {
            XCTFail("the line was not spoken: \(out)")
            return host
        }
        if accepted { host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0) }
        XCTAssertEqual(host.core.state.stateType, "transitioning")
        XCTAssertEqual(host.core.state.currentIndex, 1)
        return host
    }

    /// The Foray on clip s1, at its out-point, which hands over to the
    /// RENDERED line n2 (`.transitioning`), loaded and sounding at `sec`.
    func onRenderedLine(at sec: Double) throws -> Host {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayNarrationSkipTests.items)))
        host.land()
        host.confirm()
        host.send(try EngineCoreTests.command("jump", .object([JSONMember("index", .number(2))])))
        host.land()
        host.confirm()
        host.reading.positionSec = 400
        host.reading.audible = false
        host.reading.ended = true
        let out = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        ForayNarrationSkipTests.assertLoad(out, "n2", 0)
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "transitioning")
        XCTAssertEqual(host.core.state.currentIndex, 3)
        host.reading.positionSec = sec
        return host
    }

    // MARK: - a SPOKEN line reached by its seam

    /// e#770 itself: ↺15 0.2 s into the line steps back on the Foray clock
    /// (100.2 -> 85.2) into the clip before it, at its own second 185.2. The
    /// deck still holds that clip at 200, which is NOT where the listener is.
    func testTheCarsBackAtTheStartOfASpokenLineCrossesIntoTheClipBefore() throws {
        var host = try onSpokenLine()
        host.monoMs += 200
        let out = host.send(ForayNarrationSkipTests.back(), after: 0)
        ForayNarrationSkipTests.assertLoad(out, "f1#0", 185.2)
        XCTAssertFalse(ForayNarrationSkipTests.refusedSeek(out), "\(out)")
    }

    /// The speak() not yet answered: the line is where the load will land, its
    /// first word (100 -> 85).
    func testBackBeforeTheSpeakIsAnsweredStillCrossesBack() throws {
        var host = try onSpokenLine(accepted: false)
        let out = host.send(ForayNarrationSkipTests.back(), after: 0)
        ForayNarrationSkipTests.assertLoad(out, "f1#0", 185)
    }

    /// ↺15 20 s and 31 s into the 32 s line lands inside it: the synthesiser
    /// has no offset, so the line is said again from its first word (the
    /// manager's restart), and no deck loads.
    func testBackInsideASpokenLineSaysItAgain() throws {
        for into in [20.0, 31.0] {
            var host = try onSpokenLine()
            host.monoMs += into * 1000
            let out = host.send(ForayNarrationSkipTests.back(), after: 0)
            XCTAssertTrue(ForayNarrationSkipTests.spoke(out), "\(into) s: \(out)")
            XCTAssertNil(ForayNarrationSkipTests.load(out), "\(into) s: \(out)")
            XCTAssertEqual(host.core.state.currentIndex, 1, "\(into) s")
        }
    }

    /// 30↻ at the start of the line lands inside it (100 -> 130): forward
    /// inside a spoken line goes on to the clip after it (`nudgeAction`
    /// skip-line, the page's own rule), at its in-point.
    func testForwardAtTheStartOfASpokenLineGoesOnToTheNextClip() throws {
        var host = try onSpokenLine()
        let out = host.send(ForayNarrationSkipTests.forward(), after: 0)
        ForayNarrationSkipTests.assertLoad(out, "f1#2", 300)
    }

    /// 30↻ 10 s and 31 s in crosses into the next clip, 8 s and 29 s in.
    func testForwardLaterInASpokenLineCrossesIntoTheNextClip() throws {
        for (into, lands) in [(10.0, 308.0), (31.0, 329.0)] {
            var host = try onSpokenLine()
            host.monoMs += into * 1000
            let out = host.send(ForayNarrationSkipTests.forward(), after: 0)
            ForayNarrationSkipTests.assertLoad(out, "f1#2", lands)
        }
    }

    /// The lock screen's and the car's scrub is a Foray-clock second (the
    /// lock screen draws the Foray's clock, NE-37c): inside the spoken line it
    /// says the line again; into the next clip it lands 18 s in.
    func testALockScreenScrubDuringASpokenLineIsOnTheForayClock() throws {
        var inside = try onSpokenLine()
        let again = inside.send(ForayNarrationSkipTests.scrub(120), after: 0)
        XCTAssertTrue(ForayNarrationSkipTests.spoke(again), "\(again)")
        XCTAssertNil(ForayNarrationSkipTests.load(again), "\(again)")
        var across = try onSpokenLine()
        ForayNarrationSkipTests.assertLoad(across.send(ForayNarrationSkipTests.scrub(150), after: 0), "f1#2", 318)
    }

    /// The page's own `seekTo` command into the spoken line it is on: the
    /// line again, never nothing (it used to return with no offset, silently).
    func testThePagesScrubIntoTheSpokenLineSaysItAgain() throws {
        var host = try onSpokenLine()
        let out = host.send(try EngineCoreTests.command("seekTo", .object([JSONMember("sec", .number(110))])))
        XCTAssertTrue(ForayNarrationSkipTests.spoke(out), "\(out)")
    }

    /// 30↻ inside the Foray's CLOSING spoken line has nothing after it: it is
    /// refused `no-next` (never silently dropped) and nothing moves.
    func testForwardInsideTheClosingSpokenLineIsRefusedNotDropped() throws {
        var host = try onSpokenLine(items: Array(ForayNarrationSkipTests.items.prefix(2)))
        let out = host.send(ForayNarrationSkipTests.forward(), after: 0)
        XCTAssertTrue(out.contains(.commandFailed(reason: "no-next")), "\(out)")
        XCTAssertNil(ForayNarrationSkipTests.load(out))
        XCTAssertFalse(ForayNarrationSkipTests.spoke(out))
        XCTAssertEqual(host.core.state.currentIndex, 1)
    }

    // MARK: - a RENDERED line (a deck item, M3) reached by its seam

    /// ↺15 at the start of a rendered line (232 -> 217) reloads the clip
    /// before it at 385.
    func testBackAtTheStartOfARenderedLineCrossesIntoTheClipBefore() throws {
        var host = try onRenderedLine(at: 0)
        ForayNarrationSkipTests.assertLoad(host.send(ForayNarrationSkipTests.back(), after: 0), "f1#2", 385)
    }

    /// Inside a rendered line in `.transitioning` the reducer refuses a seek,
    /// so ↺15 / 30↻ / a scrub re-enter the line at the offset: 20 -> 5,
    /// 31 -> 16, 0 -> 30, and Foray second 240 -> 8.
    func testInsideARenderedLineInItsSeamASkipSeeksLikeAClip() throws {
        for (at, press, lands) in [(20.0, ForayNarrationSkipTests.back(), 5.0), (31.0, ForayNarrationSkipTests.back(), 16.0),
                                   (0.0, ForayNarrationSkipTests.forward(), 30.0), (3.0, ForayNarrationSkipTests.scrub(240), 8.0)] {
            var host = try onRenderedLine(at: at)
            let out = host.send(press, after: 0)
            ForayNarrationSkipTests.assertLoad(out, "n2", lands)
            XCTAssertFalse(ForayNarrationSkipTests.refusedSeek(out), "\(out)")
        }
    }

    /// The same through the page's own `seekBy` command, which always reached
    /// the Foray clock: there the same-item answer was a refused `.seek`.
    func testThePagesNudgeInsideARenderedLineInItsSeamIsNotRefused() throws {
        var host = try onRenderedLine(at: 20)
        let out = host.send(try EngineCoreTests.command("seekBy", .object([JSONMember("deltaSec", .number(-15))])))
        ForayNarrationSkipTests.assertLoad(out, "n2", 5)
    }

    /// 30↻ 10 s and 31 s into a rendered line crosses into the next clip.
    func testForwardLaterInARenderedLineCrossesIntoTheNextClip() throws {
        for (at, lands) in [(10.0, 508.0), (31.0, 529.0)] {
            var host = try onRenderedLine(at: at)
            ForayNarrationSkipTests.assertLoad(host.send(ForayNarrationSkipTests.forward(), after: 0), "f1#4", lands)
        }
    }

    /// A rendered line reached by a jump is `.playing`: ↺15 inside it is an
    /// ordinary seek in its own file.
    func testARenderedLineThatIsPlayingSeeksInPlace() throws {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayNarrationSkipTests.items)))
        host.land()
        host.confirm()
        host.send(try EngineCoreTests.command("jump", .object([JSONMember("index", .number(3))])))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        host.reading.positionSec = 20
        let out = host.send(ForayNarrationSkipTests.back(), after: 0)
        XCTAssertTrue(out.contains(.deck(.seek(toSec: 5))), "\(out)")
        XCTAssertNil(ForayNarrationSkipTests.load(out))
    }

    // MARK: - clips around the lines, from the car

    /// ↺15 5 s into the clip after a spoken line (137 -> 122) lands in the
    /// line: it is spoken from its first word.
    func testBackFromAClipIntoTheSpokenLineBeforeItSpeaksIt() throws {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayNarrationSkipTests.items)))
        host.land()
        host.confirm()
        host.send(try EngineCoreTests.command("jump", .object([JSONMember("index", .number(2))])))
        host.land()
        host.confirm()
        host.reading.positionSec = 305
        let out = host.send(ForayNarrationSkipTests.back(), after: 0)
        XCTAssertTrue(ForayNarrationSkipTests.spoke(out), "\(out)")
        XCTAssertEqual(host.core.state.currentIndex, 1)
    }

    /// The car's ↺15 inside a clip stays on the Foray clock too: 5 s in it is
    /// clamped at the Foray's start (the in-point), never before it into the
    /// stranger's episode (#65 §4), which the episode seek's floor of 0:00
    /// would have reached.
    func testTheCarsBackNearTheStartOfAClipIsClampedAtTheInPoint() throws {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayNarrationSkipTests.items)))
        host.land()
        host.confirm()
        host.reading.positionSec = 105
        let out = host.send(ForayNarrationSkipTests.back(), after: 0)
        XCTAssertTrue(out.contains(.deck(.seek(toSec: 100))), "\(out)")
    }
}

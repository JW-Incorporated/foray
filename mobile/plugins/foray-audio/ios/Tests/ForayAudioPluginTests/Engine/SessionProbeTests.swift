import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// The Developer session probe (card NE-25c; docs/native-engine-plan.md §10
/// DV-9) over the recording fakes: the card's acceptance, "an XCTest over the
/// fakes shows the probe's command sequence (speak → didFinish → activate if
/// needed → play → pause)", plus the edges a run on the founder's phone can
/// meet (a lost session, a refused activation, a deck that never plays, a
/// listener who presses play first, a relinquish mid-run).
///
/// The phone run differs only in which seams are real: the same host, the
/// same core, `PreviewSpeaker` instead of `FakeSpeaker`. So what is pinned
/// here is what the DV-9 row will mean.
///
/// Each test names the edit that turns it red.
final class SessionProbeTests: XCTestCase {

    /// An engine that played "a" (the deck confirmed `.playing`), was paused by
    /// the listener, and was then locked (backgrounded), with the log cleared:
    /// the state the desk pre-flight starts the probe from.
    @MainActor
    private func pausedAndLocked(_ world: FakeWorld, holdPolicy: SessionPolicy.HoldPolicy = .default) throws -> ForayEngine {
        world.deck.answersReady = true
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test", holdPolicy: holdPolicy))
        engine.start()
        engine.handle(.queue(.load([ForayEngineHostTests.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let token = try XCTUnwrap(world.deck.lastToken)
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        engine.handle(.command(.pause, source: .tap))
        world.background.post(.background)
        XCTAssertEqual(engine.state.stateType, "interrupted", "\(world.log.entries)")
        XCTAssertFalse(engine.state.isRunning)
        world.log.clear()
        return engine
    }

    private func probeRows(_ world: FakeWorld, _ kind: String) -> [DiagEntry] {
        world.output.diags.filter { $0.kind == "probe" && $0[field: "kind"]?.stringValue == kind }
    }

    private func result(_ world: FakeWorld, file: StaticString = #filePath, line: UInt = #line) throws -> DiagEntry {
        let rows = probeRows(world, "speech-then-play")
        XCTAssertEqual(rows.count, 1, "exactly one result row per run: \(world.output.diags)", file: file, line: line)
        return try XCTUnwrap(rows.last, file: file, line: line)
    }

    // MARK: - The card's sequence

    /// Held (the default `forever`): arm → 10 s → speak (no activation: the
    /// session is already the engine's) → didFinish → play in the same call →
    /// the deck's `.playing` → the row → pause. Background grace covers the
    /// locked play and ends on `.playing`.
    /// TO SEE IT FAIL: play before the speech ends (call the play from
    /// `speak()`), drop the pause in `finish`, or stop forwarding
    /// `Speaking.onFinish` to the probe in `ForayEngine.start()`.
    @MainActor
    func testWhileHeldTheProbeSpeaksThenPlaysThenPausesAndRecordsIt() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        XCTAssertNil(engine.probe, "nothing builds a probe until probeSession arrives")
        XCTAssertEqual(engine.state.session, .active, "held through the pause")

        let verdict = engine.handle(.command(.probeSession, source: .tap))
        XCTAssertTrue(verdict.ok, "\(verdict)")
        XCTAssertEqual(world.log.entries, ["timer.schedule 10000", "output.diag probe"])
        let armed = try XCTUnwrap(probeRows(world, "armed").first)
        XCTAssertEqual(armed[field: "held"], .bool(true))
        XCTAssertEqual(armed[field: "hold"], .string("forever"))
        XCTAssertEqual(world.speaker.spoken, [], "nothing is spoken before the delay: the founder is locking the phone")

        world.timing.fire(afterMs: SessionProbe.armDelayMs)
        XCTAssertEqual(world.speaker.spoken, [SessionProbe.line])
        XCTAssertEqual(world.log.count("deck.play"), 0, "no play while the line is being spoken")
        XCTAssertEqual(engine.probe?.phase, .speaking)

        world.timing.advance(900)
        world.speaker.end(.finished)
        XCTAssertEqual(engine.probe?.phase, .awaitingPlaying)
        let token = try XCTUnwrap(world.deck.lastToken)
        world.timing.advance(40)
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))

        let log = world.log.entries
        let speak = try XCTUnwrap(world.log.index(of: "speaker.speak"), "\(log)")
        let finished = try XCTUnwrap(world.log.index(of: "speaker.finished"), "\(log)")
        let play = try XCTUnwrap(world.log.index(of: "deck.play"), "\(log)")
        let pause = try XCTUnwrap(world.log.index(of: "deck.pause"), "\(log)")
        XCTAssertLessThan(speak, finished, "\(log)")
        XCTAssertLessThan(finished, play, "the play follows didFinish: \(log)")
        XCTAssertLessThan(play, pause, "and the probe pauses again: \(log)")
        XCTAssertEqual(world.log.count("session.activate"), 0, "a held session needs no activation for the line or the play")
        XCTAssertEqual(world.background.liveTasks, 0, "grace ended on the deck's .playing")
        XCTAssertNotNil(world.log.index(of: "background.begin ForayEngine.grace.background-tap"), "\(log)")

        let row = try result(world)
        XCTAssertEqual(row[field: "result"], .string("ok"))
        XCTAssertEqual(row[field: "token"], .null)
        XCTAssertEqual(row[field: "activated"], .bool(false))
        XCTAssertEqual(row[field: "activateMs"], .null)
        XCTAssertEqual(row[field: "timeToPlayingMs"], .number(40))
        XCTAssertEqual(row[field: "speechMs"], .number(900))
        XCTAssertEqual(row[field: "grace"], .string("background-tap"))
        XCTAssertEqual(row[field: "held"], .bool(true))
        XCTAssertEqual(row[field: "session"], .string("active"))
        XCTAssertFalse(engine.state.isRunning, "paused again")
        XCTAssertEqual(engine.probe?.phase, .idle)
        XCTAssertEqual(world.timing.live.count, 0, "no probe timer outlives the run")
    }

    /// "Activate if needed": the session was taken while the line spoke (an
    /// interruption that ended without shouldResume leaves it inactive), so
    /// the play after didFinish activates, once, and the row carries the
    /// activation's cost.
    /// TO SEE IT FAIL: read `activated` from anything but the host's
    /// activation count (e.g. hard-code false), or have the probe play the
    /// deck directly instead of through the core (no activation at all).
    @MainActor
    func testAPlayAfterTheLineActivatesWhenTheSessionWasLostAndRecordsTheCost() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.probeSession, source: .tap))
        world.timing.fire(afterMs: SessionProbe.armDelayMs)
        world.session.post(.interruptionBegan(reason: "default"))
        world.session.post(.interruptionEnded(shouldResume: false))
        XCTAssertEqual(engine.state.session, .inactive, "\(world.log.entries)")

        world.session.answer = SessionActivation(ok: true, activateMs: 37.5)
        world.speaker.end(.finished)
        let log = world.log.entries
        let finished = try XCTUnwrap(world.log.index(of: "speaker.finished"), "\(log)")
        let activate = try XCTUnwrap(world.log.index(of: "session.activate"), "\(log)")
        let play = try XCTUnwrap(world.log.index(of: "deck.play"), "\(log)")
        XCTAssertLessThan(finished, activate, "\(log)")
        XCTAssertLessThan(activate, play, "no audible start without the session: \(log)")
        XCTAssertEqual(world.log.count("session.activate"), 1, "\(log)")

        world.deck.report(.timeControl(token: try XCTUnwrap(world.deck.lastToken), status: .playing, waitingReason: nil))
        let row = try result(world)
        XCTAssertEqual(row[field: "result"], .string("ok"))
        XCTAssertEqual(row[field: "activated"], .bool(true))
        XCTAssertEqual(row[field: "activateMs"], .number(37.5))
        XCTAssertEqual(row[field: "session"], .string("inactive"), "what the core believed at didFinish")
        XCTAssertEqual(world.log.count("deck.pause"), 1, "\(world.log.entries)")
    }

    /// The system refuses the activation the play needs: the row says
    /// `failed` with the core's own token, nothing sounds, and there is
    /// nothing to pause.
    /// TO SEE IT FAIL: ignore the play's verdict in `speechEnded` (the run
    /// then ends 5 s later as `no-playing`, with the token lost).
    @MainActor
    func testARefusedActivationIsRecordedWithItsTokenAndNothingPlays() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.probeSession, source: .tap))
        world.timing.fire(afterMs: SessionProbe.armDelayMs)
        world.session.post(.interruptionBegan(reason: "default"))
        world.session.post(.interruptionEnded(shouldResume: false))
        world.session.answer = SessionActivation(ok: false, error: "cannot-interrupt-others", activateMs: 3)

        world.speaker.end(.finished)

        let row = try result(world)
        XCTAssertEqual(row[field: "result"], .string("failed"))
        XCTAssertEqual(row[field: "token"], .string("session-failed:cannot-interrupt-others"))
        XCTAssertEqual(row[field: "activated"], .bool(true))
        XCTAssertEqual(row[field: "activateMs"], .number(3))
        XCTAssertEqual(world.log.count("deck.play"), 0, "\(world.log.entries)")
        XCTAssertEqual(world.log.count("deck.pause"), 0, "\(world.log.entries)")
        XCTAssertEqual(world.timing.live.count, 0)
        XCTAssertEqual(engine.probe?.phase, .idle)
    }

    /// The play was accepted but the deck never said `.playing`: after 5 s the
    /// row says so, with no time, and the probe still pauses what it started.
    /// TO SEE IT FAIL: drop the playing timeout in `speechEnded`, or pause
    /// only on success in `finish`.
    @MainActor
    func testADeckThatNeverPlaysIsRecordedAfterTheTimeoutAndStillPaused() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.probeSession, source: .tap))
        world.timing.fire(afterMs: SessionProbe.armDelayMs)
        world.speaker.end(.finished)
        XCTAssertEqual(world.log.count("deck.play"), 1)
        XCTAssertTrue(engine.state.isRunning)

        world.timing.fire(afterMs: SessionProbe.playingTimeoutMs)

        let row = try result(world)
        XCTAssertEqual(row[field: "result"], .string("failed"))
        XCTAssertEqual(row[field: "token"], .string("no-playing"))
        XCTAssertEqual(row[field: "timeToPlayingMs"], .null)
        XCTAssertEqual(world.log.count("deck.pause"), 1, "\(world.log.entries)")
        XCTAssertFalse(engine.state.isRunning)
    }

    // MARK: - Refusals and the listener's own play

    /// There must be a paused episode to play: nothing loaded is
    /// `not-loaded`, a running engine or a run in flight is `engine-busy`,
    /// and a refused probe arms nothing.
    /// TO SEE IT FAIL: drop any guard in `arm()`.
    @MainActor
    func testTheProbeIsRefusedUnlessAnEpisodeIsLoadedAndPaused() throws {
        let empty = FakeWorld()
        let idle = ForayEngine(seams: empty.seams, config: EngineConfig(build: "test"))
        idle.start()
        XCTAssertEqual(idle.handle(.command(.probeSession, source: .tap)).failures, ["not-loaded"])
        XCTAssertEqual(empty.timing.live.count, 0)

        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.play, source: .tap))
        XCTAssertTrue(engine.state.isRunning)
        XCTAssertEqual(engine.handle(.command(.probeSession, source: .tap)).failures, ["engine-busy"])
        XCTAssertNil(world.log.index(of: "timer.schedule 10000"), "a refused probe arms nothing: \(world.log.entries)")

        engine.handle(.command(.pause, source: .tap))
        XCTAssertTrue(engine.handle(.command(.probeSession, source: .tap)).ok)
        XCTAssertEqual(engine.handle(.command(.probeSession, source: .tap)).failures, ["engine-busy"], "one run at a time")
        XCTAssertEqual(probeRows(world, "refused").count, 2)
    }

    /// A listener who presses play during the 10 s keeps their play: nothing
    /// is spoken, the row says `preempted`, and the probe pauses nothing.
    /// TO SEE IT FAIL: drop the running check in `speak()` (the audition is
    /// then refused `engine-busy`), or pause whenever the engine is running
    /// in `finish`.
    @MainActor
    func testAListenerWhoPlaysDuringTheDelayKeepsTheirPlay() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.probeSession, source: .tap))
        engine.handle(.command(.play, source: .tap))
        let pausesBefore = world.log.count("deck.pause")

        world.timing.fire(afterMs: SessionProbe.armDelayMs)

        XCTAssertEqual(world.speaker.spoken, [])
        let row = try result(world)
        XCTAssertEqual(row[field: "result"], .string("failed"))
        XCTAssertEqual(row[field: "token"], .string("preempted"))
        XCTAssertEqual(world.log.count("deck.pause"), pausesBefore)
        XCTAssertTrue(engine.state.isRunning)
    }

    /// The line was cancelled (an interruption took it, or it was replaced):
    /// no play follows, and the row says why.
    /// TO SEE IT FAIL: treat every `SpeechEnd` as finished in `speechEnded`.
    @MainActor
    func testACancelledLinePlaysNothingAndIsRecorded() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.probeSession, source: .tap))
        world.timing.fire(afterMs: SessionProbe.armDelayMs)

        world.speaker.end(.cancelled)

        XCTAssertEqual(world.log.count("deck.play"), 0)
        let row = try result(world)
        XCTAssertEqual(row[field: "token"], .string("speech-cancelled"))
        XCTAssertEqual(world.timing.live.count, 0)
    }

    /// A synthesizer that never reports the end: after 30 s the row says so
    /// and the line is stopped.
    /// TO SEE IT FAIL: drop the speech timeout in `speak()`.
    @MainActor
    func testALineThatNeverEndsIsStoppedAndRecorded() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.probeSession, source: .tap))
        world.timing.fire(afterMs: SessionProbe.armDelayMs)

        world.timing.fire(afterMs: SessionProbe.speechTimeoutMs)

        XCTAssertEqual(try result(world)[field: "token"], .string("speech-timeout"))
        XCTAssertNotNil(world.log.index(of: "speaker.stop"), "\(world.log.entries)")
        XCTAssertEqual(world.log.count("deck.play"), 0)
        XCTAssertEqual(engine.probe?.phase, .idle)
    }

    /// Under `pauseHoldPolicy = none` the pause released the session, so the
    /// LINE is what activates it (the core's audition path, never the
    /// synthesizer's implicit activation), and the play then finds it active.
    /// TO SEE IT FAIL: have the probe call `seams.speaker.speak` directly
    /// instead of sending the core an audition.
    @MainActor
    func testUnderHoldNoneTheLineActivatesTheSessionBeforeItSpeaks() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world, holdPolicy: .noHold)
        XCTAssertEqual(engine.state.session, .inactive)
        engine.handle(.command(.probeSession, source: .tap))
        XCTAssertEqual(try XCTUnwrap(probeRows(world, "armed").first)[field: "held"], .bool(false))

        world.timing.fire(afterMs: SessionProbe.armDelayMs)
        let log = world.log.entries
        let activate = try XCTUnwrap(world.log.index(of: "session.activate"), "\(log)")
        let speak = try XCTUnwrap(world.log.index(of: "speaker.speak"), "\(log)")
        XCTAssertLessThan(activate, speak, "\(log)")

        world.speaker.end(.finished)
        world.deck.report(.timeControl(token: try XCTUnwrap(world.deck.lastToken), status: .playing, waitingReason: nil))
        let row = try result(world)
        XCTAssertEqual(row[field: "result"], .string("ok"))
        XCTAssertEqual(row[field: "activated"], .bool(false), "the line's activation was not the play's")
        XCTAssertEqual(row[field: "held"], .bool(false))
        XCTAssertEqual(world.log.count("session.activate"), 1, "one activation, the line's: \(world.log.entries)")
    }

    // MARK: - Teardown

    /// A relinquish mid-run drops the probe with the rest of the engine: no
    /// timer stays armed, the synthesizer's end reaches nothing, and a late
    /// end is not a play.
    /// TO SEE IT FAIL: drop `probe?.cancel()` or `seams.speaker.onFinish =
    /// nil` from `teardown()`.
    @MainActor
    func testARelinquishCancelsARunInFlight() throws {
        let world = FakeWorld()
        let engine = try pausedAndLocked(world)
        engine.handle(.command(.probeSession, source: .tap))
        world.timing.fire(afterMs: SessionProbe.armDelayMs)
        XCTAssertEqual(world.timing.live.count, 1, "the speech timeout")

        engine.handle(.command(.relinquish(cap: .foray), source: .tap))

        XCTAssertTrue(engine.isTornDown)
        XCTAssertEqual(world.timing.live.count, 0)
        XCTAssertNil(world.speaker.onFinish)
        XCTAssertEqual(engine.probe?.phase, .idle)
        XCTAssertFalse(engine.probe?.hasLiveTimer ?? true)
        let seen = world.log.entries.count
        world.speaker.end(.finished)
        XCTAssertEqual(world.log.entries.count, seen + 1, "only the fake's own line: \(world.log.entries.suffix(3))")
        XCTAssertEqual(engine.handle(.command(.probeSession, source: .tap)).failures, ["relinquished"])
    }
}

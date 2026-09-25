import XCTest
import AVFoundation
import CryptoKit
import ForayEngineCore
@testable import ForayAudioPlugin

/// `AVAudioPlayer`, recorded: what InterludePlayer asked of it, and a
/// `didFinish` that arrives only when the test says so (or never).
final class FakeJingle: JingleAPI {
    var onFinish: ((Bool) -> Void)?
    var refuse = false
    private(set) var plays = 0
    private(set) var stops = 0

    func playFromStart() -> Bool {
        guard !refuse else { return false }
        plays += 1
        return true
    }

    func stop() { stops += 1 }

    /// The delegate call: `audioPlayerDidFinishPlaying(successfully:)`.
    func finish(_ ok: Bool = true) { onFinish?(ok) }
}

/// `AVAudioEngine`, recorded.
final class FakeSilenceEngine: SilenceEngineAPI {
    private(set) var starts = 0
    private(set) var stops = 0
    private(set) var running = false

    func start() -> Bool {
        starts += 1
        running = true
        return true
    }

    func stop() {
        stops += 1
        running = false
    }
}

/// An engine clock whose timers fire by DEADLINE as the test moves time on
/// (`run(to:)`), in deadline order and, at a tie, in the order they were
/// scheduled: the world the ceiling and the cap are about, where two timers
/// armed for the same instant both matter.
final class ClockTiming: EngineTiming {
    private final class Entry {
        var due: Double
        let every: Double?
        let order: Int
        let fire: () -> Void
        let token: FakeObservation

        init(due: Double, every: Double?, order: Int, fire: @escaping () -> Void, token: FakeObservation) {
            self.due = due
            self.every = every
            self.order = order
            self.fire = fire
            self.token = token
        }
    }

    var wallMs: Double = 1_790_000_000_000
    var monoMs: Double = 1_000
    private var entries: [Entry] = []
    private var scheduled = 0

    func schedule(afterMs: Double, repeating: Bool, fire: @escaping () -> Void) -> EngineObservation {
        scheduled += 1
        let token = FakeObservation()
        entries.append(Entry(due: monoMs + afterMs, every: repeating ? afterMs : nil, order: scheduled,
                             fire: fire, token: token))
        return token
    }

    /// Timers still armed.
    var liveCount: Int { entries.filter { $0.token.isLive }.count }

    /// Move the clock to `target`, firing every live timer that falls due on
    /// the way.
    func run(to target: Double) {
        while true {
            entries.removeAll { !$0.token.isLive }
            let due = entries.filter { $0.due <= target }
            guard let next = due.min(by: { ($0.due, $0.order) < ($1.due, $1.order) }) else { break }
            advanceClock(to: next.due)
            if let every = next.every {
                next.due += every
            } else {
                entries.removeAll { $0 === next }
            }
            next.fire()
        }
        advanceClock(to: target)
    }

    func run(forMs ms: Double) { run(to: monoMs + ms) }

    private func advanceClock(to mono: Double) {
        guard mono > monoMs else { return }
        wallMs += mono - monoMs
        monoMs = mono
    }
}

/// Card NE-34's acceptance (docs/native-engine-plan.md §14): the ceiling path
/// fires when `audioPlayerDidFinishPlaying` never comes; grace begin and end
/// counts match around synthetic seams; the silence node's lifetime never
/// exceeds `INTERLUDE_CEILING_SEC` with a 20 s load; the flag defaults off and
/// its path runs; and the bundled jingle is the web's, by SHA-256.
///
/// Executed headless on the Simulator by `ci.yml`'s ios-kit. Each test names
/// the edit that turns it red.
final class InterludeSeamTests: XCTestCase {

    static let ceilingMs = Interlude.ceilingSec * 1000

    static func clip(_ index: Int, _ name: String, _ start: Double, _ end: Double) -> EngineItem {
        EngineItem(node: .object([
            JSONMember("id", .string("f1#\(index)")), JSONMember("kind", .string("episode")),
            JSONMember("audio_url", .string("https://cdn.test/\(name).mp3")),
            JSONMember("start_sec", .number(start)), JSONMember("end_sec", .number(end)),
            JSONMember("duration_sec", .number(3600))
        ]))!
    }

    /// Three clips of three different episodes: two seams, each one a jingle
    /// seam (segment -> segment, different sources).
    static let threeClips = [clip(0, "a", 100, 200), clip(1, "b", 300, 400), clip(2, "c", 500, 600)]

    /// The Foray tape on (NE-37 turns it on for real), with the jingle
    /// available and, optionally, the silence node.
    static func tape(interlude: Bool, silence: Bool = false) -> EngineConfig {
        EngineConfig(build: "test", forayTapeEnabled: true, interludeAvailable: interlude, silenceNodeEnabled: silence)
    }

    // MARK: - Worlds

    private struct Rig {
        let world: FakeWorld
        let clock: ClockTiming
        let engine: ForayEngine
    }

    /// A host on fakes, with the deadline clock, playing the first clip,
    /// confirmed audible.
    @MainActor
    private func playing(_ config: EngineConfig, interlude: InterludePlaying? = nil,
                         silence: SilenceRendering? = nil, clock: ClockTiming = ClockTiming()) -> Rig {
        let world = FakeWorld()
        world.deck.answersReady = true
        world.interlude = interlude
        world.silence = silence
        var seams = world.seams
        seams.timing = clock
        let engine = ForayEngine(seams: seams, config: config)
        engine.start()
        engine.handle(.queue(.loadForay(Self.threeClips, isLocalFile: false, allowAdPad: false)))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        confirmPlaying(world)
        XCTAssertEqual(engine.state.stateType, "playing")
        return Rig(world: world, clock: clock, engine: engine)
    }

    private func confirmPlaying(_ world: FakeWorld, file: StaticString = #filePath, line: UInt = #line) {
        guard let token = world.deck.lastToken else { return XCTFail("nothing was loaded", file: file, line: line) }
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
    }

    /// The deck reaches the clip's out-point.
    private func reachOutPoint(_ world: FakeWorld) {
        world.deck.reading.audible = false
        world.deck.reading.ended = true
        world.deck.report(.ended(token: world.deck.lastToken ?? 0))
    }

    private func rows(_ world: FakeWorld, _ kind: String, _ sub: String) -> [DiagEntry] {
        world.output.diags.filter { $0.kind == kind && $0[field: "kind"] == .string(sub) }
    }

    @MainActor
    private func jinglePlayer(_ jingle: FakeJingle, clock: ClockTiming, world: FakeWorld? = nil,
                              sessionIsActive: @escaping () -> Bool = { true },
                              faults: ((String) -> Void)? = nil) -> InterludePlayer {
        let fault: (String) -> Void = faults ?? { message in XCTFail("unexpected fault: \(message)") }
        return InterludePlayer(config: InterludePlayer.Config(
            sessionIsActive: sessionIsActive,
            diag: { entry in if let world { world.output.diag(entry) } },
            timing: clock,
            makeJingle: { jingle },
            debugFault: fault))
    }

    // MARK: - The hash pin

    /// The jingle the phone plays is the web's, byte for byte, and it decodes
    /// to the measured 3.0 s.
    /// TO SEE IT FAIL: re-export the bundled WAV (any byte), or drop the
    /// `resources:` line from the ForayAudioPlugin target.
    func testTheBundledJingleIsTheWebAssetByHash() throws {
        let url = try XCTUnwrap(InterludePlayer.assetURL, "the plugin's resource bundle carries no interlude-placeholder.wav")
        let data = try Data(contentsOf: url)
        let hex = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, InterludePlayer.assetSHA256)
        let player = try AVAudioPlayer(contentsOf: url)
        XCTAssertEqual(player.duration, Interlude.durationSec, accuracy: 0.05, "INTERLUDE_DURATION_SEC is the asset's length")
    }

    // MARK: - The ceiling

    /// `audioPlayerDidFinishPlaying` never comes: at INTERLUDE_CEILING_SEC
    /// from the start the player stops the jingle itself and reports
    /// `ceiling`, once; a delegate call that finally arrives reports nothing.
    /// TO SEE IT FAIL: drop the ceiling timer from `start()`, or report a
    /// finish without the `this == sounding` check.
    @MainActor
    func testTheCeilingFiresWhenDidFinishNeverComes() {
        let clock = ClockTiming()
        let jingle = FakeJingle()
        let player = jinglePlayer(jingle, clock: clock)
        var ends: [String] = []
        player.onEnded = { ends.append($0) }

        XCTAssertTrue(player.start())
        XCTAssertEqual(jingle.plays, 1)
        clock.run(forMs: Self.ceilingMs - 1)
        XCTAssertEqual(ends, [], "nothing before the ceiling")
        XCTAssertTrue(player.isSounding)
        clock.run(forMs: 1)
        XCTAssertEqual(ends, ["ceiling"])
        XCTAssertFalse(player.isSounding)
        XCTAssertEqual(jingle.stops, 1, "the ceiling silences the player, not just the report")
        jingle.finish(true)
        clock.run(forMs: 10_000)
        XCTAssertEqual(ends, ["ceiling"], "one end per start")
        XCTAssertEqual(clock.liveCount, 0)
    }

    /// The ordinary path: the file runs out at 3 s, `ended` is reported and
    /// the ceiling is disarmed; a stop reports nothing; a restart's end
    /// belongs to the restart only.
    /// TO SEE IT FAIL: leave the ceiling armed after a finish, or report on
    /// `stop()`.
    @MainActor
    func testAnOrdinaryEndDisarmsTheCeilingAndAStopReportsNothing() {
        let clock = ClockTiming()
        let jingle = FakeJingle()
        let player = jinglePlayer(jingle, clock: clock)
        var ends: [String] = []
        player.onEnded = { ends.append($0) }

        XCTAssertTrue(player.start())
        clock.run(forMs: Interlude.durationSec * 1000)
        jingle.finish(true)
        clock.run(forMs: Self.ceilingMs)
        XCTAssertEqual(ends, ["ended"])
        XCTAssertEqual(clock.liveCount, 0)

        XCTAssertTrue(player.start())
        player.stop()
        clock.run(forMs: Self.ceilingMs * 2)
        jingle.finish(true)
        XCTAssertEqual(ends, ["ended"], "a stop is not an end")

        XCTAssertTrue(player.start())
        let superseded = jingle.onFinish
        XCTAssertTrue(player.start(), "a start while sounding restarts")
        superseded?(true)
        XCTAssertEqual(ends, ["ended"], "a superseded start's finish reports nothing")
        jingle.finish(false)
        XCTAssertEqual(ends, ["ended", "error"])
        player.release()
        XCTAssertFalse(player.isSounding)
    }

    /// The audible-start invariant, in the player: no session, no sound, a
    /// fault row, and the host's jingle start is answered `refused`.
    /// TO SEE IT FAIL: move the `sessionIsActive` check below `playFromStart`.
    @MainActor
    func testTheJingleNeverStartsWithoutTheSession() {
        let world = FakeWorld()
        let clock = ClockTiming()
        let jingle = FakeJingle()
        var faults: [String] = []
        let player = jinglePlayer(jingle, clock: clock, world: world, sessionIsActive: { false },
                                  faults: { faults.append($0) })
        XCTAssertFalse(player.start())
        XCTAssertEqual(jingle.plays, 0)
        XCTAssertEqual(faults, ["fault implicit-activation interlude"])
        let fault = rows(world, "fault", Vocabulary.FaultKind.implicitActivation.rawValue)
        XCTAssertEqual(fault.first?[field: "at"], .string("interlude"))
        XCTAssertEqual(clock.liveCount, 0, "no ceiling for a refused start")
    }

    // MARK: - The jingle through the host

    /// A seam with the jingle, the next clip loaded at once, and a
    /// `didFinish` that never comes: the player's ceiling ends the jingle at
    /// 4.5 s from the out-point and the next clip starts then, not later.
    /// TO SEE IT FAIL: drop the host's `onEnded` wiring (the seam then waits
    /// for the core's own ceiling only if its timer survives), or feed the
    /// core `ended` for a `stop`.
    @MainActor
    func testTheHostsJingleEndsAtTheCeilingAndTheNextClipStarts() {
        let clock = ClockTiming()
        let jingle = FakeJingle()
        let world = FakeWorld()
        let player = jinglePlayer(jingle, clock: clock, world: world)
        let rig = playing(Self.tape(interlude: true), interlude: player, clock: clock)
        let playsBefore = rig.world.deck.count("play")
        let outPoint = clock.monoMs

        reachOutPoint(rig.world)
        XCTAssertEqual(jingle.plays, 1, "the seam carries the jingle")
        XCTAssertTrue(rig.engine.state.inInterlude)
        clock.run(to: outPoint + Self.ceilingMs - 1)
        XCTAssertEqual(rig.world.deck.count("play"), playsBefore, "the jingle holds the seam")
        clock.run(to: outPoint + Self.ceilingMs)
        XCTAssertFalse(rig.engine.state.inInterlude)
        XCTAssertEqual(rig.world.deck.count("play"), playsBefore + 1, "the next clip starts at the ceiling")
        XCTAssertEqual(jingle.stops, 1)
        let ended = rows(rig.world, "interlude", "ended")
        XCTAssertEqual(ended.last?[field: "why"], .string("ceiling"))
    }

    /// A jingle start the host cannot honour is an immediate end, so the
    /// seam shrinks back to its beat.
    /// TO SEE IT FAIL: drop the `ended(refused)` answer from interpretInterlude.
    @MainActor
    func testARefusedJingleShrinksTheSeamToTheBeat() {
        let interlude = FakeInterlude(log: SeamLog())
        interlude.refuse = true
        let clock = ClockTiming()
        let rig = playing(Self.tape(interlude: true), interlude: interlude, clock: clock)
        let playsBefore = rig.world.deck.count("play")
        let outPoint = clock.monoMs
        reachOutPoint(rig.world)
        XCTAssertFalse(rig.engine.state.inInterlude)
        clock.run(to: outPoint + SeamGap.defaultGapSec * 1000)
        XCTAssertEqual(rig.world.deck.count("play"), playsBefore + 1, "the beat, not the ceiling")
    }

    // MARK: - Grace around seams

    /// Backgrounded, each seam holds exactly one background task from the
    /// out-point until the next clip is confirmed audible: `seam` when the
    /// standby was asked to prepare it, `prepare-miss` when not. Begins and
    /// ends match, nothing is left open, and each `end` row says `playing`.
    /// TO SEE IT FAIL: ignore `.graceEnd` in the host, or begin a task per
    /// `.graceBegin` without ending a stale one.
    @MainActor
    func testGraceBeginAndEndCountsMatchAroundSeams() {
        let clock = ClockTiming()
        let interlude = FakeInterlude(log: SeamLog())
        let rig = playing(Self.tape(interlude: true), interlude: interlude, clock: clock)
        let world = rig.world
        world.background.backgroundTimeRemainingSec = 29
        world.background.post(.background)

        // Seam 1, prepared.
        world.deck.report(.prepareWindow(token: world.deck.lastToken ?? 0))
        reachOutPoint(world)
        XCTAssertEqual(world.background.liveTasks, 1, "the span runs from the out-point")
        XCTAssertEqual(world.log.count("background.begin ForayEngine.grace.seam"), 1)
        interlude.end("ended")
        clock.run(forMs: Self.ceilingMs)
        XCTAssertEqual(world.background.liveTasks, 1, "held until the deck confirms sound")
        confirmPlaying(world)
        XCTAssertEqual(world.background.liveTasks, 0)

        // Seam 2, nothing prepared.
        reachOutPoint(world)
        XCTAssertEqual(world.log.count("background.begin ForayEngine.grace.prepare-miss"), 1)
        clock.run(forMs: Self.ceilingMs)
        confirmPlaying(world)

        let begins = world.log.count("background.begin", prefix: true)
        XCTAssertEqual(begins, 2)
        XCTAssertEqual(world.background.ended.count, begins, "every begin has one end")
        XCTAssertEqual(Set(world.background.ended).count, begins, "no task ended twice")
        XCTAssertEqual(world.background.liveTasks, 0)
        let ends = rows(world, "grace", "end")
        XCTAssertEqual(ends.map { $0[field: "reason"] }, [.string("seam"), .string("prepare-miss")])
        XCTAssertEqual(ends.map { $0[field: "outcome"] }, [.string("playing"), .string("playing")])
    }

    /// A pause inside a backgrounded seam ends the span (`not-running`), and
    /// a teardown mid-seam leaves no task, no jingle and no silence.
    /// TO SEE IT FAIL: drop `seams.interlude?.release()` or the grace end
    /// from teardown().
    @MainActor
    func testACutSeamAndATeardownLeaveNothingOpen() {
        let clock = ClockTiming()
        let interlude = FakeInterlude(log: SeamLog())
        let silence = FakeSilence(log: SeamLog())
        let rig = playing(Self.tape(interlude: true), interlude: interlude, silence: silence, clock: clock)
        let world = rig.world
        world.background.post(.background)
        reachOutPoint(world)
        XCTAssertEqual(world.background.liveTasks, 1)
        XCTAssertTrue(interlude.isSounding)
        rig.engine.handle(.command(.pause, source: .tap))
        XCTAssertFalse(interlude.isSounding, "a transport action cuts the jingle")
        XCTAssertEqual(world.background.liveTasks, 0)
        XCTAssertEqual(rows(world, "grace", "end").last?[field: "outcome"], .string("not-running"))

        rig.engine.handle(.command(.play, source: .tap))
        reachOutPoint(world)
        rig.engine.teardown()
        XCTAssertEqual(world.background.liveTasks, 0)
        XCTAssertGreaterThanOrEqual(interlude.releases, 1)
        XCTAssertFalse(silence.isRunning)
    }

    // MARK: - The silence node

    /// The flag ships OFF; off, a silent seam asks for no silence at all.
    /// TO SEE IT FAIL: default `silenceNodeEnabled` to true.
    @MainActor
    func testTheSilenceFlagDefaultsOff() {
        XCTAssertFalse(EngineConfig().silenceNodeEnabled)
        XCTAssertFalse(EngineConfig(build: "b", forayTapeEnabled: true).silenceNodeEnabled)
        let silence = FakeSilence(log: SeamLog())
        let rig = playing(Self.tape(interlude: false), silence: silence)
        reachOutPoint(rig.world)
        XCTAssertEqual(silence.caps, [], "flag off: no silence node")
    }

    /// The flag's path, and the cap: a silent seam whose next load takes 20 s.
    /// The node starts at the out-point and has stopped by 4.5 s from it,
    /// whatever the load does; it does not start again when the load finally
    /// lands; and its one span is at most INTERLUDE_CEILING_SEC.
    /// TO SEE IT FAIL: drop the node's own cap timer AND the core's
    /// `.silenceCap`, or clamp to `capMs` without the ceiling.
    @MainActor
    func testTheSilenceNodeNeverOutlivesTheCeilingWithATwentySecondLoad() {
        let clock = ClockTiming()
        let engineAPI = FakeSilenceEngine()
        let node = SilenceNode(config: SilenceNode.Config(sessionIsActive: { true }, diag: { _ in }, timing: clock,
                                                          makeEngine: { engineAPI }))
        let rig = playing(Self.tape(interlude: false, silence: true), silence: node, clock: clock)
        rig.world.deck.answersReady = false
        let outPoint = clock.monoMs

        reachOutPoint(rig.world)
        XCTAssertTrue(node.isRunning, "a silent seam starts the node")
        XCTAssertEqual(engineAPI.starts, 1)
        var step = outPoint
        while step < outPoint + 20_000 {
            step += 250
            clock.run(to: step)
            if step >= outPoint + Self.ceilingMs {
                XCTAssertFalse(node.isRunning, "still rendering \(step - outPoint) ms after the out-point")
            }
        }
        XCTAssertFalse(engineAPI.running)
        rig.world.deck.report(.ready(token: rig.world.deck.lastToken ?? 0, landedSec: 300, prerolled: true, elapsedMs: 20_000))
        clock.run(forMs: 1_000)
        XCTAssertEqual(engineAPI.starts, 1, "the landing never restarts it")
        XCTAssertEqual(node.spansMs.count, 1)
        XCTAssertLessThanOrEqual(node.spansMs.max() ?? .infinity, Self.ceilingMs)
    }

    /// The node itself clamps any cap to the ceiling, and refuses without
    /// the session (a fault row, nothing started).
    /// TO SEE IT FAIL: use `capMs` unclamped; drop the session check.
    @MainActor
    func testTheNodeClampsItsCapAndNeedsTheSession() {
        let clock = ClockTiming()
        let engineAPI = FakeSilenceEngine()
        let node = SilenceNode(config: SilenceNode.Config(sessionIsActive: { true }, diag: { _ in }, timing: clock,
                                                          makeEngine: { engineAPI }))
        XCTAssertTrue(node.start(capMs: 20_000))
        clock.run(forMs: Self.ceilingMs)
        XCTAssertFalse(node.isRunning)
        XCTAssertEqual(node.spansMs, [Self.ceilingMs])

        let world = FakeWorld()
        var faults: [String] = []
        let cold = SilenceNode(config: SilenceNode.Config(sessionIsActive: { false }, diag: { world.output.diag($0) },
                                                          timing: clock, makeEngine: { engineAPI },
                                                          debugFault: { faults.append($0) }))
        XCTAssertFalse(cold.start(capMs: 1_000))
        XCTAssertEqual(engineAPI.starts, 1)
        XCTAssertEqual(faults, ["fault implicit-activation silence"])
        XCTAssertEqual(rows(world, "fault", Vocabulary.FaultKind.implicitActivation.rawValue).first?[field: "at"],
                       .string("silence"))
    }
}

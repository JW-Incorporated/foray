import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// `ForayEngine`, the host, over recording fakes of every seam (card NE-15h,
/// docs/native-engine-plan.md §4.2 and §14). No audio, no session, no app:
/// the fakes in `RecordingSeams.swift` stand in for each, share one ordered
/// log, and count what is still registered.
///
/// These are the card's acceptance, executed headless on the Simulator by
/// `ci.yml`'s ios-kit (`xcodebuild test -scheme ForayAudio`): a failed
/// activation plays nothing; a car's play activates and plays inside the one
/// handler call; teardown leaves nothing live. The rest pin what the host
/// promises the cards built on it (NE-16, NE-16g, NE-17, NE-18).
///
/// Each test names the edit that turns it red.
final class ForayEngineHostTests: XCTestCase {

    static func item(_ id: String) -> EngineItem {
        EngineItem(node: .object([JSONMember("id", .string(id)), JSONMember("kind", .string("episode")),
                                  JSONMember("audio_url", .string("https://cdn.example/\(id).mp3"))]))!
    }

    @MainActor
    private func started(_ world: FakeWorld, config: EngineConfig = EngineConfig(build: "test")) -> ForayEngine {
        let engine = ForayEngine(seams: world.seams, config: config)
        engine.start()
        return engine
    }

    /// An engine playing "a" on a warm deck (the load answers `.ready` at
    /// once), not yet confirmed `.playing` by the deck.
    @MainActor
    private func playing(_ world: FakeWorld, config: EngineConfig = EngineConfig(build: "test"),
                         backgrounded: Bool = false) -> ForayEngine {
        world.deck.answersReady = true
        let engine = started(world, config: config)
        if backgrounded { world.background.post(.background) }
        engine.handle(.queue(.load([Self.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(engine.state.stateType, "playing", "\(world.log.entries)")
        XCTAssertEqual(world.deck.count("play"), 1)
        return engine
    }

    // MARK: - Activation is a request and a response inside one turn

    /// Plan §4.2/§4.4: the session seam refuses, so the core's parked intent
    /// never runs. No load, no play; the refusal reaches the caller.
    /// TO SEE IT FAIL: feed `.sessionResult` with `ok: true` whatever the
    /// seam answered, or drop the `.sessionActivate` case's result feed (the
    /// refusal then never reaches the caller).
    @MainActor
    func testAFailedActivationYieldsNoDeckPlay() {
        let world = FakeWorld()
        world.session.answer = SessionActivation(ok: false, error: "cannot-interrupt-others", activateMs: 4)
        let engine = started(world)
        engine.handle(.queue(.load([Self.item("a")])))

        let verdict = engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(verdict.failures, ["session-failed:cannot-interrupt-others"])
        XCTAssertFalse(verdict.deferred)
        XCTAssertEqual(world.session.activateCalls, 1)
        XCTAssertEqual(world.deck.count("load"), 0, "\(world.log.entries)")
        XCTAssertEqual(world.deck.count("play"), 0, "\(world.log.entries)")
        XCTAssertEqual(engine.state.session, .inactive)

        // The same refusal from the car: the press fails, nothing sounds, and
        // the grace span it opened is closed again.
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))
        XCTAssertEqual(world.remote.press(.play), .commandFailed)
        XCTAssertEqual(world.session.activateCalls, 2)
        XCTAssertEqual(world.deck.count("play"), 0, "\(world.log.entries)")
        XCTAssertEqual(world.background.liveTasks, 0, "a refused play must not hold background time")
        withExtendedLifetime(engine) {}
    }

    /// The car test's first second (plan §4.5 cold path): with a restored
    /// queue and nothing loaded, a remote play opens grace, activates, loads,
    /// and plays, ALL before the handler returns to MediaPlayer. The warm
    /// deck answers `.ready` from inside `send(.load)`, so the play is a
    /// queued input drained in the same call.
    /// TO SEE IT FAIL: make `.sessionActivate` defer the answer to a later
    /// main turn (`DispatchQueue.main.async`), or drop the `drain()` after a
    /// turn: the handler then returns with nothing playing.
    @MainActor
    func testARemotePlayActivatesAndPlaysInOneMainTurn() throws {
        let world = FakeWorld()
        world.deck.answersReady = true
        let engine = started(world)
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))
        world.log.clear()

        XCTAssertEqual(world.remote.press(.play), .success)

        let log = world.log.entries
        let grace = try XCTUnwrap(world.log.index(of: "background.begin ForayEngine.grace.remote-play"), "\(log)")
        let activate = try XCTUnwrap(world.log.index(of: "session.activate"), "\(log)")
        let load = try XCTUnwrap(world.log.index(of: "deck.load"), "\(log)")
        let play = try XCTUnwrap(world.log.index(of: "deck.play"), "\(log)")
        XCTAssertLessThan(grace, activate, "grace covers the silent span from the press: \(log)")
        XCTAssertLessThan(activate, load, "nothing loads before the session answers: \(log)")
        XCTAssertLessThan(load, play, "\(log)")
        XCTAssertEqual(world.session.activateCalls, 1)
        XCTAssertEqual(engine.state.stateType, "playing")
        XCTAssertEqual(engine.state.session, .active)

        // Grace holds until the deck confirms sound, then its task ends.
        XCTAssertEqual(world.background.liveTasks, 1)
        let token = try XCTUnwrap(world.deck.lastToken)
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertEqual(world.background.liveTasks, 0)
        XCTAssertEqual(world.background.ended.count, 1)
    }

    // MARK: - One turn at a time

    /// An input that arrives while a turn is being interpreted (here, from
    /// inside the diagnostics writer) is queued and runs right after it.
    /// TO SEE IT FAIL: drop the `depth > 0` branch in `handle`.
    @MainActor
    func testAnInputArrivingMidTurnIsQueuedAndRunsAfterIt() {
        let world = FakeWorld()
        let engine = started(world)
        var nested: EngineVerdict?
        world.output.onDiag = { entry in
            MainActor.assumeIsolated {
                guard entry.kind == "remote", nested == nil else { return }
                nested = engine.handle(.lifecycle(.background))
                XCTAssertFalse(engine.state.backgrounded, "the nested input ran inside the turn")
            }
        }
        _ = world.remote.press(.pause)
        XCTAssertEqual(nested, .queued)
        XCTAssertTrue(engine.state.backgrounded, "the queued input never ran")
    }

    // MARK: - Teardown

    /// Plan §4.6 step 5: every observer, remote target, timer and grace task
    /// is gone (the host's own 1 s Now Playing refresh too), the deck is
    /// invalidated, and nothing that fires afterwards reaches a seam.
    /// TO SEE IT FAIL: skip any line of `teardown()` (the matching count
    /// stays at one; `cancelSurfaceRefresh()` leaves the heartbeat live), or
    /// its `isTornDown` refusal in `handle`.
    @MainActor
    func testTeardownLeavesZeroLiveObservers() {
        let world = FakeWorld()
        let engine = playing(world, backgrounded: true)
        XCTAssertTrue(engine.state.backgrounded, "the lifecycle observer did not deliver")
        XCTAssertEqual(world.session.liveObservers, 1)
        XCTAssertEqual(world.background.liveLifecycleObservers, 1)
        XCTAssertEqual(world.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        XCTAssertEqual(world.background.liveTasks, 1, "a background tap play holds grace until the deck confirms")
        XCTAssertEqual(world.timing.live.count, 2, "the position cadence and the Now Playing refresh run while playing")
        XCTAssertEqual(engine.liveTimers, [.positionTick])
        XCTAssertTrue(engine.isRefreshingNowPlaying)
        XCTAssertTrue(world.deck.isObserved)

        engine.teardown()

        XCTAssertEqual(world.session.liveObservers, 0)
        XCTAssertEqual(world.background.liveLifecycleObservers, 0)
        XCTAssertEqual(world.remote.liveTargets, 0)
        XCTAssertEqual(world.background.liveTasks, 0)
        XCTAssertEqual(world.timing.live.count, 0)
        XCTAssertEqual(engine.liveTimers, [])
        XCTAssertFalse(engine.isRefreshingNowPlaying)
        XCTAssertFalse(engine.hasGraceTask)
        XCTAssertTrue(world.deck.invalidated)
        XCTAssertFalse(world.deck.isObserved)

        let seen = world.log.entries.count
        world.session.post(.interruptionEnded(shouldResume: true))
        world.background.post(.foreground)
        world.deck.report(.ended(token: world.deck.lastToken ?? 0))
        XCTAssertNil(world.remote.press(.play))
        XCTAssertEqual(engine.handle(.remote(RemotePress(.play))).failures, ["relinquished"])
        XCTAssertEqual(world.log.entries.count, seen, "a seam was touched after teardown: \(world.log.entries.suffix(5))")
    }

    /// A relinquish tears the host down by itself, keeps the session (no
    /// deactivate, no notify: nothing 4a interrupted is invited back), and
    /// leaves Now Playing for the legacy lane. Synthetic notifications
    /// afterwards produce zero engine commands and zero activations.
    /// The host's 1 s Now Playing refresh dies with it: a tick already on
    /// its way writes nothing over the legacy lane's entry.
    /// TO SEE IT FAIL: drop the `.relinquished` check at the end of
    /// `runTurn`, clear Now Playing in `teardown()`, or drop
    /// `cancelSurfaceRefresh()` from it.
    @MainActor
    func testARelinquishTearsDownAndLeavesTheSessionAndNowPlaying() throws {
        let world = FakeWorld()
        let engine = playing(world)
        world.log.clear()
        let written = world.nowPlaying.writes
        XCTAssertGreaterThan(written, 0, "the engine published the playing entry (NE-18)")
        let heartbeat = try XCTUnwrap(world.timing.live.first { $0.afterMs == ForayEngine.nowPlayingRefreshSec * 1000 })

        engine.handle(.command(.relinquish(cap: .foray), source: .tap))

        XCTAssertTrue(engine.isTornDown)
        XCTAssertEqual(engine.state.session, .relinquished)
        XCTAssertEqual(world.session.deactivations, [], "a relinquish never deactivates")
        XCTAssertEqual(world.nowPlaying.writes, written, "nothing written or cleared by the relinquish: the entry is the legacy lane's to overwrite")
        XCTAssertEqual(world.nowPlaying.clears, 0)
        XCTAssertNotNil(world.nowPlaying.last)
        XCTAssertEqual(world.deck.count("pause"), 1, "\(world.log.entries)")
        XCTAssertTrue(world.deck.invalidated)
        XCTAssertEqual(world.session.liveObservers + world.background.liveLifecycleObservers + world.remote.liveTargets, 0)
        XCTAssertEqual(world.timing.live.count + world.background.liveTasks, 0)
        XCTAssertFalse(heartbeat.token.isLive, "the Now Playing refresh is cancelled with the rest")
        world.timing.advance(1000)
        heartbeat.fire()
        XCTAssertEqual(world.nowPlaying.writes, written, "a refresh tick after the relinquish writes nothing")

        let seen = world.log.entries.count
        let activations = world.session.activateCalls
        world.session.post(.interruptionEnded(shouldResume: true))
        world.session.post(.route(RouteChange(oldDeviceUnavailable: false, portType: "CarAudio", portUID: "car-1")))
        world.session.post(.mediaServicesReset)
        XCTAssertEqual(world.session.activateCalls, activations)
        XCTAssertEqual(world.log.entries.count, seen)
    }

    // MARK: - A media-services reset (CH3-03, R2-03)

    /// Media services were reset mid-episode (mediaserverd restarted; CarPlay
    /// and Bluetooth stacks are known triggers). Every AVFoundation object
    /// died with it, so the shell makes its players again: the session owner
    /// forgets its activation, then BOTH decks (the main one and the voice
    /// preview's), the narration voice and the jingle are rebuilt, all before
    /// the core's `.unload` detaches the item. The next press then activates,
    /// loads and plays on the rebuilt deck. Before this, only the session was
    /// "rebuilt": the decks kept their dead `AVPlayer`, and every later load
    /// ran to the 20 s deadline (`stop cause=load-deadline`) until the app was
    /// killed.
    /// TO SEE IT FAIL: drop `seams.deck.rebuild()` (or any of the three
    /// beside it) from the host's `.sessionRebuild` case.
    @MainActor
    func testAMediaServicesResetRebuildsTheShellsPlayers() throws {
        let world = FakeWorld()
        let jingle = FakeInterlude(log: world.log)
        world.interlude = jingle
        world.preview = FakeDeck(log: world.log, name: "preview")
        let engine = playing(world)
        world.log.clear()

        world.session.post(.mediaServicesReset)

        let log = world.log.entries
        // Survives on main: the session is rebuilt and the core detaches the item.
        let rebuilt = try XCTUnwrap(world.log.index(of: "session.rebuild"), "\(log)")
        let unload = try XCTUnwrap(world.log.index(of: "deck.unload"), "\(log)")
        XCTAssertLessThan(rebuilt, unload, "\(log)")
        // RED on main: R2-03 (the host rebuilds nothing but the session).
        let deck = world.log.index(of: "deck.rebuild")
        XCTAssertNotNil(deck, "the deck kept its dead AVPlayer: \(log)")
        if let deck {
            XCTAssertLessThan(rebuilt, deck, "the session first, then the players: \(log)")
            XCTAssertLessThan(deck, unload, "the players are rebuilt before the core's unload: \(log)")
        }
        XCTAssertEqual(world.log.count("deck.rebuild"), 1, "\(log)")
        XCTAssertEqual(world.log.count("preview.rebuild"), 1, "the voice preview's deck died too: \(log)")
        XCTAssertEqual(world.log.count("speaker.rebuild"), 1, "the narration voice's engine died too: \(log)")
        XCTAssertEqual(jingle.releases, 1, "the jingle's cached player died too: \(log)")

        // The next press plays, on the rebuilt deck, from a fresh activation.
        world.log.clear()
        XCTAssertEqual(world.remote.press(.play), .success)
        let after = world.log.entries
        let activate = try XCTUnwrap(world.log.index(of: "session.activate"), "\(after)")
        let load = try XCTUnwrap(world.log.index(of: "deck.load"), "\(after)")
        let play = try XCTUnwrap(world.log.index(of: "deck.play"), "\(after)")
        XCTAssertLessThan(activate, load, "\(after)")
        XCTAssertLessThan(load, play, "\(after)")
        XCTAssertEqual(engine.state.stateType, "playing")
    }

    // MARK: - The narrator's reading (CH3-19, R2-05)

    /// A Foray's spoken line: no `audio_url`, so the synthesizer speaks it.
    static func spokenLine(_ index: Int = 0) -> EngineItem {
        EngineItem(node: .object([
            JSONMember("id", .string("f1#\(index)")), JSONMember("kind", .string("tts")),
            JSONMember("type", .string("narration")), JSONMember("script", .string("a line")),
            JSONMember("audio_url", .null)
        ]))!
    }

    /// The utterance `seq` of the last line the host handed the synthesizer.
    static func spokenSeq(_ speaker: FakeSpeaker) -> Int? {
        speaker.narrated.compactMap { command -> Int? in
            if case let .speak(seq, _, _, _) = command { return seq }
            return nil
        }.last
    }

    /// The Foray tape on, its spoken first line started; the clip after it
    /// is never reached.
    @MainActor
    private func speakingALine(_ world: FakeWorld) throws -> (engine: ForayEngine, seq: Int) {
        world.deck.answersReady = true
        let engine = started(world, config: EngineConfig(build: "test", forayTapeEnabled: true))
        let clip = InterludeSeamTests.clip(1, "b", 300, 400)
        engine.handle(.queue(.loadForay([Self.spokenLine(), clip], isLocalFile: false, allowAdPad: false)))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let seq = try XCTUnwrap(Self.spokenSeq(world.speaker), "no line was spoken: \(world.speaker.narrated)")
        world.speaker.report(.started(seq: seq, voiceFallback: false))
        XCTAssertEqual(engine.state.stateType, "playing", "\(world.log.entries)")
        XCTAssertEqual(engine.state.session, .active)
        return (engine, seq)
    }

    private func stopRows(_ world: FakeWorld, cause: String) -> Int {
        world.output.diags.filter { $0.kind == "stop" && $0[field: "cause"] == .string(cause) }.count
    }

    /// A declined call's late `began` lands while the synthesizer is still
    /// speaking the line: the host now reads the synthesizer before every
    /// input (`EngineNow.narrator`), so the core's late-event rule runs on a
    /// phone as it does in parity: nothing is touched, no stop row, the line
    /// carries on, the session stays the core's. Before CH3-19 the host
    /// passed no reading (`.unknown`), the line was stopped
    /// (`stop cause=interruption`) and the Foray paused until a press.
    /// TO SEE IT FAIL: pass `narrator: .unknown` (or drop the argument) in
    /// `ForayEngine.now()`.
    @MainActor
    func testALateInterruptionDuringASpokenLineTouchesNothing() throws {
        let world = FakeWorld()
        let (engine, seq) = try speakingALine(world)
        world.speaker.reading = .speaking

        world.session.post(.interruptionBegan(reason: "default"))

        // RED on main: R2-05 (the line was stopped: one `stop cause=interruption`,
        // the machine `interrupted`, the session lost, a `pause` to the synthesizer).
        XCTAssertEqual(stopRows(world, cause: "interruption"), 0, "\(world.output.diags)")
        XCTAssertEqual(engine.state.stateType, "playing")
        XCTAssertEqual(engine.state.session, .active)
        XCTAssertFalse(world.speaker.narrated.contains(.pause(seq: seq)), "\(world.speaker.narrated)")
        let late = world.output.diags.filter { $0.kind == "session" && $0[field: "late"] == .string("narration-speaking") }
        XCTAssertEqual(late.count, 1, "the core says why it touched nothing: \(world.output.diags)")
    }

    /// The same `began` when the synthesizer says the line has gone silent
    /// under it (the system took the session and stopped the output): a
    /// real interruption, and the line is stopped as it always was,
    /// resumable by a press or the call's should-resume.
    /// TO SEE IT FAIL: have the core (or the reading) take any line in
    /// flight for a speaking one.
    @MainActor
    func testAnInterruptionThatSilencedTheLineStillStopsIt() throws {
        let world = FakeWorld()
        let (engine, seq) = try speakingALine(world)
        world.speaker.reading = .paused

        world.session.post(.interruptionBegan(reason: "default"))

        XCTAssertEqual(stopRows(world, cause: "interruption"), 1, "\(world.output.diags)")
        XCTAssertEqual(engine.state.stateType, "interrupted")
        XCTAssertEqual(engine.state.session, .lostToInterruption)
        XCTAssertTrue(world.speaker.narrated.contains(.pause(seq: seq)), "\(world.speaker.narrated)")
    }

    /// THE ONE SESSION PHASE (R2-08): the gate every audible start reads
    /// answers the core's `state.session`, never the owner's own phase.
    /// Here the session seam is the recording fake and the owner handed to
    /// `attach` never activates, so only the core can make the gate true:
    /// false before an engine, false idle, true playing, still true after a
    /// `began` the core ruled late, false after one that took the session.
    /// TO SEE IT FAIL: have `EngineSessionGate.isActive` answer
    /// `owner.phase == .active` (or answer before `attach`).
    @MainActor
    func testTheSessionGateAnswersTheCoresPhase() throws {
        let world = FakeWorld()
        world.deck.answersReady = true
        let engine = started(world, config: EngineConfig(build: "test", forayTapeEnabled: true))
        let gate = EngineSessionGate()
        XCTAssertFalse(gate.isActive, "no engine, nothing audible")
        let idleOwner = AudioSessionOwner(api: FakeSessionAPI(), center: NotificationCenter(),
                                          config: AudioSessionOwner.Config(diag: { _ in }))
        gate.attach(engine, owner: idleOwner)
        XCTAssertFalse(gate.isActive, "the core has activated nothing")

        engine.handle(.queue(.loadForay([Self.spokenLine(), InterludeSeamTests.clip(1, "b", 300, 400)],
                                        isLocalFile: false, allowAdPad: false)))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let seq = try XCTUnwrap(Self.spokenSeq(world.speaker))
        world.speaker.report(.started(seq: seq, voiceFallback: false))
        XCTAssertEqual(idleOwner.phase, .inactive)
        XCTAssertTrue(gate.isActive, "the core holds the session")

        world.speaker.reading = .speaking
        world.session.post(.interruptionBegan(reason: "default"))
        XCTAssertTrue(gate.isActive, "a began the core ruled late leaves its session active")
        XCTAssertTrue(idleOwner.engineHoldsSession?() ?? false, "the owner asks the same gate")

        world.speaker.reading = .paused
        world.session.post(.interruptionBegan(reason: "default"))
        XCTAssertEqual(engine.state.session, .lostToInterruption)
        XCTAssertFalse(gate.isActive)
        XCTAssertFalse(idleOwner.engineHoldsSession?() ?? true)
    }

    // MARK: - BackgroundGrace

    /// The system takes the grace time back while the engine is still
    /// silent (a background tap play whose load has not landed). UIKit's
    /// rule: the task ends INSIDE the expiration handler, even when the
    /// handler lands while a turn is being interpreted (the core hears it
    /// only after that turn). Then the core's deterministic outcome: the
    /// intent stops, with its cause row, and nothing ever sounds.
    ///
    /// (An expiry while the deck is AUDIBLE never reaches the core as a stop:
    /// the core closes grace itself on the first turn that finds the deck
    /// audible, so the queued expiry finds no span. ios-kit run 36053713800
    /// showed exactly that when this test first played the deck.)
    /// TO SEE IT FAIL: drop `endGrace()` at the top of `graceExpired` (the
    /// task then outlives its handler), or register a no-op expiration.
    @MainActor
    func testAnExpiredGraceTaskEndsInsideItsHandlerAndStopsTheIntent() throws {
        let world = FakeWorld()
        let engine = started(world)
        world.background.post(.background)
        engine.handle(.queue(.load([Self.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(engine.state.stateType, "loadingItem", "\(world.log.entries)")
        let task = try XCTUnwrap(world.background.onlyLiveTask)
        var endedInside: Bool?
        world.output.onDiag = { entry in
            guard entry.kind == "remote", endedInside == nil else { return }
            endedInside = world.background.expire(task)
        }

        _ = world.remote.press(.skipForward)

        XCTAssertEqual(endedInside, true, "the task outlived its expiration handler")
        XCTAssertEqual(world.background.ended, [task], "ended exactly once")
        XCTAssertEqual(world.background.liveTasks, 0)
        XCTAssertFalse(engine.hasGraceTask)
        XCTAssertTrue(world.output.diags.contains { $0.kind == "stop" && $0[field: "cause"] == .string("grace-expired") },
                      "\(world.log.entries)")
        XCTAssertFalse(engine.state.isRunning)
        XCTAssertEqual(world.deck.count("play"), 0)
    }

    /// A refused begin (`.invalid`) and the remaining background budget are
    /// written to the `grace` row, and nothing is ever ended for it.
    /// TO SEE IT FAIL: drop the `grace` row, or end a nil task.
    @MainActor
    func testARefusedGraceTaskIsWrittenToTheRow() throws {
        let world = FakeWorld()
        world.background.refuse = true
        world.background.backgroundTimeRemainingSec = 2.5
        let engine = playing(world, backgrounded: true)
        let row = try XCTUnwrap(world.output.diags.first { $0.kind == "grace" })
        XCTAssertEqual(row[field: "kind"], .string("begin"))
        XCTAssertEqual(row[field: "reason"], .string("background-tap"))
        XCTAssertEqual(row[field: "task"], .string("invalid"))
        XCTAssertEqual(row[field: "bgRemainingMs"], .number(2500))
        XCTAssertFalse(engine.hasGraceTask)
        let token = try XCTUnwrap(world.deck.lastToken)
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertEqual(world.background.ended, [])
    }

    // MARK: - Remote targets

    /// Plan §4.5 (T-7): every command gets a target; `stop` is registered AND
    /// disabled, because a car's stop must never tear the player down. With
    /// nothing to act on every command is disabled (NE-18:
    /// `commandAvailability` of `mode: none`); a restored item enables all but
    /// `stop`, which stays disabled.
    /// TO SEE IT FAIL: enable `stop`, or skip registering it.
    @MainActor
    func testEveryRemoteCommandIsRegisteredAndStopIsDisabled() {
        let world = FakeWorld()
        // A car route, so the track pair is enabled with the rest (CH3-10:
        // on the speaker it stays off, RemoteSurfaceTests).
        world.session.route = RoutePort(portType: "CarAudio", uid: nil)
        let engine = started(world)
        for command in MediaMapping.RemoteCommand.allCases {
            XCTAssertEqual(world.remote.liveTargets(for: command), 1, "\(command)")
            XCTAssertEqual(world.remote.enabled[command], false, "\(command)")
        }
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a"), Self.item("b")], index: 0, autoplay: false)))
        for command in MediaMapping.RemoteCommand.allCases {
            XCTAssertEqual(world.remote.enabled[command], command != .stop, "\(command)")
        }
    }

    /// `not-loaded` is "nothing to play" to the system, not a failure.
    /// TO SEE IT FAIL: map every refusal to `.commandFailed`.
    @MainActor
    func testARemotePlayWithNothingToPlayIsNoActionableItem() {
        let world = FakeWorld()
        // Held: the remote targets hold the engine weakly (it is the process
        // singleton), so a dropped engine answers every press `.commandFailed`.
        let engine = started(world)
        XCTAssertEqual(world.remote.press(.play), .noActionableNowPlayingItem)
        withExtendedLifetime(engine) {}
        XCTAssertEqual(RemoteVerdict(failures: []), .success)
        XCTAssertEqual(RemoteVerdict(failures: ["no-next"]), .commandFailed)
    }

    // MARK: - The lifecycle flush (NE-19)

    /// Backgrounding writes the playhead (the core's flush) and THEN asks the
    /// store to make it durable, inside the one notification handler; coming
    /// back to the foreground flushes nothing.
    /// TO SEE IT FAIL: drop the `seams.output.flush()` line in `lifecycle`,
    /// or call it before `handle`.
    @MainActor
    func testBackgroundWritesThePlayheadThenFlushesTheStore() throws {
        let world = FakeWorld()
        let engine = playing(world)
        world.deck.reading.positionSec = 42
        world.log.clear()
        world.background.post(.background)
        let position = try XCTUnwrap(world.log.index(of: "output.position"), "\(world.log.entries)")
        let flush = try XCTUnwrap(world.log.index(of: "output.flush"), "\(world.log.entries)")
        XCTAssertLessThan(position, flush, "the flush makes the NEW row durable")
        XCTAssertEqual(world.output.positions.last?.seconds, 42)

        world.log.clear()
        world.background.post(.foreground)
        XCTAssertEqual(world.log.count("output.flush"), 0)
        engine.teardown()
    }

    // MARK: - The surface is told after every input (NE-39s)

    /// queue-manager.js "ROUND 2 player-1: onStateSettled fires after EVERY
    /// handled event, with the settled state": the page used to repaint only
    /// on media events, and an episode's natural end moves the machine to
    /// `ended` with no media event after it. The JS fixture counts the hook
    /// per `_handle` frame, which follows the manager's awaits (the jsOnly
    /// `manager-await` family); natively the bridge re-reads the snapshot on
    /// `onTransition`, which runs after EVERY input the host handled to the
    /// end, the deck's own reports included, with the state it settled.
    /// TO SEE IT FAIL: call `onTransition` only for commands, or before the
    /// turn runs (the state read is then the one before the end).
    @MainActor
    func testTheSurfaceIsToldAfterEveryInputTheNaturalEndIncluded() throws {
        let world = FakeWorld()
        let engine = playing(world)
        var seen: [String] = []
        engine.onTransition = { [unowned engine] in seen.append(engine.state.stateType) }
        let token = try XCTUnwrap(world.deck.lastToken)

        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertEqual(seen, ["playing"], "the deck's own report is an input too")

        world.deck.reading.audible = false
        world.deck.reading.ended = true
        world.deck.report(.ended(token: token))
        XCTAssertEqual(seen, ["playing", "ended"], "the end, which no media event follows, is told too, as `ended`")
        withExtendedLifetime(engine) {}
    }

    // MARK: - Timers

    /// The position cadence is armed while playing and fires through the core
    /// (a `cp_pos` write at the deck's playhead); a pause cancels it.
    /// TO SEE IT FAIL: ignore `.timerArm`, or `.timerCancel`.
    @MainActor
    func testThePositionTimerRunsExactlyWhilePlaying() throws {
        let world = FakeWorld()
        let engine = playing(world)
        let tick = try XCTUnwrap(world.timing.live.first { $0.afterMs == ResumeRules.positionIntervalMs })
        XCTAssertTrue(tick.repeating)
        XCTAssertEqual(tick.afterMs, ResumeRules.positionIntervalMs)

        world.deck.reading.positionSec = 120
        world.timing.fire(afterMs: ResumeRules.positionIntervalMs)
        XCTAssertEqual(world.output.positions.last?.seconds, 120)

        engine.handle(.command(.pause, source: .tap))
        XCTAssertEqual(world.timing.live.count, 0)
        XCTAssertEqual(engine.liveTimers, [])
    }

    /// A one-shot (the hold release under `until:<m>`) fires once through the
    /// core and leaves nothing registered.
    /// TO SEE IT FAIL: drop the one-shot cancel in `timerFired`.
    @MainActor
    func testAOneShotTimerFiresOnceAndIsReleased() {
        let world = FakeWorld()
        let engine = playing(world, config: EngineConfig(build: "test", holdPolicy: .until(minutes: 1)))
        engine.handle(.command(.pause, source: .tap))
        XCTAssertEqual(engine.liveTimers, [.holdExpired])
        XCTAssertEqual(world.session.deactivations, [])

        world.timing.fire(afterMs: 60_000)

        XCTAssertEqual(world.session.deactivations, [false], "the hold ran out: release, no notify")
        XCTAssertEqual(engine.liveTimers, [])
        XCTAssertEqual(world.timing.live.count, 0)
    }

    // MARK: - Off-main results

    /// A result computed off main comes back as an input on main, on a later
    /// turn. TO SEE IT FAIL: call `handle` straight from `post(fromAnyThread:)`
    /// (the main-actor assertion traps on the background queue).
    @MainActor
    func testAnOffMainResultComesBackAsAnInputOnMain() {
        let world = FakeWorld()
        let engine = started(world)
        let posted = expectation(description: "posted from a background queue")
        DispatchQueue.global().async {
            engine.post(fromAnyThread: .lifecycle(.background))
            posted.fulfill()
        }
        wait(for: [posted], timeout: 5)
        let until = Date().addingTimeInterval(5)
        while !engine.state.backgrounded, Date() < until {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertTrue(engine.state.backgrounded)
    }

    // MARK: - One per process

    /// Whichever boot path runs first builds the engine; the other gets the
    /// same one, and no second set of remote targets is registered.
    /// TO SEE IT FAIL: drop the `if let shared` return in `boot`.
    @MainActor
    func testBootBuildsOneEnginePerProcess() {
        let first = FakeWorld()
        let second = FakeWorld()
        let a = ForayEngine.boot(seams: first.seams, config: EngineConfig(build: "test"))
        let b = ForayEngine.boot(seams: second.seams, config: EngineConfig(build: "test"))
        XCTAssertTrue(a === b)
        XCTAssertTrue(ForayEngine.shared === a)
        XCTAssertEqual(first.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        XCTAssertEqual(second.remote.liveTargets, 0)
        a.teardown()
    }
}

/// The real timing seam: `DispatchSourceTimer`s on the main queue.
final class MainQueueTimingTests: XCTestCase {
    private func spin(until done: () -> Bool, timeout: TimeInterval = 5) {
        let until = Date().addingTimeInterval(timeout)
        while !done(), Date() < until {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    /// A one-shot fires once, on main; a repeating timer keeps firing until
    /// it is cancelled, and never after.
    /// TO SEE IT FAIL: make the source's queue a global one, or schedule the
    /// one-shot with `repeating: interval`.
    func testTimersFireOnMainAndStopWhenCancelled() {
        let timing = MainQueueTiming(leeway: .milliseconds(1))
        var once = 0
        var onMain = true
        let oneShot = timing.schedule(afterMs: 20, repeating: false) {
            once += 1
            onMain = onMain && Thread.isMainThread
        }
        var ticks = 0
        let repeating = timing.schedule(afterMs: 20, repeating: true) {
            ticks += 1
            onMain = onMain && Thread.isMainThread
        }
        spin(until: { ticks >= 3 })
        XCTAssertGreaterThanOrEqual(ticks, 3)
        XCTAssertEqual(once, 1)
        XCTAssertTrue(onMain)

        repeating.cancel()
        let atCancel = ticks
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        XCTAssertEqual(ticks, atCancel, "a cancelled timer fired")
        oneShot.cancel()
        XCTAssertEqual(once, 1)
    }

    func testTheMonotonicClockAdvances() {
        let timing = MainQueueTiming()
        let before = timing.monoMs
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertGreaterThan(timing.monoMs, before)
        XCTAssertGreaterThan(timing.wallMs, 1_700_000_000_000)
    }
}

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
    /// is gone, the deck is invalidated, and nothing that fires afterwards
    /// reaches a seam.
    /// TO SEE IT FAIL: skip any line of `teardown()` (the matching count
    /// stays at one), or its `isTornDown` refusal in `handle`.
    @MainActor
    func testTeardownLeavesZeroLiveObservers() {
        let world = FakeWorld()
        let engine = playing(world, backgrounded: true)
        XCTAssertTrue(engine.state.backgrounded, "the lifecycle observer did not deliver")
        XCTAssertEqual(world.session.liveObservers, 1)
        XCTAssertEqual(world.background.liveLifecycleObservers, 1)
        XCTAssertEqual(world.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        XCTAssertEqual(world.background.liveTasks, 1, "a background tap play holds grace until the deck confirms")
        XCTAssertEqual(world.timing.live.count, 1, "the position cadence runs while playing")
        XCTAssertEqual(engine.liveTimers, [.positionTick])
        XCTAssertTrue(world.deck.isObserved)

        engine.teardown()

        XCTAssertEqual(world.session.liveObservers, 0)
        XCTAssertEqual(world.background.liveLifecycleObservers, 0)
        XCTAssertEqual(world.remote.liveTargets, 0)
        XCTAssertEqual(world.background.liveTasks, 0)
        XCTAssertEqual(world.timing.live.count, 0)
        XCTAssertEqual(engine.liveTimers, [])
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
    /// TO SEE IT FAIL: drop the `.relinquished` check at the end of
    /// `runTurn`, or clear Now Playing in `teardown()`.
    @MainActor
    func testARelinquishTearsDownAndLeavesTheSessionAndNowPlaying() {
        let world = FakeWorld()
        let engine = playing(world)
        world.log.clear()

        engine.handle(.command(.relinquish(cap: .foray), source: .tap))

        XCTAssertTrue(engine.isTornDown)
        XCTAssertEqual(engine.state.session, .relinquished)
        XCTAssertEqual(world.session.deactivations, [], "a relinquish never deactivates")
        XCTAssertEqual(world.nowPlaying.writes + world.nowPlaying.clears, 0)
        XCTAssertEqual(world.deck.count("pause"), 1, "\(world.log.entries)")
        XCTAssertTrue(world.deck.invalidated)
        XCTAssertEqual(world.session.liveObservers + world.background.liveLifecycleObservers + world.remote.liveTargets, 0)
        XCTAssertEqual(world.timing.live.count + world.background.liveTasks, 0)

        let seen = world.log.entries.count
        let activations = world.session.activateCalls
        world.session.post(.interruptionEnded(shouldResume: true))
        world.session.post(.route(RouteChange(oldDeviceUnavailable: false, routeName: "Car", isCarRoute: true)))
        world.session.post(.mediaServicesReset)
        XCTAssertEqual(world.session.activateCalls, activations)
        XCTAssertEqual(world.log.entries.count, seen)
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
    /// disabled, because a car's stop must never tear the player down.
    /// TO SEE IT FAIL: enable `stop`, or skip registering it.
    @MainActor
    func testEveryRemoteCommandIsRegisteredAndStopIsDisabled() {
        let world = FakeWorld()
        _ = started(world)
        for command in MediaMapping.RemoteCommand.allCases {
            XCTAssertEqual(world.remote.liveTargets(for: command), 1, "\(command)")
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

    // MARK: - Timers

    /// The position cadence is armed while playing and fires through the core
    /// (a `cp_pos` write at the deck's playhead); a pause cancels it.
    /// TO SEE IT FAIL: ignore `.timerArm`, or `.timerCancel`.
    @MainActor
    func testThePositionTimerRunsExactlyWhilePlaying() throws {
        let world = FakeWorld()
        let engine = playing(world)
        let tick = try XCTUnwrap(world.timing.live.first)
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

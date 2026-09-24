import XCTest
import UIKit
import ForayEngineCore
@testable import ForayAudioPlugin

/// UIKit's background-task calls, recorded: what `BackgroundGrace` (the real
/// `BackgroundTasking`, card NE-16g) was asked, and which tasks are still
/// open. A package test has no app, so `UIApplication.shared` is not there to
/// ask; this is the part of it the conformer touches.
final class FakeBackgroundTaskAPI: BackgroundTaskAPI {
    /// Answer every begin with `.invalid`.
    var refuse = false
    var backgroundTimeRemainingSec: Double?
    private var nextId = 100
    private(set) var begun: [String] = []
    private(set) var handlers: [Int: () -> Void] = [:]
    private(set) var ends: [Int] = []

    func beginBackgroundTask(named name: String, expiration: @escaping () -> Void) -> Int? {
        begun.append(name)
        guard !refuse else { return nil }
        nextId += 1
        handlers[nextId] = expiration
        return nextId
    }

    func endBackgroundTask(_ raw: Int) {
        ends.append(raw)
    }

    /// Tasks begun and not yet ended: what UIKit would still be counting.
    var open: [Int] { handlers.keys.filter { !ends.contains($0) }.sorted() }

    /// UIKit calling a handler late, for a task already ended (it should
    /// not, but the conformer must not act on it if it does).
    func fireHandlerAnyway(_ raw: Int) {
        handlers[raw]?()
    }

    /// The system takes the time back: runs UIKit's expiration handler and
    /// answers whether the task was ended before the handler returned (the
    /// rule UIKit kills the app for breaking).
    @discardableResult
    func expire(_ raw: Int) -> Bool {
        guard let handler = handlers[raw], !ends.contains(raw) else { return false }
        handler()
        return ends.contains(raw)
    }
}

/// Card NE-16g's acceptance (docs/native-engine-plan.md §4.4 and §14):
/// begin and end counts match across the remote-play, interruption-resume
/// and cold-play scenarios; the expiry path pauses with a cause row; no task
/// leaks after teardown; and the real conformer's own rules (every task ends
/// inside its expiration handler, and ends once) over a fake of UIKit.
///
/// Executed headless on the Simulator by `ci.yml`'s ios-kit (`xcodebuild test
/// -scheme ForayAudio`). Each test names the edit that turns it red.
final class BackgroundGraceTests: XCTestCase {

    static func item(_ id: String) -> EngineItem { ForayEngineHostTests.item(id) }

    @MainActor
    private func started(_ world: FakeWorld) -> ForayEngine {
        world.deck.answersReady = true
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()
        return engine
    }

    /// The deck confirms `timeControlStatus == .playing` for its last load.
    private func confirmPlaying(_ world: FakeWorld, file: StaticString = #filePath, line: UInt = #line) {
        guard let token = world.deck.lastToken else { return XCTFail("nothing was loaded", file: file, line: line) }
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
    }

    private func spin(until done: () -> Bool) {
        let until = Date().addingTimeInterval(5)
        while !done(), Date() < until {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    private func graceRows(_ world: FakeWorld, _ kind: String) -> [DiagEntry] {
        world.output.diags.filter { $0.kind == "grace" && $0[field: "kind"] == .string(kind) }
    }

    /// Every task begun was ended exactly once, and none is open.
    private func assertBalanced(_ world: FakeWorld, begins expected: Int, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        let begins = world.log.count("background.begin", prefix: true)
        XCTAssertEqual(begins, expected, "\(what): begins \(world.log.entries)", file: file, line: line)
        XCTAssertEqual(world.background.ended.count, begins, "\(what): every begin has one end", file: file, line: line)
        XCTAssertEqual(Set(world.background.ended).count, world.background.ended.count, "\(what): a task ended twice",
                       file: file, line: line)
        XCTAssertEqual(world.background.liveTasks, 0, "\(what): a task is still open", file: file, line: line)
    }

    // MARK: - Begin and end counts match, scenario by scenario

    /// A car's play on a restored, backgrounded engine: one task from the
    /// press, ended on the first confirmed `.playing`, with an `end` row that
    /// says how long the silent span was held.
    /// TO SEE IT FAIL: ignore `.graceEnd` in the host's `interpret` (the task
    /// stays open), or begin a task per `.graceBegin` without ending a stale one.
    @MainActor
    func testARemotePlayBeginsOneTaskAndEndsItOnPlaying() {
        let world = FakeWorld()
        world.background.backgroundTimeRemainingSec = 29
        let engine = started(world)
        world.background.post(.background)
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))

        XCTAssertEqual(world.remote.press(.play), .success)
        XCTAssertEqual(world.background.liveTasks, 1, "the span is held until the deck confirms sound")
        world.timing.advance(640)
        confirmPlaying(world)

        assertBalanced(world, begins: 1, "remote play")
        let end = graceRows(world, "end")
        XCTAssertEqual(end.count, 1)
        XCTAssertEqual(end.first?[field: "outcome"], .string("playing"))
        XCTAssertEqual(end.first?[field: "reason"], .string("remote-play"))
        XCTAssertEqual(end.first?[field: "heldMs"], .number(640), "the press-to-sound latency the M1 drive reads")
        let remote = world.output.diags.first { $0.kind == "remote" }
        XCTAssertEqual(remote?[field: "grace"], .string("y"))
        XCTAssertEqual(remote?[field: "bgRemainingMs"], .number(29_000), "the host reads the budget into every input")
    }

    /// A call ends with should-resume while the app is in the background: one
    /// task for the resume, ended when the deck plays again, and the `resume`
    /// row carries the budget. Two interruptions, two balanced spans.
    /// TO SEE IT FAIL: drop the core's `beginGrace(.interruptionResume)` in
    /// the activation branch of `onInterruptionEnded` (no begin), or the
    /// host's `endGrace` on `.graceEnd` (an open task).
    @MainActor
    func testInterruptionResumesBalanceTheirTasks() {
        let world = FakeWorld()
        world.background.backgroundTimeRemainingSec = 24.5
        let engine = started(world)
        world.background.post(.background)
        engine.handle(.queue(.load([Self.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        confirmPlaying(world)
        assertBalanced(world, begins: 1, "the background tap play")

        for round in 1...2 {
            world.session.post(.interruptionBegan(reason: "default"))
            XCTAssertEqual(engine.state.session, .lostToInterruption)
            world.session.post(.interruptionEnded(shouldResume: true))
            XCTAssertEqual(world.background.liveTasks, 1, "round \(round): the resume holds grace")
            confirmPlaying(world)
            assertBalanced(world, begins: 1 + round, "interruption resume \(round)")
        }
        let resumes = world.output.diags.filter { $0.kind == "resume" }
        XCTAssertEqual(resumes.count, 2)
        XCTAssertTrue(resumes.allSatisfy { $0[field: "grace"] == .string("y") && $0[field: "bgRemainingMs"] == .number(24_500) },
                      "\(resumes)")
        XCTAssertEqual(world.session.activateCalls, 3, "the first play and each resume activate once")
    }

    /// A cold play (plan §4.5: a car's play after iOS ended the process):
    /// one task, the `cold-play` row, ended on playing. And a cold play the
    /// session refuses closes its span at once: nothing is held for a play
    /// that cannot happen.
    /// TO SEE IT FAIL: end grace only on `.playing` (the refused play's task
    /// stays open), or drop `spanRow` for `.coldPlay` (no row).
    @MainActor
    func testAColdPlayBalancesItsTaskAndARefusedOneHoldsNothing() {
        let world = FakeWorld()
        world.background.backgroundTimeRemainingSec = 30
        let engine = started(world)
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: true)))
        XCTAssertNotNil(world.log.index(of: "background.begin ForayEngine.grace.cold-play"), "\(world.log.entries)")
        confirmPlaying(world)
        assertBalanced(world, begins: 1, "cold play")
        XCTAssertEqual(world.output.diags.first { $0.kind == "cold-play" }?[field: "grace"], .string("y"))

        let refused = FakeWorld()
        refused.session.answer = SessionActivation(ok: false, error: "cannot-start-playing", activateMs: 3)
        let other = started(refused)
        other.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: true)))
        assertBalanced(refused, begins: 1, "refused cold play")
        XCTAssertEqual(graceRows(refused, "end").first?[field: "outcome"], .string("not-running"))
        XCTAssertEqual(refused.deck.count("play"), 0)
    }

    // MARK: - Expiry

    /// The system takes the time back before the load lands, outside any
    /// turn: the task ends inside the handler, `grace kind=expired` is
    /// written, and the core pauses with `stop cause=grace-expired`; a load
    /// that lands afterwards plays nothing, and nothing is left open.
    /// TO SEE IT FAIL: make the host's expiry feed the core without ending
    /// the task first, drop its `grace kind=expired` row, or have the core
    /// ignore `.timer(.graceExpired)`.
    @MainActor
    func testTheExpiryPathPausesWithACauseRow() throws {
        let world = FakeWorld()
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()
        world.background.post(.background)
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))
        XCTAssertEqual(world.remote.press(.play), .success)
        XCTAssertEqual(engine.state.stateType, "loadingItem", "the load has not landed: \(world.log.entries)")
        let task = try XCTUnwrap(world.background.onlyLiveTask)
        world.timing.advance(29_000)

        XCTAssertTrue(world.background.expire(task), "the task outlived its expiration handler")

        let expired = try XCTUnwrap(graceRows(world, "expired").first, "\(world.output.diags)")
        XCTAssertEqual(expired[field: "reason"], .string("remote-play"))
        XCTAssertEqual(expired[field: "heldMs"], .number(29_000))
        let expiredAt = try XCTUnwrap(world.output.diags.firstIndex { $0.kind == "grace" && $0[field: "kind"] == .string("expired") })
        let stopAt = try XCTUnwrap(world.output.diags.firstIndex { $0.kind == "stop" && $0[field: "cause"] == .string("grace-expired") },
                                   "\(world.output.diags)")
        XCTAssertLessThan(expiredAt, stopAt, "the task is ended and written before the core hears of it")
        XCTAssertEqual(graceRows(world, "end").count, 0, "one row per span: the core's own end finds nothing to write")
        XCTAssertFalse(engine.state.isRunning)
        XCTAssertNil(engine.state.grace)
        assertBalanced(world, begins: 1, "expired span")

        world.deck.report(.ready(token: world.deck.lastToken ?? 0, landedSec: 0, prerolled: true, elapsedMs: 30_000))
        XCTAssertEqual(world.deck.count("play"), 0, "a load landing after the expiry plays nothing")
    }

    // MARK: - Teardown

    /// A relinquish (or any teardown) in the middle of a silent span ends the
    /// task: no background time outlives the engine that asked for it.
    /// TO SEE IT FAIL: drop the grace-task lines from `teardown()`.
    @MainActor
    func testNoTaskLeaksAfterTeardown() {
        let world = FakeWorld()
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()
        world.background.post(.background)
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))
        _ = world.remote.press(.play)
        XCTAssertEqual(world.background.liveTasks, 1)

        engine.teardown()

        assertBalanced(world, begins: 1, "teardown")
        XCTAssertFalse(engine.hasGraceTask)
    }

    // MARK: - The real conformer over a fake of UIKit

    /// The host driving the REAL BackgroundGrace: a background remote play
    /// opens one UIKit task, the deck's `.playing` ends it, a second play's
    /// span is torn down with the engine, and nothing is left open in UIKit.
    /// TO SEE IT FAIL: make `endTask` a no-op, or begin with no handler.
    @MainActor
    func testTheHostOverTheRealConformerLeavesNoTaskOpen() {
        let world = FakeWorld()
        let uikit = FakeBackgroundTaskAPI()
        uikit.backgroundTimeRemainingSec = 28
        let center = NotificationCenter()
        let grace = BackgroundGrace(api: uikit, center: center)
        var seams = world.seams
        seams.background = grace
        world.deck.answersReady = true
        let engine = ForayEngine(seams: seams, config: EngineConfig(build: "test"))
        engine.start()

        center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        spin(until: { engine.state.backgrounded })
        XCTAssertTrue(engine.state.backgrounded, "the lifecycle observer did not deliver")
        engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))
        XCTAssertEqual(world.remote.press(.play), .success)
        XCTAssertEqual(uikit.begun, ["ForayEngine.grace.remote-play"])
        XCTAssertEqual(uikit.open.count, 1)
        XCTAssertEqual(world.output.diags.first { $0.kind == "remote" }?[field: "bgRemainingMs"], .number(28_000))
        confirmPlaying(world)
        XCTAssertEqual(uikit.open, [])

        engine.handle(.command(.pause, source: .tap))
        XCTAssertEqual(world.remote.press(.play), .success)
        XCTAssertEqual(uikit.open.count, 1)
        engine.teardown()
        XCTAssertEqual(uikit.open, [], "teardown left a UIKit task open")
        XCTAssertEqual(Set(uikit.ends).count, uikit.ends.count, "a task was ended twice")
        XCTAssertEqual(grace.liveTaskCount, 0)

        center.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertTrue(engine.state.backgrounded, "the lifecycle observer outlived teardown")
    }

    /// UIKit's rule, enforced by the conformer itself: when the system takes
    /// the time back, the task is ended before the handler returns, whether
    /// the handler it was given ended it or not, and exactly once.
    /// TO SEE IT FAIL: drop the backstop `endTask(id)` in `expired`, or the
    /// `live.remove` guard in `endTask`.
    func testAnExpiredTaskEndsInsideItsHandlerOnceWhateverTheHandlerDid() throws {
        let uikit = FakeBackgroundTaskAPI()
        let grace = BackgroundGrace(api: uikit, center: NotificationCenter())

        // A handler that forgets to end its task.
        var forgetful = 0
        let first = try XCTUnwrap(grace.beginTask(named: "forgetful") { forgetful += 1 })
        XCTAssertTrue(uikit.expire(first), "the task outlived its expiration handler")
        XCTAssertEqual(forgetful, 1)
        XCTAssertEqual(uikit.ends, [first])

        // A handler that ends it itself, as the host's does: still one end.
        var second: BackgroundTaskID?
        second = grace.beginTask(named: "tidy") { grace.endTask(second!) }
        let tidy = try XCTUnwrap(second)
        XCTAssertTrue(uikit.expire(tidy))
        XCTAssertEqual(uikit.ends, [first, tidy], "ended exactly once")

        // An ended task's handler never runs, and ending again is a no-op.
        var late = 0
        let third = try XCTUnwrap(grace.beginTask(named: "ended") { late += 1 })
        grace.endTask(third)
        grace.endTask(third)
        uikit.fireHandlerAnyway(third)
        XCTAssertEqual(late, 0, "the handler of an ended task ran")
        XCTAssertEqual(uikit.ends, [first, tidy, third])
        XCTAssertEqual(grace.liveTaskCount, 0)
        XCTAssertEqual(uikit.open, [])
    }

    /// The engine is gone when the system takes the time back: nobody can
    /// end the task, so the conformer's handler ends it itself.
    /// TO SEE IT FAIL: drop the `guard let self else` branch's end.
    func testAnExpiryAfterTheOwnerIsGoneStillEndsTheTask() throws {
        let uikit = FakeBackgroundTaskAPI()
        var grace: BackgroundGrace? = BackgroundGrace(api: uikit, center: NotificationCenter())
        let task = try XCTUnwrap(grace?.beginTask(named: "orphan") {})
        grace = nil
        XCTAssertTrue(uikit.expire(task), "an orphaned task outlived its handler")
        XCTAssertEqual(uikit.ends, [task])
    }

    /// `.invalid` is nil to the host, holds nothing and is never ended; the
    /// budget is UIKit's, passed through.
    /// TO SEE IT FAIL: return the invalid identifier as a task, or record it
    /// as live.
    func testARefusedBeginIsNilAndNeverEnded() {
        let uikit = FakeBackgroundTaskAPI()
        uikit.refuse = true
        uikit.backgroundTimeRemainingSec = 1.5
        let grace = BackgroundGrace(api: uikit, center: NotificationCenter())
        XCTAssertNil(grace.beginTask(named: "refused") {})
        XCTAssertEqual(grace.liveTaskCount, 0)
        XCTAssertEqual(uikit.ends, [])
        XCTAssertEqual(grace.backgroundTimeRemainingSec, 1.5)
    }

    /// A small budget at a begin is written as `low=y` next to the refusal
    /// (plan §4.4), and a comfortable one as `low=n`.
    /// TO SEE IT FAIL: drop the `low` field from the host's begin row.
    @MainActor
    func testASmallBudgetIsWrittenAsLow() throws {
        for (remaining, low) in [(2.5, "y"), (29.0, "n")] {
            let world = FakeWorld()
            world.background.backgroundTimeRemainingSec = remaining
            let engine = started(world)
            world.background.post(.background)
            engine.handle(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))
            _ = world.remote.press(.play)
            let begin = try XCTUnwrap(graceRows(world, "begin").first)
            XCTAssertEqual(begin[field: "low"], .string(low), "\(remaining) s")
            XCTAssertEqual(begin[field: "bgRemainingMs"], .number(remaining * 1000))
        }
    }

    /// The lifecycle arrives on main, as `.background` / `.foreground`, and
    /// stops at cancel.
    /// TO SEE IT FAIL: observe with `queue: nil`, or skip `removeObserver`.
    func testLifecycleNotificationsArriveOnMainUntilCancelled() {
        let center = NotificationCenter()
        let grace = BackgroundGrace(api: FakeBackgroundTaskAPI(), center: center)
        var events: [LifecycleEvent] = []
        var onMain = true
        let observation = grace.observeLifecycle { event in
            events.append(event)
            onMain = onMain && Thread.isMainThread
        }
        let posted = expectation(description: "posted off main")
        DispatchQueue.global().async {
            center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
            posted.fulfill()
        }
        wait(for: [posted], timeout: 5)
        spin(until: { !events.isEmpty })
        center.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        spin(until: { events.count >= 2 })
        XCTAssertEqual(events, [.background, .foreground])
        XCTAssertTrue(onMain, "a lifecycle event arrived off main")

        observation.cancel()
        center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(events, [.background, .foreground], "an event after cancel")
    }
}

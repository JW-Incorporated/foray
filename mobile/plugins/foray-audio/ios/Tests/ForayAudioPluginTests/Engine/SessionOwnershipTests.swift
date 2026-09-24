import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// Card NE-16's acceptance over the recording fakes (docs/native-engine-plan.md
/// §4.4, §14): the host, the core and the session seam together, driven the
/// way a drive drives them, with every `setActive` a count on `FakeSession`.
///
///   - no activation at launch or at a restored bar (S-3);
///   - no deactivate on a pause or a trip to the background under `.forever`
///     (S-4 as written; the default);
///   - `.until(m)` releases WITHOUT notify when the hold runs out, and `none`
///     at the pause itself (the H-1b arm); only a close notifies;
///   - a late `appWasSuspended` while running, after this process activated,
///     is a `stale` row and changes nothing; a muted built-in mic changes
///     nothing; a real interruption takes the session;
///   - `setHoldPolicy` lands in the private key, and the key is read back at
///     the next construction.
///
/// Each test names the edit that turns it red.
final class SessionOwnershipTests: XCTestCase {

    @MainActor
    private func started(_ world: FakeWorld, holdPolicy: SessionPolicy.HoldPolicy = .forever) -> ForayEngine {
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test", holdPolicy: holdPolicy))
        engine.start()
        return engine
    }

    /// Playing "a", confirmed audible by the deck.
    @MainActor
    private func playing(_ world: FakeWorld, holdPolicy: SessionPolicy.HoldPolicy = .forever) throws -> ForayEngine {
        world.deck.answersReady = true
        let engine = started(world, holdPolicy: holdPolicy)
        engine.handle(.queue(.load([ForayEngineHostTests.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let token = try XCTUnwrap(world.deck.lastToken)
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertEqual(engine.state.stateType, "playing", "\(world.log.entries)")
        XCTAssertEqual(engine.state.session, .active)
        XCTAssertEqual(world.session.activateCalls, 1)
        return engine
    }

    private func sessionRows(_ world: FakeWorld, _ kind: String) -> [DiagEntry] {
        world.output.diags.filter { $0.kind == "session" && $0[field: "kind"] == .string(kind) }
    }

    // MARK: - Activation only on a user-caused play

    /// S-3: a launch that restores a bar paints it; nothing activates.
    /// TO SEE IT FAIL: make the core's cold launch or `.restoreBar` begin a
    /// play (`begin(.coldPlay, ...)` regardless of `autoplay`).
    @MainActor
    func testNoActivationAtLaunchOrRestoreBar() {
        let world = FakeWorld()
        let engine = started(world)
        engine.handle(.lifecycle(.coldLaunch(queue: [ForayEngineHostTests.item("a")], index: 0, autoplay: false)))
        engine.handle(.command(.restoreBar, source: .restore))
        world.background.post(.background)
        world.background.post(.foreground)
        XCTAssertEqual(world.session.activateCalls, 0, "\(world.log.entries)")
        XCTAssertEqual(world.session.deactivations, [])
        XCTAssertEqual(engine.state.session, .inactive)
        XCTAssertEqual(world.deck.count("play"), 0)
    }

    // MARK: - pauseHoldPolicy

    /// `.forever` (the default): a pause and the background keep the session,
    /// and no hold timer is armed.
    /// TO SEE IT FAIL: add a `.deactivate` to the pause edge in
    /// `SessionPolicy.transition` (the `session` family goes red too).
    @MainActor
    func testForeverHoldsThroughAPauseAndTheBackground() throws {
        let world = FakeWorld()
        let engine = try playing(world)
        engine.handle(.command(.pause, source: .tap))
        world.background.post(.background)
        world.background.post(.foreground)
        XCTAssertEqual(world.session.deactivations, [], "S-4: a pause does not release the session under .forever")
        XCTAssertEqual(engine.state.session, .active)
        XCTAssertFalse(engine.liveTimers.contains(.holdExpired))
        XCTAssertEqual(world.nowPlaying.clears, 0)
    }

    /// `.until(m)`: nothing at the pause; at m minutes, a release WITHOUT
    /// notify, and Now Playing is kept.
    /// TO SEE IT FAIL: map `.deactivate` to `notifyOthers: true` in
    /// `EngineCore.applySession`, or let the pause edge release under `until`.
    @MainActor
    func testUntilReleasesWithoutNotifyWhenTheHoldRunsOut() throws {
        let world = FakeWorld()
        let engine = try playing(world, holdPolicy: .until(minutes: 2))
        engine.handle(.command(.pause, source: .tap))
        world.background.post(.background)
        XCTAssertEqual(world.session.deactivations, [])
        XCTAssertEqual(engine.liveTimers, [.holdExpired])

        world.timing.fire(afterMs: 120_000)

        XCTAssertEqual(world.session.deactivations, [false], "the hold ran out: release, never notify")
        XCTAssertEqual(engine.state.session, .inactive)
        XCTAssertEqual(world.nowPlaying.clears, 0, "Now Playing is kept so the car can still press play")

        // The car's play after the release is a fresh, user-caused activation.
        XCTAssertEqual(world.remote.press(.play), .success)
        XCTAssertEqual(world.session.activateCalls, 2)
        XCTAssertEqual(engine.state.session, .active)
    }

    /// `none` (the H-1b arm): the pause itself releases, without notify.
    /// TO SEE IT FAIL: drop the `holdPolicy == .noHold` branch of the pause edge.
    @MainActor
    func testNoneReleasesAtThePauseWithoutNotify() throws {
        let world = FakeWorld()
        let engine = try playing(world, holdPolicy: .noHold)
        engine.handle(.command(.pause, source: .tap))
        XCTAssertEqual(world.session.deactivations, [false])
        XCTAssertEqual(engine.state.session, .inactive)
        XCTAssertEqual(world.nowPlaying.clears, 0)
    }

    /// Only the listener's close notifies other apps.
    /// TO SEE IT FAIL: map `.deactivateNotify` to `notifyOthers: false`.
    @MainActor
    func testACloseReleasesWithNotify() throws {
        let world = FakeWorld()
        let engine = try playing(world)
        engine.handle(.command(.stop(persist: true), source: .tap))
        XCTAssertEqual(world.session.deactivations, [true])
        XCTAssertEqual(engine.state.session, .inactive)
    }

    // MARK: - Interruptions by reason

    /// Plan §4.4: a `began(appWasSuspended)` that lands while the engine is
    /// audibly running, after THIS process activated, describes a suspension
    /// that is already over. A row (`stale-suspension`), and nothing else.
    /// TO SEE IT FAIL: drop the `appWasSuspended && running &&
    /// activatedInProcess` branch in `SessionPolicy.transition`, or stop
    /// setting `activatedInProcess` on a successful activation.
    @MainActor
    func testAStaleAppWasSuspendedWhileRunningIsARowAndNoStateChange() throws {
        let world = FakeWorld()
        let engine = try playing(world)
        let pausesBefore = world.deck.count("pause")
        let stopsBefore = world.output.diags.filter { $0.kind == "stop" }.count

        world.session.post(.interruptionBegan(reason: "appWasSuspended"))

        XCTAssertEqual(sessionRows(world, "stale-suspension").count, 1, "the stale=y row")
        XCTAssertEqual(engine.state.session, .active)
        XCTAssertEqual(engine.state.stateType, "playing")
        XCTAssertEqual(world.deck.count("pause"), pausesBefore, "a stale suspension silenced the deck")
        XCTAssertEqual(world.output.diags.filter { $0.kind == "stop" }.count, stopsBefore, "it is not a stop")
        XCTAssertEqual(world.session.deactivations, [])
    }

    /// The same notification with nothing running is a real loss of the
    /// session, but still not a stop (nothing was sounding).
    /// TO SEE IT FAIL: treat every `appWasSuspended` as stale.
    @MainActor
    func testAppWasSuspendedWhilePausedLosesTheSessionWithoutAStopRow() throws {
        let world = FakeWorld()
        let engine = try playing(world)
        engine.handle(.command(.pause, source: .tap))
        let stopsBefore = world.output.diags.filter { $0.kind == "stop" }.count

        world.session.post(.interruptionBegan(reason: "appWasSuspended"))

        XCTAssertEqual(engine.state.session, .lostToInterruption)
        XCTAssertEqual(sessionRows(world, "stale-suspension").count, 0)
        XCTAssertEqual(world.output.diags.filter { $0.kind == "stop" }.count, stopsBefore)
    }

    /// A muted built-in mic interrupts nothing of ours: a row, no change.
    /// TO SEE IT FAIL: drop the `builtInMicMuted` branch.
    @MainActor
    func testBuiltInMicMutedChangesNothing() throws {
        let world = FakeWorld()
        let engine = try playing(world)
        let pausesBefore = world.deck.count("pause")

        world.session.post(.interruptionBegan(reason: "builtInMicMuted"))

        XCTAssertEqual(sessionRows(world, "mic-muted").count, 1)
        XCTAssertEqual(engine.state.session, .active)
        XCTAssertEqual(engine.state.stateType, "playing")
        XCTAssertEqual(world.deck.count("pause"), pausesBefore)
    }

    /// A real interruption (a call, Siri) takes the session and the player
    /// stops with its cause row; an unknown reason reads the same.
    /// TO SEE IT FAIL: make `unknown` a no-op like the mic.
    @MainActor
    func testADefaultOrUnknownInterruptionTakesTheSession() throws {
        for reason in ["default", "routeDisconnected", nil] as [String?] {
            let world = FakeWorld()
            let engine = try playing(world)
            world.session.post(.interruptionBegan(reason: reason))
            XCTAssertEqual(engine.state.session, .lostToInterruption, "reason \(reason ?? "nil")")
            XCTAssertNotEqual(engine.state.stateType, "playing")
            XCTAssertEqual(world.output.diags.filter { $0.kind == "stop" }.last?[field: "cause"], .string("interruption"))
        }
    }

    // MARK: - The hold policy's private key

    /// `setHoldPolicy` is persisted once per change, with a row; the stored
    /// value outranks the build default at the next construction.
    /// TO SEE IT FAIL: drop `persistHoldPolicyIfChanged()` from `runTurn`, or
    /// the stored-policy read in `init`.
    @MainActor
    func testSetHoldPolicyIsPersistedAndReadBackAtTheNextLaunch() {
        let world = FakeWorld()
        let store = FakeHoldPolicyStore(log: world.log, stored: .noHold)
        world.holdPolicyStore = store
        let engine = started(world)
        XCTAssertEqual(engine.state.holdPolicy, .noHold, "the stored policy outranks the config's default")

        engine.handle(.command(.setHoldPolicy(.forever), source: .tap))
        engine.handle(.command(.setHoldPolicy(.forever), source: .tap))
        engine.handle(.command(.setHoldPolicy(.until(minutes: 60)), source: .tap))

        XCTAssertEqual(store.saves, [.forever, .until(minutes: 60)], "once per change")
        XCTAssertEqual(sessionRows(world, "hold-policy").map { $0[field: "policy"] }, [.string("forever"), .string("until:60")])
        engine.teardown()

        let relaunch = FakeWorld()
        relaunch.holdPolicyStore = FakeHoldPolicyStore(log: relaunch.log, stored: store.stored)
        let again = started(relaunch)
        XCTAssertEqual(again.state.holdPolicy, .until(minutes: 60))
        again.teardown()
    }

    /// The real store: one string in the private key `ForayEngine.holdPolicy`,
    /// outside `CapacitorStorage.`, and an unreadable value is ignored.
    /// TO SEE IT FAIL: store under a `CapacitorStorage.` key, or fall back to
    /// `.noHold` on a bad value.
    func testTheRealStoreRoundTripsAndIgnoresWhatItCannotRead() throws {
        let suite = "ai.jwlabs.foura.test.hold.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = HoldPolicyStore(defaults: defaults)
        XCTAssertFalse(HoldPolicyStore.key.hasPrefix("CapacitorStorage."), "DurableStore must never see the key")
        XCTAssertNil(store.load())
        store.save(.until(minutes: 45))
        XCTAssertEqual(defaults.string(forKey: "ForayEngine.holdPolicy"), "until:45")
        XCTAssertEqual(store.load(), .until(minutes: 45))
        defaults.set("until:forever", forKey: HoldPolicyStore.key)
        XCTAssertNil(store.load())
    }
}

/// `EngineModeFlag` in foray-audio: the volatile, process-scoped
/// `sessionOwnedByEngine` that foray-tts reads through its byte-identical
/// copy (shell-invariants compares the files; ForayTtsPluginTests reads the
/// same domain and key from the other side).
final class EngineModeFlagTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeVolatileDomain(forName: "ai.jwlabs.foura.engine")
        super.tearDown()
    }

    /// Absent is false (legacy), a write lands in the VOLATILE domain under
    /// the spelling foray-tts reads, and a flip back to false is read.
    /// TO SEE IT FAIL: write with `UserDefaults.standard.set` (persistent),
    /// or change the domain or key in one copy.
    func testTheFlagIsVolatileAndSpelledTheWayForayTtsReadsIt() {
        UserDefaults.standard.removeVolatileDomain(forName: "ai.jwlabs.foura.engine")
        XCTAssertFalse(EngineModeFlag.sessionOwnedByEngine, "legacy until decideOnce says native")

        EngineModeFlag.sessionOwnedByEngine = true
        let volatile = UserDefaults.standard.volatileDomain(forName: "ai.jwlabs.foura.engine")
        XCTAssertEqual(volatile["sessionOwnedByEngine"] as? Bool, true)
        XCTAssertTrue(EngineModeFlag.sessionOwnedByEngine)

        EngineModeFlag.sessionOwnedByEngine = false
        XCTAssertFalse(EngineModeFlag.sessionOwnedByEngine)
    }
}

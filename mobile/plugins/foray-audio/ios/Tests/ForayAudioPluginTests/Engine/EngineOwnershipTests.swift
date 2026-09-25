import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// `EngineOwnership` (card NE-17, docs/native-engine-plan.md §4.6), headless:
/// the private keys in a throwaway `UserDefaults` suite, the engine over the
/// NE-15h recording fakes, and a fake for the resign / background leg of the
/// healthy marker. A "launch" is a fresh owner and a fresh world over the SAME
/// suite, which is exactly what a relaunch is to the strike accounting.
///
/// Where a sequence has a pure answer, the test also folds it through
/// `EngineMode.trace` (the fixture-pinned rule, `engine-mode` family) and
/// requires the owner's stored state to equal it: the owner moves values in
/// and out of the rule and must not have an opinion of its own.
///
/// Each test names the edit that turns it red.
final class EngineOwnershipTests: XCTestCase {

    private var suites: [String] = []

    override func tearDown() {
        for name in suites { UserDefaults().removePersistentDomain(forName: name) }
        suites = []
        super.tearDown()
    }

    private func freshDefaults() -> (UserDefaults, String) {
        let name = "EngineOwnershipTests.\(UUID().uuidString)"
        suites.append(name)
        return (UserDefaults(suiteName: name)!, name)
    }

    // MARK: - Harness

    final class FakeFlag: SessionOwnershipFlag {
        private(set) var history: [Bool] = []
        var sessionOwnedByEngine = false {
            didSet { history.append(sessionOwnedByEngine) }
        }
    }

    final class FakeOwnershipLifecycle: OwnershipLifecycle {
        private var handlers: [(FakeObservation, () -> Void)] = []

        var liveObservers: Int { handlers.filter { $0.0.isLive }.count }

        func observeResignOrBackground(_ handler: @escaping () -> Void) -> EngineObservation {
            let token = FakeObservation()
            handlers.append((token, handler))
            return token
        }

        /// The app resigns active or enters the background.
        func post() {
            for (token, handler) in handlers where token.isLive { handler() }
        }
    }

    /// One process.
    @MainActor
    final class Launch {
        let world: FakeWorld
        /// The owner's own clock: the engine's position cadence shares the
        /// watchdog's 15 s, so they must not share a fake.
        let ownerTiming: FakeTiming
        let lifecycle: FakeOwnershipLifecycle
        let flag: FakeFlag
        /// The legacy lane's registrant. In the app it is the same
        /// `MPRemoteCommandCenter` the engine registers on; apart here, so
        /// "no legacy target" and "the engine's targets are gone" are separate
        /// numbers.
        let legacyRemote: FakeRemote
        let owner: EngineOwnership
        private let sink: RowSink
        private(set) var legacyRuns = 0
        /// The session flag's value at the moment the legacy lane registered.
        private(set) var flagAtLegacyRegistration: Bool?

        final class RowSink { var rows: [DiagEntry] = [] }

        init(_ defaults: UserDefaults, buildDefault: EngineMode.BuildDefault? = .native, build: String = "b1",
             built: Bool = true) {
            let world = FakeWorld()
            let ownerTiming = FakeTiming(log: world.log)
            let lifecycle = FakeOwnershipLifecycle()
            let flag = FakeFlag()
            let sink = RowSink()
            var factory: (@MainActor () -> ForayEngine)?
            if built {
                factory = { @MainActor () -> ForayEngine in
                    let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: build))
                    engine.start()
                    return engine
                }
            }
            self.world = world
            self.ownerTiming = ownerTiming
            self.lifecycle = lifecycle
            self.flag = flag
            self.sink = sink
            legacyRemote = FakeRemote(log: world.log)
            owner = EngineOwnership(
                store: EngineOwnershipTests.store(defaults),
                environment: EngineOwnership.LaunchEnvironment(buildDefault: buildDefault, currentBuild: build,
                                                              launchId: "launch-\(UUID().uuidString)"),
                flag: flag, timing: ownerTiming, lifecycle: lifecycle,
                diag: { sink.rows.append($0) }, engineFactory: factory)
        }

        var modeRows: [DiagEntry] { sink.rows.filter { $0.kind == "mode" } }

        /// Today's registration, as the plugin's `registerCommandHandlers`
        /// makes it: one target per command, `stop` registered and disabled.
        func registerLegacy() {
            legacyRuns += 1
            flagAtLegacyRegistration = flag.sessionOwnedByEngine
            for command in MediaMapping.RemoteCommand.allCases {
                _ = legacyRemote.addTarget(command) { _ in .success }
            }
            legacyRemote.setEnabled(false, for: .stop)
        }

        /// The plugin's `load()`.
        func load() {
            owner.pluginDidLoad(legacyRegistration: { [unowned self] in self.registerLegacy() })
        }

        var engine: ForayEngine? { owner.engine }
    }

    private static func item(_ id: String) -> EngineItem {
        EngineItem(node: .object([JSONMember("id", .string(id)), JSONMember("kind", .string("episode")),
                                  JSONMember("audio_url", .string("https://cdn.example/\(id).mp3"))]))!
    }

    /// The owner's keys through NE-19's real `EngineStore` over a throwaway
    /// suite: the one door the engine's storage has in the app.
    @MainActor
    static func store(_ defaults: UserDefaults) -> EnginePrivateStore {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("EngineOwnershipTests-\(UUID().uuidString)", isDirectory: true)
        let diagnostics = EngineDiagnostics(directory: directory, clock: { (wallMs: 0, monoMs: 0) })
        return EnginePrivateStore(keys: EngineStore(defaults: defaults, diagnostics: diagnostics))
    }

    private func trace(_ events: [EngineMode.Event]) -> EngineMode.Stored {
        EngineMode.trace(from: EngineMode.Stored(), events: events).last!.stored
    }

    // MARK: - decideOnce

    /// Plan §4.6: whichever of `bootIfNeeded` (AppDelegate) and the plugin's
    /// `load()` runs first decides; the other reads the answer. One strike
    /// for the previous launch's uncleared sentinel, not two, and one engine.
    /// TO SEE IT FAIL: drop `if let decision { return decision }` from
    /// `decideOnce` (the second call sees the sentinel the first just wrote
    /// and counts it: strikes 3).
    @MainActor
    func testDecideOnceFromBothEntryPointsCountsOneStrike() throws {
        let (defaults, _) = freshDefaults()
        defaults.set("an-earlier-launch", forKey: EnginePrivateKey.sentinel.rawValue)
        defaults.set("1", forKey: EnginePrivateKey.strikes.rawValue)
        let launch = Launch(defaults)

        let booted = try XCTUnwrap(launch.owner.bootIfNeeded(), "native boots from the cold path")
        launch.load()
        launch.owner.decideOnce()

        XCTAssertEqual(launch.owner.store.strikes, 2)
        XCTAssertTrue(launch.engine === booted, "one engine per process")
        XCTAssertEqual(launch.world.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        XCTAssertEqual(launch.modeRows.filter { $0[field: "mode"] != nil }.count, 1, "one decision row")
        XCTAssertEqual(launch.legacyRuns, 0)
        XCTAssertEqual(launch.owner.store.string(.sentinel), launch.owner.environment.launchId,
                       "the sentinel guarding THIS boot is written before it")
    }

    /// R18: three background launches that each went healthy are not a crash
    /// loop. The car's play launches 4a in the background every morning.
    /// TO SEE IT FAIL: leave the sentinel set in `markHealthy`, or count a
    /// strike per launch.
    @MainActor
    func testThreeLaunchesWithClearedSentinelsLeaveStrikesZero() {
        let (defaults, _) = freshDefaults()
        var events: [EngineMode.Event] = []
        for _ in 0..<3 {
            let launch = Launch(defaults)
            launch.load()
            XCTAssertEqual(launch.owner.mode, .native)
            launch.lifecycle.post()   // didEnterBackground: the healthy marker
            events += [.launch(buildDefault: .native, currentBuild: "b1", built: true), .healthy]
        }
        let store = Self.store(defaults)
        XCTAssertEqual(store.strikes, 0)
        XCTAssertNil(store.string(.sentinel))
        XCTAssertEqual(store.stored, trace(events))
    }

    /// A native boot that never reached a healthy marker is a strike at the
    /// next launch; three of them run legacy, pinned to the build.
    /// TO SEE IT FAIL: write the sentinel after the boot instead of before
    /// it, or never write it.
    @MainActor
    func testALaunchAfterAnUnclearedSentinelAddsOneAndThreeReachLegacy() {
        let (defaults, _) = freshDefaults()
        var events: [EngineMode.Event] = []
        var modes: [EngineMode.Mode?] = []
        var strikes: [Int] = []
        for _ in 0..<4 {
            let launch = Launch(defaults)
            launch.load()   // and then the process dies before any marker
            modes.append(launch.owner.mode)
            strikes.append(launch.owner.store.strikes)
            events.append(.launch(buildDefault: .native, currentBuild: "b1", built: true))
            if launch.owner.mode == .legacy {
                XCTAssertEqual(launch.legacyRuns, 1, "the legacy lane registers in load()")
                XCTAssertNil(launch.engine)
                XCTAssertEqual(launch.flag.history, [], "a legacy process never takes the session flag")
                XCTAssertEqual(launch.modeRows.first?[field: "reason"], .string("crash-loop"))
            }
        }
        XCTAssertEqual(modes, [.native, .native, .native, .legacy])
        XCTAssertEqual(strikes, [0, 1, 2, 3])
        let store = Self.store(defaults)
        XCTAssertEqual(store.string(.stickyLegacyBuild), "b1")
        XCTAssertEqual(store.stored, trace(events))
    }

    /// Sticky legacy survives a relaunch of the same build (no oscillation)
    /// and clears on a new CFBundleVersion, the fix a crash loop waits for.
    /// TO SEE IT FAIL: drop the sticky write-back in `decideOnce`.
    @MainActor
    func testStickyLegacySurvivesRelaunchAndClearsOnANewBuild() {
        let (defaults, _) = freshDefaults()
        defaults.set("3", forKey: EnginePrivateKey.strikes.rawValue)

        let first = Launch(defaults, build: "b1")
        first.load()
        XCTAssertEqual(first.owner.mode, .legacy)
        XCTAssertEqual(first.owner.store.string(.stickyLegacyBuild), "b1")

        // Even with the count back at zero, the pin holds this build: no
        // oscillation between lanes on one binary.
        defaults.set("0", forKey: EnginePrivateKey.strikes.rawValue)
        let again = Launch(defaults, build: "b1")
        again.load()
        XCTAssertEqual(again.owner.mode, .legacy)
        XCTAssertEqual(again.modeRows.first?[field: "reason"], .string("crash-loop"))

        let next = Launch(defaults, build: "b2")
        next.load()
        XCTAssertEqual(next.owner.mode, .native)
        XCTAssertEqual(next.modeRows.first?[field: "reason"], .string("build-default"))
        XCTAssertNil(next.owner.store.string(.stickyLegacyBuild))
        XCTAssertEqual(next.owner.store.strikes, 0)
    }

    /// The Developer setting writes synchronously, clears strikes and the
    /// sticky pin, and applies at the next launch, never to this one.
    /// TO SEE IT FAIL: drop the strikes or sticky clear in `setModeOverride`.
    @MainActor
    func testSetModeOverrideWritesSynchronouslyAndAppliesAfterRestart() {
        let (defaults, _) = freshDefaults()
        defaults.set("3", forKey: EnginePrivateKey.strikes.rawValue)
        let pinned = Launch(defaults)
        pinned.load()
        XCTAssertEqual(pinned.owner.mode, .legacy)

        pinned.owner.setModeOverride(.native)
        XCTAssertEqual(defaults.string(forKey: "ForayEngine.modeOverride"), "native", "written before the call returns")
        XCTAssertEqual(defaults.string(forKey: "ForayEngine.strikes"), "0")
        XCTAssertNil(defaults.string(forKey: "ForayEngine.stickyLegacyBuild"))
        XCTAssertEqual(pinned.owner.mode, .legacy, "applies after restart")

        let native = Launch(defaults, buildDefault: .js)
        native.load()
        XCTAssertEqual(native.owner.mode, .native)
        XCTAssertEqual(native.modeRows.first?[field: "reason"], .string("override"))

        native.owner.setModeOverride(.web)
        let web = Launch(defaults, buildDefault: .native)
        web.load()
        XCTAssertEqual(web.owner.mode, .legacy)
        XCTAssertEqual(web.modeRows.first?[field: "reason"], .string("override"))
    }

    /// An absent `ForayEngineDefault` runs today's player (`no-plist-key`),
    /// and a binary with no engine is `not-built` whatever the plist says,
    /// writing no private key at all: THIS card's production shape.
    /// TO SEE IT FAIL: default a missing plist key to native; derive `built`
    /// from anything but the factory; write the strikes back unconditionally.
    @MainActor
    func testAnAbsentPlistKeyAndAMissingEngineRunLegacy() {
        let (defaults, _) = freshDefaults()
        let absent = Launch(defaults, buildDefault: nil)
        absent.load()
        XCTAssertEqual(absent.owner.mode, .legacy)
        XCTAssertEqual(absent.modeRows.first?[field: "reason"], .string("no-plist-key"))
        XCTAssertEqual(absent.legacyRuns, 1)

        let (clean, cleanName) = freshDefaults()
        let unbuilt = Launch(clean, buildDefault: .native, built: false)
        unbuilt.load()
        XCTAssertEqual(unbuilt.owner.mode, .legacy)
        XCTAssertEqual(unbuilt.modeRows.first?[field: "reason"], .string("not-built"))
        XCTAssertNil(unbuilt.owner.bootIfNeeded())
        XCTAssertEqual(unbuilt.flag.history, [])
        XCTAssertEqual(clean.persistentDomain(forName: cleanName)?.keys.filter { $0.hasPrefix("ForayEngine.") } ?? [], [],
                       "a build with no engine leaves no trace in the private keys")
    }

    /// The plist value is read strictly: the two words or nothing.
    /// TO SEE IT FAIL: lowercase the raw value before matching it.
    @MainActor
    func testTheLaunchEnvironmentReadsThePlistStrictly() {
        let js = EngineOwnership.LaunchEnvironment.from(info: ["ForayEngineDefault": "js", "CFBundleVersion": "7"])
        XCTAssertEqual(js.buildDefault, .js)
        XCTAssertEqual(js.currentBuild, "7")
        XCTAssertEqual(EngineOwnership.LaunchEnvironment.from(info: ["ForayEngineDefault": "native"]).buildDefault, .native)
        XCTAssertNil(EngineOwnership.LaunchEnvironment.from(info: ["ForayEngineDefault": "Native"]).buildDefault)
        XCTAssertNil(EngineOwnership.LaunchEnvironment.from(info: ["ForayEngineDefault": true]).buildDefault)
        XCTAssertNil(EngineOwnership.LaunchEnvironment.from(info: nil).buildDefault)
        XCTAssertEqual(EngineOwnership.LaunchEnvironment.from(info: nil).currentBuild, "")
    }

    /// Plan §4.6: the private keys live outside `CapacitorStorage.`, where
    /// DurableStore (and so a page) never enumerates them.
    /// TO SEE IT FAIL: rename a key into the `CapacitorStorage.` prefix.
    @MainActor
    func testPrivateKeysLiveOutsideCapacitorStorage() {
        for key in EnginePrivateKey.allCases {
            XCTAssertTrue(key.rawValue.hasPrefix("ForayEngine."), key.rawValue)
            XCTAssertFalse(key.rawValue.hasPrefix("CapacitorStorage."), key.rawValue)
        }
        let (defaults, name) = freshDefaults()
        Launch(defaults).load()          // dies unhealthy: a sentinel
        let second = Launch(defaults)    // a strike
        second.load()
        second.owner.setModeOverride(.web)
        let written = defaults.persistentDomain(forName: name)?.keys.sorted() ?? []
        XCTAssertFalse(written.isEmpty)
        XCTAssertTrue(written.allSatisfy { $0.hasPrefix("ForayEngine.") }, "\(written)")
    }

    // MARK: - Registration and the one-way relinquish

    /// Legacy: today's registration, in `load()`, once; no engine and no
    /// engine target exist.
    /// TO SEE IT FAIL: park the registration in the legacy branch too, or
    /// boot the engine from `bootIfNeeded` in legacy mode.
    @MainActor
    func testTheLegacyLaneRegistersTodaysSetInLoadAndBootsNothing() {
        let (defaults, _) = freshDefaults()
        let launch = Launch(defaults, buildDefault: .js)
        launch.load()
        XCTAssertEqual(launch.legacyRuns, 1)
        XCTAssertEqual(launch.legacyRemote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        for command in MediaMapping.RemoteCommand.allCases {
            XCTAssertEqual(launch.legacyRemote.liveTargets(for: command), 1, command.rawValue)
        }
        XCTAssertEqual(launch.legacyRemote.enabled[.stop], false)
        XCTAssertNil(launch.owner.bootIfNeeded())
        XCTAssertEqual(launch.world.remote.liveTargets, 0)
        XCTAssertEqual(launch.flag.history, [])
        launch.load()
        XCTAssertEqual(launch.legacyRuns, 1, "at most once per process")
    }

    /// Native: no legacy target until the relinquish, then exactly one set,
    /// registered AFTER the flag was handed back; the session is kept (no
    /// deactivate, no notify); the restore record says relinquished; and a
    /// second relinquish is refused without a second set.
    /// TO SEE IT FAIL: run the legacy registration in native `load()`; flip
    /// the flag after the registration; drop the `relinquished` guard.
    @MainActor
    func testNativeRegistersNoLegacyTargetUntilRelinquishThenExactlyOneSet() throws {
        let (defaults, _) = freshDefaults()
        let launch = Launch(defaults)
        launch.world.deck.answersReady = true
        launch.load()
        let engine = try XCTUnwrap(launch.engine)
        XCTAssertEqual(launch.legacyRemote.liveTargets, 0, "no legacy target before the relinquish")
        XCTAssertEqual(launch.world.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        XCTAssertEqual(launch.flag.history, [true])

        engine.handle(.queue(.load([Self.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(engine.state.session, .active)

        let verdict = launch.owner.relinquish(cap: .foray, source: .tap)
        XCTAssertTrue(verdict.ok, "\(verdict.failures)")

        XCTAssertTrue(engine.isTornDown)
        XCTAssertEqual(launch.world.remote.liveTargets, 0, "the engine's targets are gone")
        XCTAssertEqual(launch.legacyRuns, 1)
        XCTAssertEqual(launch.legacyRemote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        for command in MediaMapping.RemoteCommand.allCases {
            XCTAssertEqual(launch.legacyRemote.liveTargets(for: command), 1, command.rawValue)
        }
        XCTAssertEqual(launch.flag.history, [true, false])
        XCTAssertEqual(launch.flagAtLegacyRegistration, false, "the legacy lane's session sites must be live when it registers")
        XCTAssertEqual(launch.world.session.deactivations, [], "no deactivate, no notify")
        XCTAssertEqual(launch.world.nowPlaying.clears, 0, "Now Playing is left for the legacy lane to overwrite")
        XCTAssertEqual(launch.world.output.restores.last??.mode, .relinquished)
        XCTAssertTrue(launch.world.output.diags.contains {
            $0.kind == "mode" && $0[field: "reason"] == .string("downgrade") && $0[field: "cap"] == .string("foray")
        })

        let again = launch.owner.relinquish(cap: .all, source: .tap)
        XCTAssertEqual(again.failures, ["relinquished"])
        XCTAssertEqual(launch.legacyRuns, 1)
        XCTAssertEqual(launch.legacyRemote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
    }

    /// A relinquish that reaches the engine by another road (the bridge
    /// handing the command straight to the host) still hands the process
    /// over: the owner hears the teardown, not the command.
    /// TO SEE IT FAIL: drop the `onTornDown` call from `teardown()`.
    @MainActor
    func testARelinquishThatReachesTheEngineDirectlyStillHandsOver() throws {
        let (defaults, _) = freshDefaults()
        let launch = Launch(defaults)
        launch.load()
        let engine = try XCTUnwrap(launch.engine)
        engine.handle(.command(.relinquish(cap: .all), source: .restore))
        XCTAssertEqual(launch.legacyRuns, 1)
        XCTAssertEqual(launch.flag.history, [true, false])
        XCTAssertTrue(launch.owner.relinquished)
    }

    /// After a relinquish, the system's notifications reach nothing: zero
    /// engine commands, zero activations or deactivations.
    /// TO SEE IT FAIL: skip `teardown()` in `relinquish`, with the host's own
    /// terminal teardown also removed.
    @MainActor
    func testAfterRelinquishSystemNotificationsReachNothing() throws {
        let (defaults, _) = freshDefaults()
        let launch = Launch(defaults)
        launch.world.deck.answersReady = true
        launch.load()
        let engine = try XCTUnwrap(launch.engine)
        engine.handle(.queue(.load([Self.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        launch.owner.relinquish(cap: .foray, source: .tap)

        let activations = launch.world.session.activateCalls
        let diags = launch.world.output.diags.count
        let seen = launch.world.log.entries.count
        launch.world.session.post(.interruptionEnded(shouldResume: true))
        launch.world.session.post(.route(RouteChange(oldDeviceUnavailable: true, routeName: "Car", isCarRoute: true)))
        launch.world.session.post(.mediaServicesReset)
        launch.world.background.post(.foreground)
        launch.lifecycle.post()
        XCTAssertEqual(launch.world.session.activateCalls, activations)
        XCTAssertEqual(launch.world.session.deactivations, [])
        XCTAssertEqual(launch.world.output.diags.count, diags, "an engine command after the relinquish")
        XCTAssertEqual(launch.world.log.entries.count, seen, "\(launch.world.log.entries.suffix(5))")
    }

    // MARK: - The healthy marker

    /// The first handled input clears the sentinel and resets the strikes,
    /// and the other markers stand down.
    /// TO SEE IT FAIL: drop the `onTurnCompleted?()` call from the host's
    /// `handle`.
    @MainActor
    func testTheFirstHandledInputIsTheHealthyMarker() throws {
        let (defaults, _) = freshDefaults()
        defaults.set("an-earlier-launch", forKey: EnginePrivateKey.sentinel.rawValue)
        let launch = Launch(defaults)
        launch.load()
        XCTAssertEqual(launch.owner.store.strikes, 1)
        XCTAssertNotNil(launch.owner.store.string(.sentinel))
        XCTAssertEqual(launch.ownerTiming.live.count, 1, "the run-loop marker is armed")
        XCTAssertEqual(launch.lifecycle.liveObservers, 1)

        try XCTUnwrap(launch.engine).handle(.lifecycle(.foreground))

        XCTAssertNil(launch.owner.store.string(.sentinel))
        XCTAssertEqual(launch.owner.store.strikes, 0)
        XCTAssertEqual(launch.ownerTiming.live.count, 0)
        XCTAssertEqual(launch.lifecycle.liveObservers, 0)
        XCTAssertTrue(launch.modeRows.contains { $0[field: "marker"] == .string("first-input") })
    }

    /// Five seconds of the main run loop are healthy with no input at all
    /// (a background launch nobody pressed anything in).
    /// TO SEE IT FAIL: drop the run-loop timer from `armHealthyMarkers`.
    @MainActor
    func testFiveSecondsOfRunLoopAreHealthy() {
        let (defaults, _) = freshDefaults()
        defaults.set("an-earlier-launch", forKey: EnginePrivateKey.sentinel.rawValue)
        let launch = Launch(defaults)
        launch.load()
        launch.ownerTiming.fire(afterMs: EngineOwnership.healthyRunLoopMs)
        XCTAssertNil(launch.owner.store.string(.sentinel))
        XCTAssertEqual(launch.owner.store.strikes, 0)
    }

    // MARK: - The hello watchdog

    /// No engineHello after a foreground page load: a page-health strike at
    /// 10 s (counted from the launch's own strikes, after the healthy marker
    /// reset them), then at 15 s the idle engine relinquishes by itself. A
    /// page broken on every launch therefore reaches legacy.
    /// TO SEE IT FAIL: count the page-health strike from the live count; let
    /// a later healthy marker reset it; drop the watchdog's relinquish.
    @MainActor
    func testTheHelloWatchdogRelinquishesAnIdleEngineAndABrokenPageReachesLegacy() {
        let (defaults, _) = freshDefaults()
        var events: [EngineMode.Event] = []
        var launchesUntilLegacy = 0
        while launchesUntilLegacy < 6 {
            let launch = Launch(defaults)
            launch.load()
            events.append(.launch(buildDefault: .native, currentBuild: "b1", built: true))
            launchesUntilLegacy += 1
            if launch.owner.mode == .legacy { break }
            let started = launch.owner.store.strikes
            launch.ownerTiming.fire(afterMs: EngineOwnership.healthyRunLoopMs)
            events.append(.healthy)
            XCTAssertEqual(launch.owner.store.strikes, 0)

            launch.owner.pageDidFinishLoad(foreground: true)
            launch.ownerTiming.fire(afterMs: EngineOwnership.pageHealthMs)
            events.append(.pageHealth)
            XCTAssertEqual(launch.owner.store.strikes, started + 1)
            XCTAssertTrue(launch.modeRows.contains { $0[field: "reason"] == .string("page-health") })
            XCTAssertFalse(launch.owner.relinquished, "10 s is the strike; 15 s is the relinquish")

            launch.ownerTiming.fire(afterMs: EngineOwnership.helloWatchdogMs)
            XCTAssertTrue(launch.owner.relinquished)
            XCTAssertEqual(launch.legacyRuns, 1)
            XCTAssertEqual(launch.flag.history, [true, false])
            XCTAssertEqual(launch.owner.store.strikes, started + 1, "one page-health strike per process")
            XCTAssertTrue(launch.world.output.diags.contains {
                $0.kind == "mode" && $0[field: "reason"] == .string("downgrade") && $0[field: "cap"] == .string("all")
            })
        }
        XCTAssertEqual(launchesUntilLegacy, 4, "three broken pages, then legacy")
        XCTAssertEqual(Self.store(defaults).stored, trace(events))
    }

    /// A healthy marker that arrives AFTER a page-health strike clears the
    /// sentinel but keeps the strike (`EngineMode.trace`'s rule): otherwise a
    /// page broken on every launch whose strike lands first would never reach
    /// legacy.
    /// TO SEE IT FAIL: drop `if !pageHealthTaken` in `markHealthy`.
    @MainActor
    func testAHealthyMarkerAfterAPageHealthStrikeKeepsTheStrike() {
        let (defaults, _) = freshDefaults()
        let launch = Launch(defaults)
        launch.load()
        launch.owner.pageDidFinishLoad(foreground: true)
        launch.ownerTiming.fire(afterMs: EngineOwnership.pageHealthMs)
        XCTAssertEqual(launch.owner.store.strikes, 1)
        XCTAssertNotNil(launch.owner.store.string(.sentinel))

        launch.lifecycle.post()
        XCTAssertNil(launch.owner.store.string(.sentinel), "healthy: the boot did not crash")
        XCTAssertEqual(launch.owner.store.strikes, 1, "but the page did not say hello")
        XCTAssertEqual(launch.owner.store.stored, trace([
            .launch(buildDefault: .native, currentBuild: "b1", built: true), .pageHealth, .healthy,
        ]))
    }

    /// engineHello stands both timers down; a background page load arms no
    /// page-health strike (a suspended page cannot say hello).
    /// TO SEE IT FAIL: drop `cancelHelloTimers()` from `helloReceived`, or
    /// arm the strike timer regardless of `foreground`.
    @MainActor
    func testHelloStandsTheWatchdogDown() {
        let (defaults, _) = freshDefaults()
        let launch = Launch(defaults)
        launch.load()
        launch.ownerTiming.fire(afterMs: EngineOwnership.healthyRunLoopMs)

        launch.owner.pageDidFinishLoad(foreground: true)
        XCTAssertEqual(launch.ownerTiming.live.map(\.afterMs).sorted(),
                       [EngineOwnership.pageHealthMs, EngineOwnership.helloWatchdogMs])
        launch.owner.helloReceived()
        XCTAssertEqual(launch.ownerTiming.live.count, 0)

        // A second navigation (a reload): its page has not said hello yet.
        launch.owner.pageDidStartLoad()
        launch.owner.pageDidFinishLoad(foreground: false)
        XCTAssertEqual(launch.ownerTiming.live.map(\.afterMs), [EngineOwnership.helloWatchdogMs])
        launch.owner.helloReceived()
        XCTAssertFalse(launch.owner.relinquished)
        XCTAssertEqual(launch.owner.store.strikes, 0)
    }

    /// THE REAL ORDER ON A LAUNCH. client.js sends engineHello while the
    /// module is being evaluated, long before the load event, so the hello
    /// reaches the owner BEFORE `pageDidFinishLoad`. That load must arm
    /// nothing: no timer, no page-health strike at 10 s, no relinquish at
    /// 15 s. Before the fix every foreground launch struck and then dropped
    /// an idle engine to the web player, and three launches pinned legacy.
    /// A later navigation that never says hello is still watched.
    /// TO SEE IT FAIL: drop `guard !helloThisNavigation` from
    /// `pageDidFinishLoad`, or stop setting the flag in `helloReceived`.
    @MainActor
    func testAHelloBeforeTheLoadFinishesArmsNoWatchdog() {
        let (defaults, _) = freshDefaults()
        for _ in 0..<4 {
            let launch = Launch(defaults)
            launch.load()
            XCTAssertEqual(launch.owner.mode, .native, "a page that said hello is never a strike")
            launch.ownerTiming.fire(afterMs: EngineOwnership.healthyRunLoopMs)

            launch.owner.pageDidStartLoad()
            launch.owner.helloReceived()
            launch.owner.pageDidFinishLoad(foreground: true)
            XCTAssertEqual(launch.ownerTiming.live.count, 0, "the page already claimed the engine")
            launch.ownerTiming.fire(afterMs: EngineOwnership.pageHealthMs)
            launch.ownerTiming.fire(afterMs: EngineOwnership.helloWatchdogMs)
            XCTAssertFalse(launch.owner.relinquished)
            XCTAssertEqual(launch.legacyRuns, 0)
            XCTAssertEqual(launch.owner.store.strikes, 0)
            XCTAssertFalse(launch.modeRows.contains { $0[field: "reason"] == .string("page-health") })

            // A reload whose page never says hello is still watched.
            launch.owner.pageDidStartLoad()
            launch.owner.pageDidFinishLoad(foreground: false)
            XCTAssertEqual(launch.ownerTiming.live.map(\.afterMs), [EngineOwnership.helloWatchdogMs])
            launch.owner.helloReceived()
            XCTAssertEqual(launch.ownerTiming.live.count, 0)
        }
    }

    /// The watchdog never stops the listener's audio: while the engine runs
    /// it looks again later, and relinquishes once the engine is idle.
    /// TO SEE IT FAIL: drop the `isRunning` check in `helloWatchdogFired`.
    @MainActor
    func testTheWatchdogNeverStopsAPlayingEngine() throws {
        let (defaults, _) = freshDefaults()
        let launch = Launch(defaults)
        launch.world.deck.answersReady = true
        launch.load()
        let engine = try XCTUnwrap(launch.engine)
        engine.handle(.queue(.load([Self.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .remote)))
        XCTAssertTrue(engine.state.isRunning)

        launch.owner.pageDidFinishLoad(foreground: false)
        launch.ownerTiming.fire(afterMs: EngineOwnership.helloWatchdogMs)
        XCTAssertFalse(launch.owner.relinquished)
        XCTAssertEqual(launch.world.deck.count("pause"), 0)
        XCTAssertEqual(launch.ownerTiming.live.map(\.afterMs), [EngineOwnership.helloWatchdogMs], "re-armed")

        engine.handle(.command(.pause, source: .tap))
        launch.ownerTiming.fire(afterMs: EngineOwnership.helloWatchdogMs)
        XCTAssertTrue(launch.owner.relinquished)
        XCTAssertEqual(launch.legacyRuns, 1)
    }

    // MARK: - The flag's real home

    /// The flag lives in the process-scoped volatile domain both plugins read,
    /// and is visible to a second reader in the same process (foray-tts's
    /// copy, NE-16).
    /// TO SEE IT FAIL: store it with `set(_:forKey:)` (persistent), or in a
    /// different domain.
    func testTheSessionFlagIsVolatileAndSharedInProcess() {
        let defaults = UserDefaults.standard
        defer { defaults.removeVolatileDomain(forName: EngineModeFlag.domain) }
        let writer = ProcessSessionOwnershipFlag()
        XCTAssertFalse(writer.sessionOwnedByEngine)
        writer.sessionOwnedByEngine = true
        XCTAssertTrue(ProcessSessionOwnershipFlag().sessionOwnedByEngine, "a second reader in the process sees it")
        XCTAssertEqual(defaults.volatileDomain(forName: "ai.jwlabs.foura.engine")["sessionOwnedByEngine"] as? Bool, true)
        writer.sessionOwnedByEngine = false
        XCTAssertFalse(ProcessSessionOwnershipFlag().sessionOwnedByEngine)
    }
}

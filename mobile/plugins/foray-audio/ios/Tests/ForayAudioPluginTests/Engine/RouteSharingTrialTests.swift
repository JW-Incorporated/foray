import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// Card NE-40 (DV-8; docs/native-engine-plan.md §14 Track M3): the
/// `.longFormAudio` route-sharing trial.
///
///   - It ships OFF. M1's car win (#114) happened on the default route
///     sharing, so the default does not change without a drive. The core's
///     config, the boot's reading and the session owner's own config all
///     default to it, and only the Developer row's stored choice turns it on.
///   - `engineSend setRouteSharing` is the host's: stored in the private key
///     `ForayEngine.routeSharing`, with a row saying what was chosen and what
///     this launch still runs. It applies at the next launch, when the boot
///     builds the session owner, and the `build` row says which policy the
///     launch ran (the Copy header's `routeSharing=`).
///
/// Each test names the edit that turns it red.
final class RouteSharingTrialTests: XCTestCase {

    /// The private key, in memory.
    final class MemoryRouteSharingStore: RouteSharingStoring {
        var stored: EngineContract.RouteSharingPolicy?
        private(set) var saves: [EngineContract.RouteSharingPolicy] = []

        init(stored: EngineContract.RouteSharingPolicy? = nil) {
            self.stored = stored
        }

        func loadRouteSharing() -> EngineContract.RouteSharingPolicy? { stored }

        func saveRouteSharing(_ policy: EngineContract.RouteSharingPolicy) {
            saves.append(policy)
            stored = policy
        }
    }

    private func routeSharingRows(_ world: FakeWorld) -> [DiagEntry] {
        world.output.diags.filter { $0.kind == "session" && $0[field: "kind"] == .string("route-sharing") }
    }

    // MARK: - The pin: OFF unless the Developer row stored it

    /// The flag defaults off everywhere the shipping boot reads it.
    /// TO SEE IT FAIL: default `EngineConfig.routeSharingLongForm` to true;
    /// make `EngineBoot.routeSharingLongForm(nil)` answer true; default
    /// `AudioSessionOwner.Config.longFormAudio` to true.
    func testTheTrialDefaultsOff() {
        XCTAssertFalse(EngineConfig().routeSharingLongForm, "the core's default")
        XCTAssertFalse(EngineConfig(build: "2026100101").routeSharingLongForm, "the shipping boot's starting config")
        XCTAssertFalse(EngineBoot.routeSharingLongForm(nil), "nothing stored: the default route sharing")
        XCTAssertFalse(EngineBoot.routeSharingLongForm(.standard))
        XCTAssertTrue(EngineBoot.routeSharingLongForm(.longFormAudio), "only the stored trial turns it on")
        XCTAssertFalse(AudioSessionOwner.Config().longFormAudio, "the session owner's own default")
    }

    /// The build row says which policy the launch ran, spelled as the wire
    /// and the Copy header spell it; a row built without one says nothing.
    /// TO SEE IT FAIL: drop the `routeSharing` field from `BuildRow.entry`.
    func testTheBuildRowSaysWhichPolicyTheLaunchRan() {
        let trial = BuildRow(engineVersion: "1.0.0", bundleVersion: "2026100101", launch: .foreground,
                             holdPolicy: .forever, routeSharing: .longFormAudio).entry
        XCTAssertEqual(trial[field: "routeSharing"], .string("longFormAudio"))
        let plain = BuildRow(engineVersion: "1.0.0", bundleVersion: "2026100101", launch: .foreground,
                             holdPolicy: .forever, routeSharing: .standard).entry
        XCTAssertEqual(plain[field: "routeSharing"], .string("default"))
        let older = BuildRow(engineVersion: "1.0.0", bundleVersion: "2026100101", launch: .foreground,
                             holdPolicy: .forever).entry
        XCTAssertNil(older[field: "routeSharing"])
        XCTAssertEqual(DiagGate.admit(trial)?[field: "routeSharing"], .string("longFormAudio"), "the ring keeps it")
    }

    // MARK: - The Developer row's command

    /// `setRouteSharing` is accepted, stored for the next launch, and written
    /// down with what this launch still runs; nothing plays or activates.
    /// TO SEE IT FAIL: drop `persistRouteSharing` from `runTurn`.
    @MainActor
    func testSetRouteSharingIsStoredForTheNextLaunchWithARow() {
        let world = FakeWorld()
        let store = MemoryRouteSharingStore()
        world.routeSharingStore = store
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()

        XCTAssertTrue(engine.handle(.command(.setRouteSharing(.longFormAudio), source: .tap)).ok)
        XCTAssertEqual(store.saves, [.longFormAudio])
        XCTAssertEqual(routeSharingRows(world).map { $0[field: "policy"] }, [.string("longFormAudio")])
        XCTAssertEqual(routeSharingRows(world).map { $0[field: "running"] }, [.string("default")],
                       "this launch still runs the default: the choice applies at the next one")
        XCTAssertEqual(engine.state.stateType, "idle")
        XCTAssertEqual(engine.state.session, .inactive, "a setting activates nothing")

        XCTAssertTrue(engine.handle(.command(.setRouteSharing(.standard), source: .tap)).ok)
        XCTAssertEqual(store.saves, [.longFormAudio, .standard], "and back")
        engine.teardown()
    }

    /// The command decodes from the page's JSON exactly as the contract
    /// spells it, and anything else is refused.
    /// TO SEE IT FAIL: decode `policy` as a free string.
    func testTheCommandDecodesFromTheContract() throws {
        func request(_ policy: String) throws -> EngineContract.SendRequest {
            try EngineContract.SendRequest(contract: .object([
                JSONMember("v", .number(1)), JSONMember("cmdSeq", .number(1)),
                JSONMember("cmd", .string("setRouteSharing")), JSONMember("source", .string("tap")),
                JSONMember("args", .object([JSONMember("policy", .string(policy))]))
            ]))
        }
        XCTAssertEqual(try request("longFormAudio").command, .setRouteSharing(.longFormAudio))
        XCTAssertEqual(try request("default").command, .setRouteSharing(.standard))
        XCTAssertThrowsError(try request("longForm"))
    }

    // MARK: - The real store

    /// The real store keeps the choice in the private key
    /// `ForayEngine.routeSharing`, outside `CapacitorStorage.`, and ignores a
    /// value it cannot read (the default then stands).
    /// TO SEE IT FAIL: key it under `CapacitorStorage.`, or read an unknown
    /// value as the trial.
    func testTheStoreKeepsTheChoiceInItsPrivateKey() throws {
        let suiteName = "ne40-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ne40-\(UUID().uuidString)", isDirectory: true)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: directory)
        }
        let store = EngineStore(defaults: defaults,
                                diagnostics: EngineDiagnostics(directory: directory, capacity: DiagRing.capacity) {
                                    (wallMs: 1_790_000_000_000, monoMs: 0)
                                })
        XCTAssertNil(store.loadRouteSharing())
        XCTAssertFalse(EngineBoot.routeSharingLongForm(store.loadRouteSharing()), "a fresh install runs the default")
        store.saveRouteSharing(.longFormAudio)
        XCTAssertEqual(defaults.string(forKey: "ForayEngine.routeSharing"), "longFormAudio")
        XCTAssertFalse(EnginePrivateKey.routeSharing.rawValue.hasPrefix(SharedRowStore.preferencesKeyPrefix))
        XCTAssertTrue(EngineBoot.routeSharingLongForm(store.loadRouteSharing()))
        defaults.set("longForm", forKey: EnginePrivateKey.routeSharing.rawValue)
        XCTAssertNil(store.loadRouteSharing(), "an unreadable value is no choice")
        store.purge()
        XCTAssertNil(defaults.object(forKey: "ForayEngine.routeSharing"), "Delete my data removes it")
    }
}

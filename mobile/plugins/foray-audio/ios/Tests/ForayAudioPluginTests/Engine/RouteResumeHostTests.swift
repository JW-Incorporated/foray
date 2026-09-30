import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// Card NE-38rs through the host and the REAL EngineStore: the known routes
/// live in the engine-private key `ForayEngine.knownRoutes` (never under
/// `CapacitorStorage.`), with the install's salt, and a new engine built on
/// the same store knows the car without hearing it again. The rule itself is
/// the core's (`RouteResumeTests`, and the `route-resume` parity family).
///
/// Each test names the edit that turns it red.
final class RouteResumeHostTests: XCTestCase {
    private var directory: URL!
    private var suiteName: String!
    private var suite: UserDefaults!

    static let carPlay = RoutePort(portType: "CarAudio", uid: "CarPlay-7F3A-UID")

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("route-resume-\(UUID().uuidString)", isDirectory: true)
        suiteName = "ne38rs-\(UUID().uuidString)"
        suite = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        suite.removePersistentDomain(forName: suiteName)
    }

    private func makeStore() -> EngineStore {
        var t: Double = 1_790_000_000_000
        return EngineStore(defaults: suite, diagnostics: EngineDiagnostics(directory: directory, capacity: DiagRing.capacity) {
            t += 1
            return (wallMs: t, monoMs: t - 1_790_000_000_000)
        })
    }

    /// An engine on `store`, playing item "a" through `route`, confirmed audible.
    @MainActor
    private func playing(_ world: FakeWorld, store: EngineStore, through route: RoutePort?) -> ForayEngine {
        world.session.route = route
        world.knownRoutesStore = store
        world.deck.answersReady = true
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()
        engine.handle(.queue(.load([ForayEngineHostTests.item("a")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        if let token = world.deck.lastToken {
            world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        }
        return engine
    }

    /// THE acceptance line: the known set survives an EngineStore reload.
    /// Heard through CarPlay for a second, the car goes: the host writes the
    /// salted key into `ForayEngine.knownRoutes`. A second engine on a store
    /// re-read from the same defaults, playing through the phone's speaker,
    /// knows the car when it goes and comes back, and resumes. The stored
    /// value holds no raw UID, and nothing lands under `CapacitorStorage.`.
    /// TO SEE IT FAIL: drop `persistKnownRoutesIfChanged()` from the host's
    /// turn, read the salt fresh on every launch, or store under a
    /// `CapacitorStorage.` key.
    @MainActor
    func testTheKnownSetSurvivesAnEngineStoreReload() throws {
        let first = FakeWorld()
        let engine = playing(first, store: makeStore(), through: RouteResumeHostTests.carPlay)
        first.timing.advance(1_500)
        first.session.post(.route(RouteChange(oldDeviceUnavailable: true, portType: "CarAudio",
                                              portUID: RouteResumeHostTests.carPlay.uid)))
        engine.teardown()

        let raw = try XCTUnwrap(suite.string(forKey: EnginePrivateKey.knownRoutes.rawValue), "nothing was persisted")
        XCTAssertEqual(EnginePrivateKey.knownRoutes.rawValue, "ForayEngine.knownRoutes")
        XCTAssertFalse(raw.contains("CarPlay-7F3A"), "the raw UID was persisted: \(raw)")
        let stored = try XCTUnwrap(RouteResume.Stored.parse(raw))
        XCTAssertEqual(stored.keys.count, 1)
        XCTAssertEqual(stored.keys.first, RouteResume.hashedKey(portType: "CarAudio", uid: RouteResumeHostTests.carPlay.uid,
                                                                salt: stored.salt))
        XCTAssertFalse(suite.dictionaryRepresentation().keys.contains { $0.hasPrefix("CapacitorStorage.") && $0.contains("route") })

        // A new launch: a new store over the same defaults, speaker only.
        let second = FakeWorld()
        let reloaded = playing(second, store: makeStore(), through: nil)
        XCTAssertEqual(reloaded.state.knownRoutes.keys, stored.keys, "the reload lost the known set")
        second.timing.advance(1_000)
        second.session.post(.route(RouteChange(oldDeviceUnavailable: true, portType: "CarAudio",
                                               portUID: RouteResumeHostTests.carPlay.uid)))
        second.timing.advance(1_000)
        second.session.post(.route(RouteChange(oldDeviceUnavailable: false, portType: "CarAudio",
                                               portUID: RouteResumeHostTests.carPlay.uid)))
        XCTAssertTrue(reloaded.state.isRunning, "the known car did not resume after the reload: \(second.log.entries.suffix(12))")
        XCTAssertTrue(reloaded.state.routeResume.playing)
        XCTAssertEqual(reloaded.state.routeResume.pausedBy, .none)
        reloaded.teardown()
    }

    /// Delete my data: the purge removes `ForayEngine.knownRoutes` with every
    /// other private key, and the host does not write it back.
    /// TO SEE IT FAIL: persist an empty set as a value instead of removing the
    /// key, or skip the core's reset of the set on `stop(persist: false)`.
    @MainActor
    func testADataDeletionLeavesNoKnownRoutes() throws {
        let world = FakeWorld()
        let store = makeStore()
        let engine = playing(world, store: store, through: RouteResumeHostTests.carPlay)
        world.timing.advance(1_500)
        world.session.post(.route(RouteChange(oldDeviceUnavailable: true, portType: "CarAudio",
                                              portUID: RouteResumeHostTests.carPlay.uid)))
        XCTAssertNotNil(suite.string(forKey: EnginePrivateKey.knownRoutes.rawValue))
        engine.handle(.command(.purge, source: .tap))
        store.purge()
        XCTAssertNil(suite.string(forKey: EnginePrivateKey.knownRoutes.rawValue))
        XCTAssertEqual(engine.state.knownRoutes.keys, [])
        engine.handle(.command(.pause, source: .tap))
        XCTAssertNil(suite.string(forKey: EnginePrivateKey.knownRoutes.rawValue), "the host wrote the routes back")
        engine.teardown()
    }
}

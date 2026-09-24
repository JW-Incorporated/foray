import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin
#if canImport(PreferencesPlugin)
import PreferencesPlugin
#endif

/// EngineStore and EngineDiagnostics on the Simulator (card NE-19;
/// docs/native-engine-plan.md §4.6, §10). The ring's own rules run in the
/// core's host tests (`DiagRingTests`); these are the parts only a device-like
/// process has: `UserDefaults.standard` shared with `@capacitor/preferences`,
/// Application Support, and the host driving the real store.
///
/// Each test names the edit that turns it red.
final class EngineStoreTests: XCTestCase {
    private var directory: URL!
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-store-\(UUID().uuidString)", isDirectory: true)
        suiteName = "ne19-\(UUID().uuidString)"
        suite = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        suite.removePersistentDomain(forName: suiteName)
    }

    private func makeDiagnostics(capacity: Int = DiagRing.capacity) -> EngineDiagnostics {
        var t: Double = 1_790_000_000_000
        return EngineDiagnostics(directory: directory, capacity: capacity) {
            t += 1
            return (wallMs: t, monoMs: t - 1_790_000_000_000)
        }
    }

    // MARK: - Shared rows, with the page

    /// THE acceptance line: the host, driving the REAL store, writes `cp_pos`
    /// and `@capacitor/preferences` (the page's own reader) gets the identical
    /// string: the core's `JSWriter` bytes, unchanged. Then backgrounding
    /// flushes the playhead through the same path before the handler returns.
    /// TO SEE IT FAIL: store the row under the bare key (no
    /// `CapacitorStorage.` prefix), or re-serialise the value; drop the
    /// background flush in the core or the host's `lifecycle`.
    @MainActor
    func testTheEngineWritesCpPosAndPreferencesReadsTheIdenticalString() throws {
        let id = "ne19-\(UUID().uuidString.prefix(8))"
        let rowKey = Rows.positionKey(id)
        let rawKey = SharedRowStore.userDefaultsKey(for: rowKey)
        defer {
            UserDefaults.standard.removeObject(forKey: rawKey)
            UserDefaults.standard.removeObject(forKey: EnginePrivateKey.restore.rawValue)
        }

        let world = FakeWorld()
        let store = EngineStore(defaults: .standard, diagnostics: makeDiagnostics())
        let seams = EngineSeams(session: world.session, background: world.background, remote: world.remote,
                                nowPlaying: world.nowPlaying, deck: world.deck, speaker: world.speaker,
                                timing: world.timing, output: store)
        world.deck.answersReady = true
        let engine = ForayEngine(seams: seams, config: EngineConfig(build: "test"))
        engine.start()
        let item = EngineItem(node: .object([JSONMember("id", .string(id)), JSONMember("kind", .string("episode")),
                                             JSONMember("audio_url", .string("https://cdn.example/\(id).mp3"))]))!
        engine.handle(.queue(.load([item])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        world.deck.reading.positionSec = 120
        world.timing.fire(afterMs: ResumeRules.positionIntervalMs)

        let stamp = try XCTUnwrap(Rows.timestamp(epochMs: world.timing.wallMs))
        let expected = try XCTUnwrap(Rows.position(id: id, seconds: 120, duration: 3600, updatedAt: stamp)).value
        XCTAssertEqual(UserDefaults.standard.string(forKey: rawKey), expected)
        XCTAssertEqual(store.readShared(rowKey), expected)
        XCTAssertEqual(store.sharedRows(prefixes: [rowKey])[rowKey], expected, "engineRead(\"rows\") answers the same bytes")
        #if canImport(PreferencesPlugin)
        XCTAssertEqual(Preferences(with: PreferencesConfiguration()).get(by: rowKey), expected,
                       "the page's reader gets the engine's string, byte for byte")
        #endif

        engine.handle(.command(.pause, source: .tap))
        world.deck.reading.positionSec = 1_394
        world.timing.advance(1_000)
        world.background.post(.background)
        let flushed = try XCTUnwrap(Rows.timestamp(epochMs: world.timing.wallMs))
        XCTAssertEqual(UserDefaults.standard.string(forKey: rawKey),
                       Rows.position(id: id, seconds: 1_394, duration: 3600, updatedAt: flushed)?.value,
                       "a paused episode, pocketed, keeps where it was paused (#689)")
        #if canImport(PreferencesPlugin)
        XCTAssertEqual(Preferences(with: PreferencesConfiguration()).get(by: rowKey),
                       UserDefaults.standard.string(forKey: rawKey))
        #endif
        engine.teardown()
    }

    /// The engine writes ONLY its own rows under `CapacitorStorage.`.
    /// TO SEE IT FAIL: drop the `isOwnedRow` guard in `writeShared`.
    func testTheStoreRefusesARowItDoesNotOwn() {
        let store = EngineStore(defaults: suite, diagnostics: makeDiagnostics())
        XCTAssertFalse(store.writeShared(StoredRow(key: "cp_rate", value: "1.5")))
        XCTAssertNil(suite.object(forKey: SharedRowStore.userDefaultsKey(for: "cp_rate")))
        let fault = store.diagnostics.rows.last
        XCTAssertEqual(fault?.kind, "fault")
        XCTAssertEqual(fault?[field: "event"], .string("not-owned"))
        XCTAssertTrue(store.writeShared(StoredRow(key: "cp_last_episode", value: "{\"id\":\"a\"}")))
    }

    // MARK: - Private keys and purge

    /// No engine-only key is under `CapacitorStorage.`, where DurableStore
    /// would hydrate, mirror and clobber it (§4.6).
    /// TO SEE IT FAIL: prefix a private key with `CapacitorStorage.`.
    func testNoPrivateKeyHasTheCapacitorStoragePrefix() {
        let store = EngineStore(defaults: suite, diagnostics: makeDiagnostics())
        for key in EnginePrivateKey.allCases { store.set("x", for: key) }
        store.writeRestore(RestoreRecord.relinquished(updatedAt: "2026-09-24T00:00:00.000Z", build: "1"))
        let raw = suite.dictionaryRepresentation().keys
        for key in EnginePrivateKey.allCases {
            XCTAssertTrue(raw.contains(key.rawValue), key.rawValue)
            XCTAssertFalse(key.rawValue.hasPrefix(SharedRowStore.preferencesKeyPrefix), key.rawValue)
        }
        XCTAssertFalse(raw.contains { $0.hasPrefix(SharedRowStore.preferencesKeyPrefix) && $0.contains("ForayEngine") })
        XCTAssertEqual(store.restoreRecord()?.mode, .relinquished)
    }

    /// Delete my data: every shared engine row, every `ForayEngine.*` key
    /// (today's six AND one a later card might add) and the ring file are
    /// gone, enumerated; the page's own rows are the page's to clear.
    /// TO SEE IT FAIL: purge only `EnginePrivateKey.allCases`, skip the ring
    /// file, or remove every `CapacitorStorage.` key.
    ///
    /// On `UserDefaults.standard`, the domain the app really uses, so the
    /// enumeration sees exactly what a device would (a suite's view also
    /// searches the global domain).
    func testPurgeLeavesNoEngineKeyOrFile() throws {
        let defaults = UserDefaults.standard
        let pageRate = SharedRowStore.userDefaultsKey(for: "cp_rate")
        let pageWatermark = SharedRowStore.userDefaultsKey(for: "cp_engine_applied")
        defer {
            defaults.removeObject(forKey: pageRate)
            defaults.removeObject(forKey: pageWatermark)
        }
        let store = EngineStore(defaults: defaults, diagnostics: makeDiagnostics())
        for row in ["cp_pos:ep-1", "cp_foray:f-1", "cp_last_episode"] {
            XCTAssertTrue(store.writeShared(StoredRow(key: row, value: "{}")))
        }
        for key in EnginePrivateKey.allCases { store.set("x", for: key) }
        defaults.set("later", forKey: "ForayEngine.someFutureKey")
        defaults.set("1.5", forKey: SharedRowStore.userDefaultsKey(for: "cp_rate"))
        defaults.set("{}", forKey: SharedRowStore.userDefaultsKey(for: "cp_engine_applied"))
        store.diag(DiagEntry(kind: "remote", fields: [JSONMember("cmd", .string("play"))]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.diagnostics.fileURL.path))

        let removed = store.purge()
        XCTAssertTrue(removed.contains("ForayEngine.someFutureKey"))
        XCTAssertTrue(removed.contains(store.diagnostics.fileURL.path))
        let left = defaults.dictionaryRepresentation().keys.filter {
            EngineKeys.isPrivate(rawKey: $0) || EngineKeys.sharedRowKey(rawKey: $0) != nil
        }
        XCTAssertEqual(left, [], "engine keys survived the purge")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.diagnostics.fileURL.path), "the ring file survived")
        XCTAssertEqual(store.diagnostics.rows, [])
        XCTAssertEqual(defaults.string(forKey: SharedRowStore.userDefaultsKey(for: "cp_rate")), "1.5", "the page's row")
        XCTAssertEqual(defaults.string(forKey: SharedRowStore.userDefaultsKey(for: "cp_engine_applied")), "{}",
                       "the page's watermark: the page's own purge clears it (NE-23)")
    }

    // MARK: - The ring, where the app keeps it

    /// The ring lives in Application Support (not Documents, not Caches),
    /// survives a relaunch and caps at 2,000.
    /// TO SEE IT FAIL: point `defaultDirectory` at Caches; keep rows in memory.
    func testTheRingSurvivesARelaunchAndCapsAt2000() throws {
        let path = EngineDiagnostics.defaultDirectory().path
        XCTAssertTrue(path.hasSuffix("Library/Application Support/foray-engine"), path)

        let first = makeDiagnostics()
        for i in 0..<2_100 {
            first.record(DiagEntry(kind: "remote", fields: [JSONMember("n", .number(Double(i)))]))
        }
        XCTAssertEqual(first.rows.count, 2_000)
        let relaunched = makeDiagnostics()
        XCTAssertEqual(relaunched.rows.count, 2_000)
        XCTAssertEqual(relaunched.rows.first?.seq, 101)
        XCTAssertEqual(relaunched.record(DiagEntry(kind: "build", fields: []))?.seq, 2_101)
        let backup = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(backup.isExcludedFromBackup, true, "one phone's drive is not restored onto another")
    }

    /// A bad token is dropped on the way in through the real output path.
    /// TO SEE IT FAIL: write `diag` entries to the ring without the gate.
    func testABadTokenIsDroppedThroughTheStore() {
        let store = EngineStore(defaults: suite, diagnostics: makeDiagnostics())
        store.diag(DiagEntry(kind: "stop", fields: [JSONMember("cause", .string("Pause")),
                                                    JSONMember("state", .string("paused"))]))
        let row = store.diagnostics.rows.last
        XCTAssertNil(row?[field: "cause"])
        XCTAssertEqual(row?[field: "state"], .string("paused"))
        XCTAssertEqual(row?[field: "dropped"], .array([.string("cause")]))
    }

    /// The packed seam row is ONE row, whatever stages it lists.
    /// TO SEE IT FAIL: write a row per stage in `seam(_:)`.
    func testASeamIsOneRow() {
        let diagnostics = makeDiagnostics()
        diagnostics.seam(SeamRow(observedGapMs: 512, askedGapMs: 500, prepared: true, grace: true, bgRemainingMs: 28_000,
                                 stages: Vocabulary.Stage.allCases))
        XCTAssertEqual(diagnostics.rows.count, 1)
        XCTAssertEqual(diagnostics.rows.first.flatMap { SeamRow($0) }?.stages, Vocabulary.Stage.allCases)
    }
}

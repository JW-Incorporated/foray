import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// ResolvedSources and the store that keeps it inside the restore record (the
/// founder's car report, 2026-10-14: a car-triggered cold resume through a
/// podtrac -> libsyn redirect chain took 6.4 s to its duration). The deck's use
/// of it (attach, fall back) is AVDeckTests' `testAResume...` pair; these are
/// the rules and the storage, with no AVFoundation.
///
/// Each test names the edit that turns it red.
final class ResolvedSourcesTests: XCTestCase {
    private let original = "https://dts.podtrac.com/redirect.mp3/traffic.libsyn.com/show/ep.mp3"
    private let edge = "https://delivery-edge.libsyn.com/show/ep.mp3?dest-id=1"
    private var nowMs: Double = 1_790_000_000_000

    private func sources(_ entries: [ResolvedSources.Entry] = []) -> ResolvedSources {
        ResolvedSources(entries: entries, wallMs: { [unowned self] in self.nowMs })
    }

    // MARK: - When a resolved address may be used

    /// Only a RESUME of a whole episode: a play from the top, a Foray clip
    /// and a narration line attach their own URL (corner case #1: the
    /// publisher counts downloads at the URL it declared).
    /// TO SEE IT FAIL: drop `startSec > 0` from `eligible` (a fresh play from
    /// 0 would skip the prefix), or the `!bounded` or `.clip` clause.
    func testOnlyAResumeOfAWholeEpisodeIsEligible() {
        XCTAssertTrue(ResolvedSources.eligible(startSec: 3839.049, bounded: false, deadlineClass: .clip))
        XCTAssertFalse(ResolvedSources.eligible(startSec: 0, bounded: false, deadlineClass: .clip), "a fresh play")
        XCTAssertFalse(ResolvedSources.eligible(startSec: 120, bounded: true, deadlineClass: .clip), "a Foray clip")
        XCTAssertFalse(ResolvedSources.eligible(startSec: 3, bounded: false, deadlineClass: .line), "a narration line")
        XCTAssertFalse(ResolvedSources.eligible(startSec: .nan, bounded: false, deadlineClass: .clip))

        let store = sources()
        store.remember(from: original, to: edge)
        XCTAssertEqual(store.target(for: original, startSec: 3839.049, bounded: false, deadlineClass: .clip), edge)
        XCTAssertNil(store.target(for: original, startSec: 0, bounded: false, deadlineClass: .clip))
        XCTAssertNil(store.target(for: original, startSec: 3839.049, bounded: true, deadlineClass: .clip))
        XCTAssertNil(store.target(for: "https://other.example/ep.mp3", startSec: 60, bounded: false, deadlineClass: .clip))
    }

    /// 24 h from the load that went through the prefix chain, and no longer:
    /// past it the resume goes through the prefix again. A clock that moved
    /// backwards reads as stale, never as fresh.
    /// TO SEE IT FAIL: drop the `ageMs <= maxAgeSec` check, or the `ageMs >= 0` one.
    func testAnEntryIsUsedForTwentyFourHoursOnly() {
        let store = sources()
        store.remember(from: original, to: edge)
        nowMs += ResolvedSources.maxAgeSec * 1000
        XCTAssertEqual(store.target(for: original, startSec: 60, bounded: false, deadlineClass: .clip), edge, "at 24 h")
        nowMs += 1
        XCTAssertNil(store.target(for: original, startSec: 60, bounded: false, deadlineClass: .clip), "past 24 h")
        let skewed = sources([ResolvedSources.Entry(from: original, to: edge, atMs: nowMs + 60_000)])
        XCTAssertNil(skewed.target(for: original, startSec: 60, bounded: false, deadlineClass: .clip), "from the future")
    }

    /// What may be kept from an access log: an absolute https address with a
    /// host that is not the load's own URL; never from a local file.
    /// TO SEE IT FAIL: drop the `https` check (an http CDN address would be
    /// attached, and ATS refuses it), or the `!= original` one.
    func testOnlyARedirectToAnHttpsAddressIsKept() {
        XCTAssertEqual(ResolvedSources.candidate(from: original, accessURI: edge), edge)
        XCTAssertNil(ResolvedSources.candidate(from: original, accessURI: original), "no redirect")
        XCTAssertNil(ResolvedSources.candidate(from: original, accessURI: nil))
        XCTAssertNil(ResolvedSources.candidate(from: original, accessURI: "http://delivery-edge.libsyn.com/ep.mp3"))
        XCTAssertNil(ResolvedSources.candidate(from: original, accessURI: "https:///no-host.mp3"))
        XCTAssertNil(ResolvedSources.candidate(from: "file:///var/mobile/ep.mp3", accessURI: edge), "a download")
    }

    /// A newer address replaces the old one for the same source, the set stays
    /// small, and every change (and only a change) asks the store to write.
    /// TO SEE IT FAIL: drop the cap in `remember`, or call `onChange` from
    /// `clear()` (the purge would write the sources straight back).
    func testRememberForgetAndClear() {
        let store = sources()
        var writes = 0
        store.onChange = { writes += 1 }
        store.remember(from: original, to: edge)
        store.remember(from: original, to: "https://edge2.example/ep.mp3")
        XCTAssertEqual(store.entries.map(\.to), ["https://edge2.example/ep.mp3"])
        for index in 0..<6 { store.remember(from: "https://p.example/\(index).mp3", to: "https://cdn.example/\(index).mp3") }
        XCTAssertEqual(store.entries.count, ResolvedSources.capacity)
        XCTAssertEqual(store.entries.last?.from, "https://p.example/5.mp3", "the newest is kept")
        XCTAssertEqual(writes, 8)
        store.forget(from: "https://p.example/5.mp3")
        store.forget(from: "https://never.example/x.mp3")
        XCTAssertEqual(writes, 9, "forgetting nothing writes nothing")
        store.clear()
        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertNil(store.node)
        XCTAssertEqual(writes, 9, "a purge must not write the sources back")
    }

    // MARK: - Kept inside the restore record

    private var directory: URL!
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("resolved-sources-\(UUID().uuidString)", isDirectory: true)
        suiteName = "resolved-\(UUID().uuidString)"
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

    private func record(_ mode: RestoreRecord.Mode = .episode) -> RestoreRecord {
        RestoreRecord(mode: mode, queue: [.object([JSONMember("id", .string("ep-1")),
                                                    JSONMember("audio_url", .string(original))])],
                      index: 0, offsetSec: 3839.049, rate: 1, updatedAt: "2026-10-14T22:29:00.000Z", build: "2026101302")
    }

    /// THE COLD PATH: a resolved address learnt in one process is in the next
    /// one's sources (a car's play is a background launch), it rides inside
    /// `ForayEngine.restore` (no new key: the privacy policy lists the keys),
    /// and the record still parses to exactly what the core wrote.
    /// TO SEE IT FAIL: write the record with `record.serialized()` alone in
    /// `writeRestore` (the next launch has no sources), or make
    /// `RestoreRecord.parse` refuse an unknown member (the cold path loses
    /// the record itself).
    func testSourcesSurviveARelaunchInsideTheRestoreRecord() throws {
        let first = makeStore()
        let learnt = first.attachResolvedSources(wallMs: { [unowned self] in self.nowMs })
        first.writeRestore(record())
        learnt.remember(from: original, to: edge)
        let raw = try XCTUnwrap(suite.string(forKey: EnginePrivateKey.restore.rawValue))
        XCTAssertTrue(raw.contains("\"sources\":[{\"from\":"), raw)
        XCTAssertEqual(RestoreRecord.parse(raw), record(), "the sources member must not change what the core reads")
        XCTAssertEqual(suite.dictionaryRepresentation().keys.filter { $0.hasPrefix("ForayEngine.") }.sorted(),
                       [EnginePrivateKey.restore.rawValue], "no key of its own")

        // The next launch.
        let second = makeStore()
        let restored = second.attachResolvedSources(wallMs: { [unowned self] in self.nowMs + 60_000 })
        XCTAssertEqual(restored.target(for: original, startSec: 3839.049, bounded: false, deadlineClass: .clip), edge)
        XCTAssertEqual(second.restoreRecord(), record())

        // The core's next write keeps them.
        second.writeRestore(record())
        XCTAssertEqual(ResolvedSources.entries(inRecord: suite.string(forKey: EnginePrivateKey.restore.rawValue)).map(\.to),
                       [edge])
    }

    /// A relinquished record promises nothing to restore, so it carries no
    /// sources; Delete my data leaves none in memory or on disk.
    /// TO SEE IT FAIL: drop the `.relinquished` clause in `restoreText`, or
    /// the `resolvedSources?.clear()` in `purge()`.
    func testARelinquishedRecordAndAPurgeKeepNoSources() throws {
        let store = makeStore()
        let sources = store.attachResolvedSources(wallMs: { [unowned self] in self.nowMs })
        store.writeRestore(record())
        sources.remember(from: original, to: edge)
        store.writeRestore(RestoreRecord.relinquished(updatedAt: "2026-10-14T22:30:00.000Z", build: "2026101302"))
        let raw = try XCTUnwrap(suite.string(forKey: EnginePrivateKey.restore.rawValue))
        XCTAssertFalse(raw.contains("sources"), raw)

        store.writeRestore(record())
        XCTAssertTrue(try XCTUnwrap(suite.string(forKey: EnginePrivateKey.restore.rawValue)).contains("sources"))
        store.purge()
        XCTAssertTrue(sources.entries.isEmpty)
        XCTAssertNil(suite.string(forKey: EnginePrivateKey.restore.rawValue))
        sources.remember(from: original, to: edge)
        XCTAssertNil(suite.string(forKey: EnginePrivateKey.restore.rawValue),
                     "after a purge nothing is written until the core writes a record again")
    }
}

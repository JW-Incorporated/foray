import XCTest
@testable import ForayEngineCore

/// The diagnostics ring and its gate (card NE-19; docs/native-engine-plan.md
/// §4.1, §10, §13 item 37), on a host `swift test` (macOS in ios-kit, Linux in
/// engine-parity): a real file in a temporary directory, no Simulator.
///
/// Each test names the edit that turns it red.
final class DiagRingTests: XCTestCase {
    static let t0: Double = 1_790_000_000_123

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("diag-ring-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var fileURL: URL { directory.appendingPathComponent(EngineKeys.diagFileName) }

    private func makeRing(capacity: Int = DiagRing.capacity, slack: Int = DiagRing.slack) -> DiagRing {
        DiagRing(fileURL: fileURL, capacity: capacity, slack: slack)
    }

    private func fileLines() throws -> [String] {
        let text = try String(contentsOf: fileURL, encoding: .utf8)
        return text.split(separator: "\n").map(String.init)
    }

    private func entry(_ kind: String, _ fields: [JSONMember] = []) -> DiagEntry {
        DiagEntry(kind: kind, fields: fields)
    }

    // MARK: - Durable, monotonic, capped

    /// A row is on disk when `append` returns, and a new ring over the same
    /// file (the next launch) has it and continues the numbering.
    /// TO SEE IT FAIL: keep rows in memory only (skip `appendLine`), or start
    /// `nextSeq` at 1 in `load`.
    func testTheRingSurvivesARelaunchAndSeqContinues() throws {
        let first = makeRing()
        first.append(entry("build", [JSONMember("launch", .string("foreground"))]), wallMs: Self.t0, monoMs: 5)
        first.append(entry("remote", [JSONMember("cmd", .string("play"))]), wallMs: Self.t0 + 1, monoMs: 6)
        XCTAssertEqual(try fileLines().count, 2, "each row is written before append returns")

        let relaunched = makeRing()
        XCTAssertEqual(relaunched.rows.map(\.seq), [1, 2])
        XCTAssertEqual(relaunched.rows.map(\.kind), ["build", "remote"])
        XCTAssertEqual(relaunched.rows.first?.wallMs, Self.t0, "the wall clock Copy merges by is kept")
        let next = try XCTUnwrap(relaunched.append(entry("session"), wallMs: Self.t0 + 2, monoMs: 1))
        XCTAssertEqual(next.seq, 3, "seq is monotonic across launches, even though the monotonic clock restarted")
    }

    /// 2,000 rows and no more, however many were written; the file stays
    /// within the slack and a relaunch still reads exactly the newest 2,000.
    /// TO SEE IT FAIL: drop the `removeFirst` in `store`, or never `rewrite`.
    func testTheRingCapsAt2000Rows() throws {
        let ring = makeRing()
        for i in 0..<2_750 {
            ring.append(entry("remote", [JSONMember("n", .number(Double(i)))]), wallMs: Self.t0 + Double(i), monoMs: Double(i))
        }
        XCTAssertEqual(ring.rows.count, 2_000)
        XCTAssertEqual(ring.rows.first?.seq, 751, "the OLDEST rows go")
        XCTAssertEqual(ring.rows.last?.seq, 2_750)
        let lines = try fileLines()
        XCTAssertLessThanOrEqual(lines.count, DiagRing.capacity + DiagRing.slack, "the file is compacted")
        XCTAssertGreaterThanOrEqual(lines.count, DiagRing.capacity)

        let relaunched = makeRing()
        XCTAssertEqual(relaunched.rows.count, 2_000)
        XCTAssertEqual(relaunched.rows.first?.seq, 751)
        XCTAssertEqual(relaunched.nextSeq, 2_751)
    }

    /// Plan §13 item 37: a 51-minute, 32-segment Foray (31 seams plus the
    /// session, remote and nowplaying rows around them) still holds seam 1
    /// when the founder presses Copy after the drive. The same drive logged
    /// one row per load stage into revision 1's 200-row ring loses it, which
    /// is what the packed seam row and the 2,000-row file ring are for.
    /// TO SEE IT FAIL: set `DiagRing.capacity` to 200.
    func testA51MinuteForayStillHoldsSeamOne() throws {
        func drive(into ring: DiagRing, packed: Bool) {
            var t = Self.t0
            func put(_ e: DiagEntry) { t += 250; ring.append(e, wallMs: t, monoMs: t - Self.t0) }
            put(BuildRow(engineVersion: "1", bundleVersion: "2026092400", launch: .foreground, holdPolicy: .forever).entry)
            put(entry("session", [JSONMember("kind", .string("activate")), JSONMember("ok", .bool(true)),
                                  JSONMember("activateMs", .number(12))]))
            let stages: [Vocabulary.Stage] = [.attach, .duration, .gate, .readiness, .seek, .preroll, .ready, .play, .playing]
            for segment in 0..<32 {
                put(entry("nowplaying", [JSONMember("title", .string("Segment \(segment) of a long Foray")),
                                         JSONMember("rate", .number(1))]))
                // Two lock-screen or wheel presses per segment, and a Now
                // Playing write for each (a pessimistic drive).
                for command in ["pause", "play"] {
                    put(entry("remote", [JSONMember("cmd", .string(command)), JSONMember("route", .string("carAudio")),
                                         JSONMember("dupCandidate", .string("n"))]))
                    put(entry("nowplaying", [JSONMember("title", .string("Segment \(segment)")),
                                             JSONMember("rate", .number(command == "play" ? 1 : 0))]))
                }
                // A navigation prompt every fourth segment.
                if segment % 4 == 0 {
                    put(entry("session", [JSONMember("kind", .string("interruption")), JSONMember("phase", .string("began")),
                                          JSONMember("reason", .string("default"))]))
                    put(entry("session", [JSONMember("kind", .string("interruption")), JSONMember("phase", .string("ended")),
                                          JSONMember("resumed", .bool(true))]))
                }
                guard segment < 31 else { continue }
                let seam = SeamRow(observedGapMs: 540 + Double(segment), askedGapMs: 500, prepared: true, grace: false,
                                   bgRemainingMs: nil, stages: stages)
                if packed {
                    put(seam.entry)
                } else {
                    // Revision 1: one row per stage, the seam's verdict on the last.
                    for stage in stages {
                        put(entry("stage", [JSONMember("stage", .string(stage.rawValue)), JSONMember("seam", .number(Double(segment)))]))
                    }
                    put(seam.entry)
                }
            }
        }

        let ring = makeRing()
        drive(into: ring, packed: true)
        let seams = ring.rows.filter { $0.kind == SeamRow.kind }
        XCTAssertEqual(seams.count, 31, "every seam of the drive is in the ring")
        XCTAssertEqual(seams.first.flatMap { SeamRow($0) }?.observedGapMs, 540, "seam 1 survives the whole Foray")
        XCTAssertEqual(ring.rows.first?.kind, "build", "nothing has been evicted at all")
        XCTAssertEqual(makeRing().rows.filter { $0.kind == SeamRow.kind }.count, 31, "and it survives a relaunch")

        let revisionOne = DiagRing(fileURL: directory.appendingPathComponent("rev1.jsonl"), capacity: 200, slack: 0)
        drive(into: revisionOne, packed: false)
        XCTAssertNotEqual(revisionOne.rows.first(where: { $0.kind == SeamRow.kind }).flatMap { SeamRow($0) }?.observedGapMs,
                          540, "premise: one row per stage in a 200-row ring loses seam 1")
    }

    /// A process killed mid-write leaves a torn last line: it costs that row
    /// only, and the next row is not glued onto it.
    /// TO SEE IT FAIL: drop the `needsRewrite` check in `store`.
    func testATornTailCostsOneRowAndTheNextRowIsClean() throws {
        let first = makeRing()
        first.append(entry("remote"), wallMs: Self.t0, monoMs: 1)
        first.append(entry("remote"), wallMs: Self.t0 + 1, monoMs: 2)
        let handle = try FileHandle(forWritingTo: fileURL)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("{\"seq\":3,\"at\":17900".utf8))
        try handle.close()

        let relaunched = makeRing()
        XCTAssertEqual(relaunched.rows.map(\.seq), [1, 2])
        relaunched.append(entry("session"), wallMs: Self.t0 + 3, monoMs: 1)
        let lines = try fileLines()
        XCTAssertEqual(lines.count, 3)
        XCTAssertNotNil(lines.last.flatMap { DiagRow.parse($0) }, "the new row reads back on its own line")
        XCTAssertEqual(makeRing().rows.map(\.seq), [1, 2, 3])
    }

    /// Data deletion: the file goes, the rows go, and numbering restarts.
    /// TO SEE IT FAIL: keep the file in `purge`.
    func testPurgeRemovesTheFile() throws {
        let ring = makeRing()
        ring.append(entry("remote"), wallMs: Self.t0, monoMs: 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        try ring.purge()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertEqual(ring.rows, [])
        XCTAssertEqual(makeRing().rows, [], "a relaunch finds nothing")
        XCTAssertEqual(ring.append(entry("remote"), wallMs: Self.t0, monoMs: 1)?.seq, 1)
    }

    // MARK: - The gate

    /// A token outside its closed vocabulary is DROPPED, not corrected, and
    /// the row says which field it lost.
    /// TO SEE IT FAIL: remove the `cause` case from `vocabularySet`, or stop
    /// appending to `dropped`.
    func testABadTokenIsDroppedAndNamed() throws {
        let ring = makeRing()
        let stop = try XCTUnwrap(ring.append(entry("stop", [
            JSONMember("cause", .string("graceExpired")),
            JSONMember("source", .string("remote")),
            JSONMember("item", .string("ep-1"))
        ]), wallMs: Self.t0, monoMs: 1))
        XCTAssertNil(stop[field: "cause"], "`graceExpired` is not `grace-expired`: dropped")
        XCTAssertEqual(stop[field: "source"], .string("remote"))
        XCTAssertEqual(stop[field: "dropped"], .array([.string("cause")]))

        let interruption = try XCTUnwrap(ring.append(entry("session", [
            JSONMember("kind", .string("interruption")), JSONMember("reason", .string("Default"))
        ]), wallMs: Self.t0, monoMs: 2))
        XCTAssertNil(interruption[field: "reason"], "interruption reasons are Apple's spelling, exactly")

        let seam = SeamRow(observedGapMs: 600, askedGapMs: 500, prepared: false, grace: true, bgRemainingMs: 25_000,
                           stages: [.attach, .readiness])
        var fields = seam.fields
        fields.removeAll { $0.key == "stages" }
        fields.append(JSONMember("stages", .array([.string("attach"), .string("Seek"), .string("readiness")])))
        let packed = try XCTUnwrap(ring.append(entry(SeamRow.kind, fields), wallMs: Self.t0, monoMs: 3))
        XCTAssertEqual(packed[field: "stages"], .array([.string("attach"), .string("readiness")]))
        XCTAssertEqual(packed[field: "dropped"], .array([.string("stages")]))

        let mode = try XCTUnwrap(ring.append(entry("mode", [JSONMember("reason", .string("crash-loop"))]),
                                             wallMs: Self.t0, monoMs: 4))
        XCTAssertEqual(mode[field: "reason"], .string("crash-loop"))
        XCTAssertNil(mode[field: "dropped"], "a clean row carries no dropped list")
    }

    /// No URL, no route name, no sentence: the three leaks the gate exists for.
    /// TO SEE IT FAIL: let `isToken` admit `/` or a space, or drop the
    /// `routeName`-style key rule.
    func testNoURLsNoRouteNamesAndNoFreeText() throws {
        let ring = makeRing()
        let row = try XCTUnwrap(ring.append(entry("remote", [
            JSONMember("cmd", .string("next")),
            JSONMember("route", .string("carAudio")),
            JSONMember("item", .string("https://cdn.example/ep-1.mp3")),
            JSONMember("audio_url", .string("cdn-example")),
            JSONMember("routeName", .string("MAZDA")),
            JSONMember("why", .string("the deck was audible while the machine said paused")),
            JSONMember("port", .string("Wyatt's AirPods")),
            JSONMember("owner", .string("wyatt@example.com"))
        ]), wallMs: Self.t0, monoMs: 1))
        XCTAssertEqual(row[field: "cmd"], .string("next"))
        XCTAssertEqual(row[field: "route"], .string("carAudio"), "a port type is kept")
        for key in ["item", "audio_url", "routeName", "why", "port", "owner"] {
            XCTAssertNil(row[field: key], key)
        }
        XCTAssertEqual(row[field: "dropped"], .array(["item", "audio_url", "routeName", "why", "port", "owner"].map { JSONNode.string($0) }))
        let line = row.line()
        for leak in ["https", "cdn", "MAZDA", "machine", "AirPods", "@"] {
            XCTAssertFalse(line.contains(leak), "\(leak) reached the ring: \(line)")
        }
    }

    /// The Now Playing strings are the ONE free text, capped exactly as the
    /// page caps its own (`nowPlayingFieldOf`), and never in the unified log.
    /// TO SEE IT FAIL: cap at 60, or let `loggerText` print the title.
    func testNowPlayingTextIsCappedAt40AndKeptOutOfTheLogger() throws {
        let ring = makeRing()
        let title = "  The Long Title of an Episode That Goes On and On Forever  "
        let row = try XCTUnwrap(ring.append(entry(DiagGate.nowPlayingKind, [
            JSONMember("title", .string(title)), JSONMember("artist", .string("A Show")),
            JSONMember("album", .string("")), JSONMember("rate", .number(1))
        ]), wallMs: Self.t0, monoMs: 1))
        let capped = try XCTUnwrap(row[field: "title"]?.stringValue)
        // `s.slice(0, 39) + "…"` of the trimmed title: the 39th unit is a space.
        XCTAssertEqual(capped, "The Long Title of an Episode That Goes \u{2026}")
        XCTAssertEqual(capped.utf16.count, 40)
        XCTAssertEqual(row[field: "artist"], .string("A Show"))
        XCTAssertNil(row[field: "dropped"])

        XCTAssertEqual(DiagGate.loggerText(row), "#1 nowplaying title=y artist=y album=n rate=1")

        let elsewhere = try XCTUnwrap(ring.append(entry("remote", [JSONMember("title", .string("A Show"))]),
                                                  wallMs: Self.t0, monoMs: 2))
        XCTAssertNil(elsewhere[field: "title"], "free text only in a nowplaying row")
    }

    /// A field named `kind` is the row's sub-kind; it cannot shadow the row
    /// header, so the gate writes it as `event`.
    /// TO SEE IT FAIL: map `kind` to itself in `admit` (DiagRow then drops it).
    func testTheSubKindIsWrittenAsEvent() throws {
        let ring = makeRing()
        let row = try XCTUnwrap(ring.append(entry("session", [
            JSONMember("kind", .string("interruption")), JSONMember("phase", .string("began")),
            JSONMember("reason", .string("appWasSuspended")), JSONMember("running", .bool(false))
        ]), wallMs: Self.t0, monoMs: 81_234.5))
        XCTAssertEqual(row.line(), "{\"seq\":1,\"at\":1790000000123,\"mono\":81234.5,\"kind\":\"session\",\"event\":\"interruption\","
                       + "\"phase\":\"began\",\"reason\":\"appWasSuspended\",\"running\":false}")
        XCTAssertEqual(DiagGate.loggerText(row), "#1 session event=interruption phase=began reason=appWasSuspended running=false")
    }

    /// A row whose kind is not a token is refused whole, and the refusal is
    /// itself a row.
    /// TO SEE IT FAIL: store the row under its raw kind.
    func testARowWithAnUnsafeKindIsRefusedButNotSilently() throws {
        let ring = makeRing()
        XCTAssertNil(ring.append(entry("https://x.example/a b"), wallMs: Self.t0, monoMs: 1))
        XCTAssertEqual(ring.rows.map(\.kind), ["diag"])
        XCTAssertEqual(ring.rows.first?[field: "event"], .string("row-refused"))
    }

    /// The `build` row carries everything the Copy header needs to name the
    /// build the rows came from.
    /// TO SEE IT FAIL: drop a field from `BuildRow.entry`.
    func testTheBuildRow() throws {
        let ring = makeRing()
        let row = try XCTUnwrap(ring.append(BuildRow(engineVersion: "1.0.0", bundleVersion: "2026092400",
                                                     launch: .background, holdPolicy: .until(minutes: 60)).entry,
                                            wallMs: Self.t0, monoMs: 1))
        XCTAssertEqual(DiagGate.loggerText(row),
                       "#1 build engineVersion=1.0.0 protocol=1 bundleVersion=2026092400 launch=background pitch=timeDomain hold=until:60")
    }

    // MARK: - Keys

    /// §4.6: every engine-only key lives OUTSIDE `CapacitorStorage.`, and the
    /// shared rows are exactly OWNED_PREFIXES under it.
    /// TO SEE IT FAIL: spell a private key `CapacitorStorage.ForayEngine...`,
    /// or let `sharedRowKey` accept `cp_rate`.
    func testPrivateKeysLiveOutsideCapacitorStorageAndSharedRowsAreTheOwnedOnes() {
        XCTAssertEqual(EnginePrivateKey.allCases.map(\.rawValue), [
            "ForayEngine.modeOverride", "ForayEngine.strikes", "ForayEngine.sentinel",
            "ForayEngine.stickyLegacyBuild", "ForayEngine.restore", "ForayEngine.holdPolicy"
        ], "plan §4.6's list, which test/data-deletion.test.js purges by name")
        for key in EnginePrivateKey.allCases {
            XCTAssertFalse(key.rawValue.hasPrefix(SharedRowStore.preferencesKeyPrefix), key.rawValue)
            XCTAssertTrue(EngineKeys.isPrivate(rawKey: key.rawValue))
            XCTAssertNil(EngineKeys.sharedRowKey(rawKey: key.rawValue))
        }
        XCTAssertEqual(EngineKeys.sharedRowKey(rawKey: "CapacitorStorage.cp_pos:ep-1"), "cp_pos:ep-1")
        XCTAssertEqual(EngineKeys.sharedRowKey(rawKey: "CapacitorStorage.cp_foray:f1"), "cp_foray:f1")
        XCTAssertEqual(EngineKeys.sharedRowKey(rawKey: "CapacitorStorage.cp_last_episode"), "cp_last_episode")
        XCTAssertNil(EngineKeys.sharedRowKey(rawKey: "CapacitorStorage.cp_rate"), "the page's row")
        XCTAssertNil(EngineKeys.sharedRowKey(rawKey: "CapacitorStorage.cp_engine_applied"), "the page's watermark")
        XCTAssertNil(EngineKeys.sharedRowKey(rawKey: "cp_pos:ep-1"), "not under the Preferences prefix")
    }
}

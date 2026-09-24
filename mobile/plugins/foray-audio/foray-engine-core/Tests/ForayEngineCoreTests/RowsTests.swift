import XCTest
import ForayEngineCore
import ForayEngineParity

/// The shared rows, the restore record and the diagnostics row (card
/// NE-10s), beyond what the `rows` family's recorded cases say.
///
/// The family proves each builder writes the recorded bytes. These prove the
/// rest of the card's acceptance: the rows read back (through this port's
/// readers, which are the page's readers ported), `isNewer` orders
/// engine-written rows by their stamp, and "byte for byte" holds at the
/// level of UTF-8 bytes, not only of Swift String equality.
final class RowsTests: XCTestCase {
    static let t0: Double = 1_790_000_000_123

    func stamp(_ ms: Double) -> String { Rows.timestamp(epochMs: ms)! }

    /// Swift compares Strings by CANONICAL EQUIVALENCE, so the comparator
    /// would call a decomposed "é" equal to the recorded composed one; the page
    /// would not (a different key, a different byte count). This runs every
    /// recorded rows case through the Swift builders and compares the UTF-8
    /// bytes of each key and value.
    /// TO SEE IT FAIL: normalise the title in `Rows.forayProgress`
    /// (`title.decomposedStringWithCanonicalMapping`).
    func testEveryRecordedRowIsWrittenByteForByte() throws {
        let data = try ParityData.load(parityDir: try ParityLocator.locate())
        let context = Codec.Context(repoRoot: data.repoRoot)
        var compared = 0
        for file in data.fixtures["rows"] ?? [] where file.module == RowsFamily.rowsModule {
            for testCase in file.cases {
                let actual = try RowsFamily.runner.run(testCase, in: file, context: context)
                let want = testCase.expect?["return"]?.arrayValue ?? []
                let got = actual["return"]?.arrayValue ?? []
                XCTAssertEqual(got.count, want.count, testCase.id)
                for (g, w) in zip(got, want) {
                    for field in ["key", "value"] {
                        XCTAssertEqual(Array((g[field]?.stringValue ?? "").utf8), Array((w[field]?.stringValue ?? "").utf8),
                                       "\(testCase.id) \(field)")
                    }
                    compared += 1
                }
            }
        }
        XCTAssertGreaterThanOrEqual(compared, 30, "the rows family lost its written cases")
    }

    /// A row the engine writes is a row the page's reader accepts, with the
    /// values the engine meant (position-store.js `load`).
    func testPositionRowsReadBack() throws {
        let row = try XCTUnwrap(Rows.position(id: "ep-1", seconds: 1234.5, duration: 3600, updatedAt: stamp(RowsTests.t0)))
        XCTAssertEqual(row.key, "cp_pos:ep-1")
        XCTAssertEqual(Rows.readPosition(row.value),
                       Rows.PositionRecord(seconds: 1234.5, duration: 3600, updatedAt: "2026-09-21T14:13:20.123Z"))
        let unknownLength = try XCTUnwrap(Rows.position(id: "ep-1", seconds: 0, duration: .nan, updatedAt: stamp(0)))
        XCTAssertNil(try XCTUnwrap(Rows.readPosition(unknownLength.value)).duration, "a NaN duration is stored as null")
        XCTAssertNil(Rows.readPosition("{\"seconds\":\"12\"}"), "load refuses a non-number")
        XCTAssertNil(Rows.readPosition("{\"seconds\":1"), "and a torn write")
        XCTAssertNil(Rows.readPosition(""))
    }

    func testForayRowsReadBack() throws {
        let input = Rows.ForayProgressInput(forayId: "f-1", title: "Morning run", elapsedSec: 1394.2, totalSec: 3673.5,
                                            index: 7, segmentId: "seg-8", intoSec: 12.25)
        let row = try XCTUnwrap(Rows.forayProgress(input, updatedAt: stamp(RowsTests.t0)))
        let read = try XCTUnwrap(Rows.readForayProgress(row.value))
        XCTAssertEqual(read.forayId, "f-1")
        XCTAssertEqual(read.elapsedSec, 1394.2)
        XCTAssertEqual(read.index, 7)
        XCTAssertEqual(read.segmentId, "seg-8")
        XCTAssertEqual(read.intoSec, 12.25)
        // Rows written before segment_id/into_sec existed still resume.
        XCTAssertNotNil(Rows.readForayProgress("{\"foray_id\":\"f\",\"elapsed_sec\":0,\"total_sec\":1}"))
        XCTAssertNil(Rows.readForayProgress("{\"foray_id\":\" \",\"elapsed_sec\":0,\"total_sec\":1}"))
        XCTAssertNil(Rows.readForayProgress("{\"foray_id\":\"f\",\"elapsed_sec\":0,\"total_sec\":0}"))
    }

    /// The engine stores the page's `lastEpisodeRow` "verbatim plus
    /// updated_at" (plan §5.2): the page's row, in ANY member order (the bridge
    /// hands Swift an unordered dictionary), comes out in SNAPSHOT_FIELDS order
    /// and otherwise unchanged; an older `updated_at` in it is replaced, not kept.
    func testTheLastEpisodeRowIsTheSnapshotInOrderWhateverOrderItArrivesIn() throws {
        let page: JSONNode = .object([
            JSONMember("duration_sec", .number(2550)), JSONMember("updated_at", .string("2020-01-01T00:00:00.000Z")),
            JSONMember("audio_url", .string("https://cdn.example.com/a/ep-1.mp3?x=1&y=2")),
            JSONMember("title", .string("Episode One")), JSONMember("id", .string("ep-1")),
            JSONMember("show", .null), JSONMember("topics", .array([.string("ai")]))
        ])
        let row = try XCTUnwrap(Rows.lastEpisode(page, updatedAt: stamp(RowsTests.t0)))
        XCTAssertEqual(row.key, "cp_last_episode")
        XCTAssertEqual(row.value, "{\"id\":\"ep-1\",\"title\":\"Episode One\",\"audio_url\":\"https://cdn.example.com/a/ep-1.mp3?x=1&y=2\","
                       + "\"duration_sec\":2550,\"updated_at\":\"2026-09-21T14:13:20.123Z\"}")
        let back = try XCTUnwrap(Rows.readLastEpisode(row.value))
        // Idempotent: the stored row, sent back as a lastEpisodeRow, stores the same bytes.
        XCTAssertEqual(Rows.lastEpisode(back, updatedAt: stamp(RowsTests.t0))?.value, row.value)
        XCTAssertNil(Rows.lastEpisode(.object([JSONMember("id", .number(0))]), updatedAt: stamp(0)), "a falsy id writes nothing")
        XCTAssertNil(Rows.readLastEpisode("[]"))
    }

    /// DurableStore hydration adopts the NEWER copy of a row by `isNewer`, so
    /// an engine row stamped later must win over an earlier one, of every kind,
    /// and an unstamped or unreadable row never wins or loses by accident.
    /// (player/parity/rows.test.js checks the page's own `isNewer` on the same
    /// bytes, which these are: the rows family pins them.)
    /// TO SEE IT FAIL: read `updatedAt` before `updated_at` in `Rows.stamp`, or
    /// compare with `>=`.
    func testIsNewerOrdersEngineWrittenRowsByTheirStamp() throws {
        let early = stamp(RowsTests.t0)
        let late = stamp(RowsTests.t0 + 1)
        let pairs: [(StoredRow?, StoredRow?)] = [
            (Rows.position(id: "e", seconds: 1, duration: nil, updatedAt: early),
             Rows.position(id: "e", seconds: 1, duration: nil, updatedAt: late)),
            (Rows.forayProgress(.init(forayId: "f", elapsedSec: 1, totalSec: 9), updatedAt: early),
             Rows.forayProgress(.init(forayId: "f", elapsedSec: 1, totalSec: 9), updatedAt: late)),
            (Rows.lastEpisode(.object([JSONMember("id", .string("e"))]), updatedAt: early),
             Rows.lastEpisode(.object([JSONMember("id", .string("e"))]), updatedAt: late))
        ]
        for (a, b) in pairs {
            let older = try XCTUnwrap(a).value
            let newer = try XCTUnwrap(b).value
            XCTAssertTrue(Rows.isNewer(newer, than: older), newer)
            XCTAssertFalse(Rows.isNewer(older, than: newer), older)
            XCTAssertFalse(Rows.isNewer(newer, than: newer), "equal stamps are not newer")
            XCTAssertFalse(Rows.isNewer(newer, than: "{\"seconds\":1}"), "an unstamped row is not older")
            XCTAssertFalse(Rows.isNewer("not json", than: older))
        }
        // stampOf reads updated_at first, then updatedAt, then ts.
        XCTAssertEqual(Rows.stamp(of: "{\"ts\":\"1970-01-01T00:00:00.002Z\",\"updated_at\":\"1970-01-01T00:00:00.001Z\"}"), 1)
        XCTAssertEqual(Rows.stamp(of: "{\"updated_at\":\"junk\",\"updatedAt\":\"1970-01-01T00:00:00.003Z\"}"), 3)
    }

    func testOwnedPrefixesNameEveryRowTheBuildersWrite() throws {
        XCTAssertEqual(Rows.ownedPrefixes, ["cp_pos:", "cp_foray:", "cp_last_episode"])
        let keys = [
            try XCTUnwrap(Rows.position(id: "x", seconds: 1, duration: nil, updatedAt: stamp(0))).key,
            try XCTUnwrap(Rows.forayProgress(.init(forayId: "x", elapsedSec: 1, totalSec: 2), updatedAt: stamp(0))).key,
            try XCTUnwrap(Rows.lastEpisode(.object([JSONMember("id", .string("x"))]), updatedAt: stamp(0))).key
        ]
        for key in keys {
            XCTAssertTrue(Rows.ownedPrefixes.contains(where: { key.hasPrefix($0) }), key)
        }
    }

    /// The engine-private restore record keeps what the cold path needs,
    /// pendingEvents and voiceId included, and reads back equal; a record this
    /// build cannot trust is no record.
    func testTheRestoreRecordRoundTripsAndRefusesWhatItCannotTrust() throws {
        let event: JSONNode = .object([
            JSONMember("kind", .string("position")), JSONMember("episode_id", .string("ep-1")),
            JSONMember("seconds", .number(60)), JSONMember("duration", .number(3600)),
            JSONMember("at", .string("2026-09-21T14:13:20.123Z"))
        ])
        let record = RestoreRecord(mode: .foray, queue: [.object([JSONMember("id", .string("s1"))]),
                                                         .object([JSONMember("id", .string("s2"))])],
                                   index: 1, offsetSec: 12.5, forayId: "f-1", rate: 1.25, voiceId: "com.apple.voice.Samantha",
                                   advanceLog: [], pendingEvents: [event], updatedAt: stamp(RowsTests.t0), build: "2026092401")
        let text = record.serialized()
        XCTAssertTrue(text.hasPrefix("{\"v\":1,\"mode\":\"foray\",\"queue\":["), text)
        XCTAssertEqual(RestoreRecord.parse(text), record)

        let gone = RestoreRecord.relinquished(updatedAt: stamp(0), build: "1")
        XCTAssertEqual(gone.serialized(), "{\"v\":1,\"mode\":\"relinquished\",\"updated_at\":\"1970-01-01T00:00:00.000Z\",\"build\":\"1\"}")
        XCTAssertEqual(RestoreRecord.parse(gone.serialized()), gone)

        for bad in [
            text.replacingOccurrences(of: "\"v\":1", with: "\"v\":2"),
            text.replacingOccurrences(of: "\"index\":1", with: "\"index\":2"),
            text.replacingOccurrences(of: "\"rate\":1.25", with: "\"rate\":0"),
            text.replacingOccurrences(of: "\"forayId\":\"f-1\",", with: ""),
            text.replacingOccurrences(of: "\"mode\":\"foray\"", with: "\"mode\":\"tape\""),
            String(text.dropLast())
        ] {
            XCTAssertNil(RestoreRecord.parse(bad), bad)
        }
    }

    /// ONE packed row per seam, in a fixed field order, that reads back; a
    /// stage token outside the vocabulary is dropped on the way in, and a
    /// torn line costs one row.
    func testTheSeamRowPacksAndReadsBack() throws {
        let seam = SeamRow(observedGapMs: 2041.5, askedGapMs: 2000, prepared: true, grace: false,
                           bgRemainingMs: nil, stages: [.attach, .readiness, .seek, .preroll, .ready, .play, .playing])
        let line = seam.row(seq: 41, wallMs: RowsTests.t0, monoMs: 81_234.5).line()
        XCTAssertEqual(line, "{\"seq\":41,\"at\":1790000000123,\"mono\":81234.5,\"kind\":\"seam\",\"observedGapMs\":2041.5,"
                       + "\"askedGapMs\":2000,\"prepared\":true,\"grace\":false,\"bgRemainingMs\":null,"
                       + "\"stages\":[\"attach\",\"readiness\",\"seek\",\"preroll\",\"ready\",\"play\",\"playing\"]}")
        let row = try XCTUnwrap(DiagRow.parse(line))
        XCTAssertEqual(row.seq, 41)
        XCTAssertEqual(SeamRow(row), seam)

        let tampered = line.replacingOccurrences(of: "\"seek\"", with: "\"Seek\"")
        XCTAssertEqual(try XCTUnwrap(SeamRow(try XCTUnwrap(DiagRow.parse(tampered)))).stages,
                       [.attach, .readiness, .preroll, .ready, .play, .playing])
        XCTAssertNil(DiagRow.parse(String(line.dropLast(3))))
        XCTAssertNil(SeamRow(DiagRow(seq: 1, wallMs: 0, monoMs: 0, kind: "remote", fields: seam.fields)))
    }

    /// A field may not shadow the header: a reader keeps the LAST of a repeated
    /// key, so a field named `seq` would rewrite the ring's order.
    func testADiagRowFieldCannotShadowTheHeader() throws {
        let row = DiagRow(seq: 7, wallMs: 1, monoMs: 2, kind: "session",
                          fields: [JSONMember("seq", .number(99)), JSONMember("activateMs", .number(12))])
        XCTAssertEqual(row.line(), "{\"seq\":7,\"at\":1,\"mono\":2,\"kind\":\"session\",\"activateMs\":12}")
        XCTAssertEqual(DiagRow.parse(row.line())?.seq, 7)
    }

    /// `admitToken`'s exactness, directly (the family has the full table).
    func testAdmissionIsExact() throws {
        XCTAssertEqual(try Vocabulary.admit("grace-expired", into: "stopCause"), "grace-expired")
        XCTAssertNil(try Vocabulary.admit("graceExpired", into: "stopCause"))
        XCTAssertNil(try Vocabulary.admit(nil, into: "stage"))
        XCTAssertThrowsError(try Vocabulary.admit("unknown", into: "constructor"))
        XCTAssertThrowsError(try Vocabulary.admit("unknown", into: nil))
    }
}

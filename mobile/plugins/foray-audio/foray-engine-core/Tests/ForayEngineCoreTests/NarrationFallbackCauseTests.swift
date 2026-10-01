import XCTest
import ForayEngineCore

/// Card NE-39n (3): the `narration kind=fallback` row's `cause=`.
///
/// Two halves. The pure reading (`NarrationFallbackCauseReading`) maps each
/// closed token from a synthetic deck failure: the error's domain and code
/// and its underlying one, and the error log's status, exactly the fields
/// AVDeck's `failed` and `deadline` rows print. Then the core: a deck failure
/// under a rendered line writes the deck's cause on the fallback row, and on
/// no other row.
///
/// The NSError end (AVDeck.fallbackCause) is AVDeckTests'
/// `testFallbackCauseMapsEachCauseFromASyntheticNSError`, in the Simulator.
final class NarrationFallbackCauseTests: XCTestCase {
    typealias Code = NarrationFallbackCauseReading.Code
    typealias Cause = Vocabulary.NarrationFallbackCause

    private static let av = "AVFoundationErrorDomain"
    private static let url = "NSURLErrorDomain"
    private static let coreMedia = "CoreMediaErrorDomain"

    /// AVFoundation's "unknown" (-11800) wrapping `under`: the shape almost
    /// every item failure arrives in.
    private static func wrapped(_ domain: String, _ code: Int) -> [Code] {
        [Code(domain: av, code: -11800), Code(domain: domain, code: code)]
    }

    private func read(_ errors: [Code] = [], log: (Int, String)? = nil, deadline: Bool = false) -> Cause {
        NarrationFallbackCauseReading.cause(errors: errors, logStatus: log?.0, logDomain: log?.1, deadline: deadline)
    }

    // MARK: - The reading, one synthetic failure per cause

    /// TO SEE IT FAIL: drop `deadline ||` from the timeout test in the reading.
    func testTimeout() {
        XCTAssertEqual(read(deadline: true), .timeout, "the P-13 deadline, nothing logged")
        XCTAssertEqual(read(Self.wrapped(Self.url, -1001)), .timeout, "the URL loader's own timedOut")
    }

    /// TO SEE IT FAIL: read the log's status only for the URL domain.
    func testHTTP4xx() {
        XCTAssertEqual(read(Self.wrapped(Self.coreMedia, -12938), log: (404, Self.coreMedia)), .http4xx, "a missing file")
        XCTAssertEqual(read(log: (403, Self.coreMedia)), .http4xx, "a refused file")
        XCTAssertEqual(read(Self.wrapped(Self.coreMedia, -12938)), .http4xx, "CoreMedia's HTTP 404 with an empty log")
        XCTAssertEqual(read(log: (404, Self.coreMedia), deadline: true), .http4xx,
                       "a deadline whose log shows the server answered 404 is the 404")
    }

    func testHTTP5xx() {
        XCTAssertEqual(read(Self.wrapped(Self.av, -11800), log: (503, Self.coreMedia)), .http5xx)
        XCTAssertEqual(read(log: (500, Self.coreMedia), deadline: true), .http5xx)
    }

    /// Airplane mode during a line: the connection is lost mid-transfer, or
    /// there was none to begin with.
    /// TO SEE IT FAIL: check timeout before offline.
    func testOffline() {
        XCTAssertEqual(read(Self.wrapped(Self.url, -1009)), .offline, "notConnectedToInternet")
        XCTAssertEqual(read(Self.wrapped(Self.url, -1005)), .offline, "networkConnectionLost")
        XCTAssertEqual(read(Self.wrapped(Self.url, -1020)), .offline, "dataNotAllowed")
        XCTAssertEqual(read(log: (-1009, Self.url), deadline: true), .offline,
                       "a deadline whose log says the network was gone is offline, not a timeout")
    }

    func testDecode() {
        XCTAssertEqual(read([Code(domain: Self.av, code: -11828)]), .decode, "fileFormatNotRecognized")
        XCTAssertEqual(read(Self.wrapped(Self.av, -11829)), .decode, "fileFailedToParse")
        XCTAssertEqual(read(Self.wrapped(Self.url, -1016)), .decode, "cannotDecodeContentData")
    }

    func testOther() {
        XCTAssertEqual(read(), .other, "no error at all (the deck's `no-url`)")
        XCTAssertEqual(read(Self.wrapped("NSOSStatusErrorDomain", -12345)), .other)
        XCTAssertEqual(read(Self.wrapped(Self.url, -1003)), .other, "cannotFindHost is the host as often as the network")
    }

    /// A server's status outranks the rest: it answered, so the network was up.
    func testPrecedenceStatusThenOfflineThenTimeoutThenDecode() {
        XCTAssertEqual(read(Self.wrapped(Self.url, -1009), log: (404, Self.coreMedia)), .http4xx)
        XCTAssertEqual(read(Self.wrapped(Self.url, -1009), deadline: true), .offline)
        XCTAssertEqual(read([Code(domain: Self.av, code: -11828)], deadline: true), .timeout)
    }

    /// Every token in the closed set is reachable.
    func testEveryCauseIsReachable() {
        let reached: Set<Cause> = [
            read(deadline: true), read(log: (404, Self.coreMedia)), read(log: (502, Self.coreMedia)),
            read(Self.wrapped(Self.url, -1009)), read([Code(domain: Self.av, code: -11821)]), read()
        ]
        XCTAssertEqual(reached, Set(Cause.allCases))
    }

    // MARK: - The core writes the deck's cause on the fallback row

    private static func fallbackRows(_ out: [EngineCommand]) -> [DiagEntry] {
        out.compactMap {
            if case let .diag(entry) = $0, entry.kind == "narration", entry[field: "kind"] == .string("fallback") {
                return entry
            }
            return nil
        }
    }

    /// A rendered line whose file fails (as the deck reads it) falls back with
    /// that cause; a deadline with no reading of its own is `timeout`.
    /// TO SEE IT FAIL: drop the `cause` member from `fallBackToScript`'s row.
    func testTheFallbackRowCarriesTheDecksCauseForEveryToken() {
        for cause in Cause.allCases {
            var host = ForayCatchUpTests.host([ForayCatchUpTests.rendered(0), ForayCatchUpTests.clip(1, "a", 100, 200)])
            let token = host.lastLoad ?? 0
            let out = host.send(.deck(.failed(token: token, message: "synthetic", cause: cause)), after: 0)
            let rows = Self.fallbackRows(out)
            XCTAssertEqual(rows.count, 1, "\(cause): \(out)")
            XCTAssertEqual(rows.first?[field: "cause"], .string(cause.rawValue), "\(cause)")
            XCTAssertEqual(rows.first?[field: "reason"], .string("failed"), "\(cause): reason= is unchanged")
        }
        var host = ForayCatchUpTests.host([ForayCatchUpTests.rendered(0), ForayCatchUpTests.clip(1, "a", 100, 200)])
        let out = host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 8_000)), after: 0)
        let rows = Self.fallbackRows(out)
        XCTAssertEqual(rows.first?[field: "cause"], .string("timeout"), "\(out)")
        XCTAssertEqual(rows.first?[field: "reason"], .string("timeout"))
    }

    /// The row reaches the paste with its cause: every row passes DiagGate on
    /// its way into the ring, and the gate admits a `cause` field through a
    /// closed set. A `narration` row's `cause` is the fallback's set, not
    /// `stopCause`, of which no fallback cause is a member.
    /// TO SEE IT FAIL: drop the `narration` case from
    /// `DiagGate.vocabularySet` (every cause is then dropped and named in
    /// `dropped`), or name the row's `where` field `at` again.
    func testTheGateKeepsEveryFallbackCauseOnTheRow() throws {
        for cause in Cause.allCases {
            var host = ForayCatchUpTests.host([ForayCatchUpTests.rendered(0), ForayCatchUpTests.clip(1, "a", 100, 200)])
            let out = host.send(.deck(.failed(token: host.lastLoad ?? 0, message: "synthetic", cause: cause)), after: 0)
            let row = try XCTUnwrap(Self.fallbackRows(out).first, "\(cause): \(out)")
            let admitted = try XCTUnwrap(DiagGate.admit(row), "\(cause)")
            XCTAssertEqual(admitted[field: "cause"], .string(cause.rawValue), "\(cause): \(admitted)")
            // Where it fell back survives too (`at` would not: it is the ring
            // row's wall clock).
            XCTAssertEqual(admitted[field: "where"], .string("load"), "\(cause): \(admitted)")
            XCTAssertNil(admitted[field: DiagGate.droppedField], "\(cause): nothing withheld: \(admitted)")
        }
        // Still a closed set: a stop cause is not a fallback cause.
        let stray = DiagEntry(kind: "narration", fields: [JSONMember("kind", .string("fallback")),
                                                           JSONMember("cause", .string("load-deadline"))])
        let admitted = try XCTUnwrap(DiagGate.admit(stray))
        XCTAssertNil(admitted[field: "cause"])
        XCTAssertEqual(admitted[field: DiagGate.droppedField], .array([.string("cause")]))
    }

    /// A clip that fails writes no fallback row, whatever the deck read.
    func testAClipsFailureWritesNoFallbackRow() {
        var host = ForayCatchUpTests.host([ForayCatchUpTests.clip(0, "a", 100, 200), ForayCatchUpTests.rendered(1)])
        let out = host.send(.deck(.failed(token: host.lastLoad ?? 0, message: "synthetic", cause: .offline)), after: 0)
        XCTAssertEqual(Self.fallbackRows(out), [], "\(out)")
    }
}

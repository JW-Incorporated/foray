import XCTest
import ForayEngineCore

/// `JSWriter` and `JSONNode.parse` beyond the `number-format` family (card
/// NE-10s). The family pins the thresholds the recorder chose; these pin the
/// rest of what "byte-identical to JSON.stringify" means, with every expected
/// string taken from Node (`JSON.stringify`, `toISOString`, `Date.parse`), not
/// reasoned out, so a wrong expectation cannot hide a wrong writer.
final class JSWriterTests: XCTestCase {
    /// Layouts the family does not name: every exponent boundary and the
    /// digit-count edges. TO SEE IT FAIL: change `n <= 21` to `n < 21`, or
    /// `-6 < n` to `-7 < n`, in `numberToString`.
    func testNumbersPrintAsJSONStringifyPrintsThem() {
        let table: [(Double, String)] = [
            (1e-7, "1e-7"), (0.0000015, "0.0000015"), (0.5, "0.5"), (-1e21, "-1e+21"),
            (1e16, "10000000000000000"), (1e15, "1000000000000000"), (1.23e-18, "1.23e-18"),
            (9_223_372_036_854_775_808, "9223372036854776000"), (1.5e-323, "1.5e-323"),
            (0.1 * 3, "0.30000000000000004"), (100, "100"), (0.0000125, "0.0000125"),
            (-0.000001, "-0.000001"), (999_999_999_999_999_900_000, "999999999999999900000"),
            (4.35, "4.35"), (1.0 / 3.0, "0.3333333333333333"), (1e301, "1e+301"), (2.5e-7, "2.5e-7"),
            (12_345_678_901_234_567_890, "12345678901234567000")
        ]
        for (value, text) in table {
            XCTAssertEqual(JSWriter.jsonNumber(value), text, "\(value)")
        }
        XCTAssertEqual(JSWriter.jsonNumber(.nan), "null")
        XCTAssertEqual(JSWriter.jsonNumber(-.infinity), "null")
        XCTAssertEqual(JSWriter.numberToString(.nan), "NaN", "String(NaN) is not JSON's null")
    }

    /// Shortest digits are Swift's own guarantee; what this adds is that the
    /// LAYOUT never loses or invents a digit: every printed number reads back
    /// as exactly the same double, over bit patterns from every exponent range
    /// (a fixed-seed generator, so a failure reproduces).
    func testEveryPrintedNumberReadsBackAsTheSameDouble() {
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        var checked = 0
        for _ in 0..<20_000 {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let value = Double(bitPattern: state)
            guard value.isFinite else { continue }
            let text = JSWriter.jsonNumber(value)
            XCTAssertEqual(Double(text), value == 0 ? 0 : value, text)
            XCTAssertLessThanOrEqual(text.filter(\.isNumber).count, 17 + 21, text)
            checked += 1
        }
        XCTAssertGreaterThan(checked, 19_000)
    }

    /// QuoteJSONString: the six short escapes, lower-case `\u00xx` for the rest
    /// of C0, and NOTHING else escaped (`/`, DEL, U+2028/9, non-ASCII, astral).
    /// Node: JSON.stringify("\u0000\u0007\b\t\n\u000b\f\r\u001f \u007f\u2028\u2029\"\\/é🎧").
    func testStringsEscapeExactlyAsJSONStringifyEscapesThem() {
        let input = "\u{0}\u{7}\u{8}\t\n\u{B}\u{C}\r\u{1F} \u{7F}\u{2028}\u{2029}\"\\/é🎧"
        let expected = "\"\\u0000\\u0007\\b\\t\\n\\u000b\\f\\r\\u001f \u{7F}\u{2028}\u{2029}\\\"\\\\/é🎧\""
        XCTAssertEqual(Array(JSWriter.quote(input).utf8), Array(expected.utf8))
    }

    /// A row's key order is its builder's insertion order, whatever it is.
    func testObjectsKeepInsertionOrder() {
        let node: JSONNode = .object([
            JSONMember("z", .number(1)), JSONMember("a", .array([.null, .bool(true), .string("x")])),
            JSONMember("m", .object([]))
        ])
        XCTAssertEqual(JSWriter.stringify(node), "{\"z\":1,\"a\":[null,true,\"x\"],\"m\":{}}")
    }

    /// JSON.parse keeps a repeated key at its FIRST position with its LAST
    /// value (Node: JSON.parse('{"b":1,"a":2,"b":3}') -> {"b":3,"a":2}), and a
    /// parsed row writes back byte for byte.
    func testParseKeepsOrderFoldsRepeatedKeysAndRoundTrips() throws {
        let parsed = try JSONNode.parse("{\"b\":1,\"a\":2,\"b\":3}")
        XCTAssertEqual(JSWriter.stringify(parsed), "{\"b\":3,\"a\":2}")
        let row = "{\"foray_id\":\"f/é:1\",\"title\":\"Ain't \\\"it\\\" a \\\\ / </script>\\u0001\\t\\n é — 🎧  end\","
            + "\"elapsed_sec\":0.30000000000000004,\"index\":-1,\"segment_id\":null,\"ok\":true,\"list\":[1e+21,5e-7]}"
        XCTAssertEqual(JSWriter.stringify(try JSONNode.parse(row)), row)
        XCTAssertEqual(try JSONNode.parse(" \t\n[ 1 , -0.5e2 ,\"\\ud83c\\udfa7\" ] "),
                       .array([.number(1), .number(-50), .string("🎧")]))
    }

    /// Everything JSON.parse refuses, refused. TO SEE IT FAIL: accept a leading
    /// zero in `number()`, or skip the control-character check in `string()`.
    func testParseRefusesWhatJSONParseRefuses() {
        for text in ["", "{", "[1,]", "{\"a\":1,}", "{'a':1}", "01", "-", "1.", ".5", "1e", "NaN", "Infinity",
                     "\"a\u{1}\"", "\"\\x\"", "\"\\u12\"", "tru", "nul", "1 2", "{\"a\" 1}", "\u{A0}1"] {
            XCTAssertThrowsError(try JSONNode.parse(text), "JSON.parse(\(text.debugDescription)) throws")
        }
        XCTAssertEqual(try JSONNode.parse("1e400"), .number(.infinity), "JSON.parse overflows to Infinity")
        XCTAssertEqual(try JSONNode.parse("-1e400"), .number(-.infinity))
        XCTAssertEqual(try JSONNode.parse("1e-400"), .number(0), "and underflows to 0")
    }

    /// `new Date(ms).toISOString()`, from Node, including the six-digit years,
    /// the ends of the Date range, TimeClip's truncation, and a leap day.
    func testISOStringMatchesToISOString() {
        let table: [(Double, String)] = [
            (0, "1970-01-01T00:00:00.000Z"), (-1, "1969-12-31T23:59:59.999Z"),
            (8.64e15, "+275760-09-13T00:00:00.000Z"), (-8.64e15, "-271821-04-20T00:00:00.000Z"),
            (253_402_300_800_000, "+010000-01-01T00:00:00.000Z"), (-62_167_219_200_000, "0000-01-01T00:00:00.000Z"),
            (-62_167_219_200_001, "-000001-12-31T23:59:59.999Z"), (1_790_000_000_123.9, "2026-09-21T14:13:20.123Z"),
            (-0.5, "1970-01-01T00:00:00.000Z"), (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (1_790_000_000_999.99, "2026-09-21T14:13:20.999Z"), (1_790_000_000_123, "2026-09-21T14:13:20.123Z")
        ]
        for (ms, text) in table {
            XCTAssertEqual(JSWriter.isoString(epochMs: ms), text, "\(ms)")
        }
        for ms in [8.64e15 + 1, -8.64e15 - 1, .nan, .infinity] {
            XCTAssertNil(JSWriter.isoString(epochMs: ms), "toISOString throws a RangeError for \(ms)")
        }
    }

    /// `Date.parse` over the ISO format, from Node, and nil where this port
    /// declines (local time, V8's lenient fallback) or JavaScript gives NaN.
    func testDateParseReadsTheStampsRowsCarry() {
        let table: [(String, Double)] = [
            ("2026-09-21", 1_789_948_800_000), ("2026-09-21T14:13:20.123+02:00", 1_789_992_800_123),
            ("2026-09", 1_788_220_800_000), ("2026", 1_767_225_600_000),
            ("+002026-09-21T14:13:20.123Z", 1_790_000_000_123), ("2026-09-21T14:13Z", 1_789_999_980_000),
            ("2026-09-21T14:13:20Z", 1_790_000_000_000), ("2026-02-30T00:00:00Z", 1_772_409_600_000),
            ("2026-09-21T24:00:00Z", 1_790_035_200_000), ("2026-09-21T14:13:20.1234Z", 1_790_000_000_123),
            ("2026-09-21T14:13:20.1Z", 1_790_000_000_100), ("2026-09-21T14:13:20.123+0200", 1_789_992_800_123),
            ("2026-09-21t14:13:20Z", 1_790_000_000_000), ("2026-09-21T14:13:20.123z", 1_790_000_000_123),
            ("-000001-12-31T23:59:59.999Z", -62_167_219_200_001), ("+275760-09-13T00:00:00.000Z", 8.64e15)
        ]
        for (text, ms) in table {
            XCTAssertEqual(JSDate.parse(text), ms, text)
        }
        for text in ["-000000-01-01T00:00:00Z", "2026-02-32T00:00:00Z", "2026-00-10", "2026-13-01",
                     "2026-09-21T24:30:00Z", "2026-09-21T23:60:00Z", "2026-09-21T14:13:20.Z",
                     "2026-09-21T14:13:20.123+24:00", " 2026-09-21T14:13:20.123Z", "+275760-09-13T00:00:00.001Z",
                     "2026-09-21T14:13:20.123", "2026-9-21", "not a date", ""] {
            XCTAssertNil(JSDate.parse(text), text)
        }
        // And every stamp the writer prints reads back as its instant.
        for ms in [0, -1, 1_790_000_000_123, 8.64e15, -8.64e15, 253_402_300_800_000] as [Double] {
            XCTAssertEqual(JSWriter.isoString(epochMs: ms).flatMap(JSDate.parse), ms, "\(ms)")
        }
    }
}

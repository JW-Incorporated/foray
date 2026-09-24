import Foundation

/* JSON the way the PAGE writes it (docs/native-engine-plan.md §4.6, card
 * NE-10s): the engine writes `cp_pos:<id>`, `cp_foray:<id>` and
 * `cp_last_episode` into the same `CapacitorStorage.` rows the page reads, so
 * both runtimes must produce the SAME BYTES for the same row, not merely the
 * same value. The `rows` and `number-format` parity families
 * (player/parity/fixtures/, recorded from the real JS writers by NE-10j) hold
 * this file to `JSON.stringify` byte for byte.
 *
 * WHY NOT JSONSerialization OR JSONEncoder. Each differs from
 * `JSON.stringify` in a way a byte comparison sees and a value comparison
 * does not:
 *   - key order: a Swift dictionary has none, and `.sortedKeys` is a
 *     different order again. A row's order is its builder's insertion order
 *     (`seconds, duration, updated_at, source`), so `JSONNode.object` is an
 *     ordered list of members;
 *   - numbers: Foundation prints `3600.0` or `3600`, `1e-07`, and platform-
 *     dependent digits on Linux; JavaScript prints `3600`, `1e-7`, and
 *     exactly the shortest digits that round-trip (Number::toString);
 *   - escaping: Foundation escapes `/` as `\/` by default; JavaScript does not,
 *     and it escapes control characters as lower-case `\u00xx` except the six
 *     that have short forms.
 * A second definition of the row that only a byte diff can see is exactly the
 * drift this deck exists to prevent (plan §8 R6), so the rules are written out
 * here, once, and fixture-pinned.
 *
 * Foundation only (the core's rule, NE-01): no DateFormatter either, whose
 * output depends on the device's calendar and locale; `toISOString` is plain
 * arithmetic, below. */

/// A JSON value whose objects keep their members IN ORDER: what a row builder
/// produces and what `JSWriter.stringify` prints.
public enum JSONNode: Equatable {
    case null
    case bool(Bool)
    /// Printed by ECMAScript Number::toString; NaN and the infinities print as
    /// `null`, as `JSON.stringify` prints them.
    case number(Double)
    case string(String)
    case array([JSONNode])
    /// Members in insertion order. A builder never repeats a key (a JS object
    /// cannot hold one twice); `JSONNode.parse` folds a repeated key the way
    /// `JSON.parse` does.
    case object([JSONMember])

    /// `value[key]` on an object: the member's value, or nil for a missing key
    /// and for any non-object (where JavaScript reads `undefined`).
    public subscript(key: String) -> JSONNode? {
        guard case let .object(members) = self else { return nil }
        return members.last(where: { $0.key == key })?.value
    }

    /// JavaScript truthiness, `if (value)`. Absent (`undefined`) is the
    /// caller's nil, which is falsy too.
    public var isTruthy: Bool {
        switch self {
        case .null: return false
        case let .bool(flag): return flag
        case let .number(number): return !(number == 0 || number.isNaN)
        case let .string(text): return !text.isEmpty
        case .array, .object: return true
        }
    }

    public var stringValue: String? {
        if case let .string(text) = self { return text }
        return nil
    }

    /// The number, when this is one (`typeof value === "number"`).
    public var numberValue: Double? {
        if case let .number(number) = self { return number }
        return nil
    }

    public var arrayValue: [JSONNode]? {
        if case let .array(items) = self { return items }
        return nil
    }

    public var members: [JSONMember]? {
        if case let .object(members) = self { return members }
        return nil
    }
}

public struct JSONMember: Equatable {
    public let key: String
    public let value: JSONNode

    public init(_ key: String, _ value: JSONNode) {
        self.key = key
        self.value = value
    }
}

public enum JSWriter {
    /// `JSON.stringify(value)` with no replacer and no indent: the exact
    /// string the page hands to `setItem`.
    public static func stringify(_ value: JSONNode) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    static func write(_ value: JSONNode, into out: inout String) {
        switch value {
        case .null:
            out += "null"
        case let .bool(flag):
            out += flag ? "true" : "false"
        case let .number(number):
            out += jsonNumber(number)
        case let .string(text):
            out += quote(text)
        case let .array(items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                write(item, into: &out)
            }
            out += "]"
        case let .object(members):
            out += "{"
            for (index, member) in members.enumerated() {
                if index > 0 { out += "," }
                out += quote(member.key)
                out += ":"
                write(member.value, into: &out)
            }
            out += "}"
        }
    }

    /// A number inside JSON: Number::toString for a finite value, `null` for
    /// NaN and the infinities (`JSON.stringify(NaN)` is `"null"`). No row
    /// writer lets a non-finite number through, but if one ever does, the
    /// engine must print what the page would, not crash and not print `nan`.
    public static func jsonNumber(_ value: Double) -> String {
        value.isFinite ? numberToString(value) : "null"
    }

    /// ECMAScript Number::toString(value), i.e. `String(value)`.
    ///
    /// THE DIGITS come from Swift's own `description`, which since Swift 5 is
    /// the SHORTEST digit string that round-trips, and among equally short
    /// ones the closest to the exact value: the same digits ECMA-262 asks for
    /// (Number::toString step 5). Only the LAYOUT differs (Swift prints
    /// `100.0`, `1e-07` and `1e+16`), so this takes Swift's digits and
    /// exponent and places the decimal point by ECMA's rules:
    ///
    ///   k digits, value = 0.d1..dk x 10^n
    ///   k <= n <= 21    integer, padded with zeros    (`100`, `1e20` -> `100000000000000000000`)
    ///   0 < n <= 21     point inside the digits       (`1234.5678`)
    ///   -6 < n <= 0     `0.` then zeros               (`0.000001`, the smallest plain one)
    ///   otherwise       exponent form, `e+`/`e-`      (`1e+21`, `5e-7`)
    ///
    /// `-0` prints `0` (step 2). The `number-format` family pins each
    /// threshold on both sides.
    public static func numberToString(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == 0 { return "0" }
        let sign = value < 0 ? "-" : ""
        let text = "\(Swift.abs(value))"
        let parts = text.split(separator: "e", maxSplits: 1).map(String.init)
        let exponent = parts.count == 2 ? Int(parts[1]) ?? 0 : 0
        let mantissa = parts[0].split(separator: ".", maxSplits: 1).map(String.init)
        let integerPart = mantissa[0]
        let fractionPart = mantissa.count == 2 ? mantissa[1] : ""
        var digits = Array(integerPart + fractionPart)
        // value = 0.d1d2d3... x 10^point
        var point = integerPart.count + exponent
        while digits.count > 1 && digits.first == "0" {
            digits.removeFirst()
            point -= 1
        }
        while digits.count > 1 && digits.last == "0" {
            digits.removeLast()
        }
        let k = digits.count
        let n = point
        let d = String(digits)
        if k <= n && n <= 21 {
            return sign + d + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            return sign + String(digits[0..<n]) + "." + String(digits[n...])
        }
        if -6 < n && n <= 0 {
            return sign + "0." + String(repeating: "0", count: -n) + d
        }
        let e = n - 1
        let expText = (e < 0 ? "-" : "+") + String(Swift.abs(e))
        if k == 1 { return sign + d + "e" + expText }
        return sign + String(digits[0]) + "." + String(digits[1...]) + "e" + expText
    }

    /// ECMAScript QuoteJSONString: `"` and `\` escaped, the six control
    /// characters with short forms (`\b \t \n \f \r`, and `\"`/`\\`) use them,
    /// every other code point below U+0020 is `\u00xx` in LOWER-case hex, and
    /// everything else, `/`, U+007F, U+2028 and every non-ASCII character
    /// included, is written as itself.
    ///
    /// (JavaScript also escapes a LONE surrogate as `\udxxx`. A Swift String
    /// cannot hold one, so there is nothing here to escape; the engine only
    /// ever writes strings it received as valid Unicode.)
    public static func quote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x09: out += "\\t"
            case 0x0A: out += "\\n"
            case 0x0C: out += "\\f"
            case 0x0D: out += "\\r"
            case 0x00..<0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    /// `new Date(epochMs).toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ` in UTC,
    /// always three fractional digits and always `Z`, with the six-digit
    /// signed year (`+010000`, `-000001`) outside 0000...9999. Nil where
    /// JavaScript throws a RangeError: NaN, an infinity, or beyond the
    /// ±8.64e15 ms a Date can hold.
    ///
    /// `new Date(x)` keeps the INTEGER part of x (TimeClip truncates toward
    /// zero), so 1790000000123.9 is .123, and -0.5 is the epoch itself.
    public static func isoString(epochMs: Double) -> String? {
        guard epochMs.isFinite, Swift.abs(epochMs) <= JSDate.maxEpochMs else { return nil }
        let ms = Int64(epochMs.rounded(.towardZero))
        let msPerDay: Int64 = 86_400_000
        var days = ms / msPerDay
        var msOfDay = ms % msPerDay
        if msOfDay < 0 {
            msOfDay += msPerDay
            days -= 1
        }
        let (year, month, day) = JSDate.civil(fromDays: days)
        let yearText: String
        if (0...9999).contains(year) {
            yearText = pad(year, 4)
        } else {
            yearText = (year < 0 ? "-" : "+") + pad(Swift.abs(year), 6)
        }
        let hours = msOfDay / 3_600_000
        let minutes = msOfDay / 60_000 % 60
        let seconds = msOfDay / 1000 % 60
        let millis = msOfDay % 1000
        return "\(yearText)-\(pad(month, 2))-\(pad(day, 2))T\(pad(hours, 2)):\(pad(minutes, 2)):\(pad(seconds, 2)).\(pad(millis, 3))Z"
    }

    static func pad<T: BinaryInteger>(_ value: T, _ width: Int) -> String {
        let text = String(value)
        return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
    }
}

/// The two date rules the shared rows need from `Date`: the epoch-day
/// arithmetic behind `toISOString`, and `Date.parse` of the stamps rows carry
/// (`isNewer` in player/durable-store.js orders two rows by them).
public enum JSDate {
    /// ECMA-262 TimeClip's bound: ±100,000,000 days from the epoch.
    public static let maxEpochMs: Double = 8.64e15

    /// Days since 1970-01-01 -> proleptic Gregorian (year, month, day).
    /// Howard Hinnant's `civil_from_days`, exact for every day a Date can hold.
    static func civil(fromDays days: Int64) -> (Int64, Int64, Int64) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        let year = yoe + era * 400 + (month <= 2 ? 1 : 0)
        return (year, month, day)
    }

    /// The inverse: (year, month 1-12, day 1-31) -> days since the epoch.
    /// A day past the month's end rolls into the next month, as `Date.UTC`
    /// and V8's ISO parser both roll it.
    static func days(fromCivil year: Int64, _ month: Int64, _ day: Int64) -> Int64 {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = month > 2 ? month - 3 : month + 9
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// `Date.parse(text)` for the ECMAScript Date Time String Format, which is
    /// every stamp a shared row's writer produces (`toISOString`): epoch
    /// milliseconds, or nil where `Date.parse` gives NaN.
    ///
    ///   YYYY | ±YYYYYY, then optional -MM, then optional -DD      (UTC)
    ///   then optional T HH:mm, optional :ss, optional .fraction   (1+ digits; ms kept, the rest dropped)
    ///   and a date-time must end in Z or ±HH:mm (or ±HHmm)
    ///
    /// Held to V8's answers where V8 follows the format: `T24:00` only as
    /// exactly midnight, a day 29-31 past the month's end rolls over, `-000000`
    /// is refused, and a lower-case `t`/`z` is accepted.
    ///
    /// NOT PORTED, and nil here: a date-time with no offset (JavaScript reads
    /// it as LOCAL time, which would make a row's order depend on the phone's
    /// time zone) and V8's lenient fallback for strings outside the format
    /// (`2026-9-21`). No writer of a shared row produces either, and nil makes
    /// `isNewer` answer false, which is the page's own answer for a row it
    /// cannot date.
    public static func parse(_ text: String) -> Double? {
        var cursor = StampCursor(text)
        let year: Int64
        if let sign = cursor.take(anyOf: ["+", "-"]) {
            guard let digits = cursor.digits(exactly: 6) else { return nil }
            if digits == 0 && sign == "-" { return nil }
            year = sign == "-" ? -digits : digits
        } else {
            guard let digits = cursor.digits(exactly: 4) else { return nil }
            year = digits
        }
        var month: Int64 = 1
        var day: Int64 = 1
        if cursor.take("-") {
            guard let value = cursor.digits(exactly: 2), (1...12).contains(value) else { return nil }
            month = value
            if cursor.take("-") {
                guard let value = cursor.digits(exactly: 2), (1...31).contains(value) else { return nil }
                day = value
            }
        }
        var timeMs: Int64 = 0
        var offsetMs: Int64 = 0
        if cursor.take(anyOf: ["T", "t"]) != nil {
            guard let hours = cursor.digits(exactly: 2), cursor.take(":"),
                  let minutes = cursor.digits(exactly: 2), hours <= 24, minutes <= 59 else { return nil }
            var seconds: Int64 = 0
            var millis: Int64 = 0
            if cursor.take(":") {
                guard let value = cursor.digits(exactly: 2), value <= 59 else { return nil }
                seconds = value
                if cursor.take(".") {
                    guard let fraction = cursor.fractionMillis() else { return nil }
                    millis = fraction
                }
            }
            if hours == 24 && (minutes != 0 || seconds != 0 || millis != 0) { return nil }
            timeMs = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
            if cursor.take(anyOf: ["Z", "z"]) != nil {
                offsetMs = 0
            } else if let sign = cursor.take(anyOf: ["+", "-"]) {
                guard let offHours = cursor.digits(exactly: 2), offHours <= 23 else { return nil }
                _ = cursor.take(":")
                guard let offMinutes = cursor.digits(exactly: 2), offMinutes <= 59 else { return nil }
                offsetMs = (offHours * 60 + offMinutes) * 60_000 * (sign == "-" ? -1 : 1)
            } else {
                return nil // local time: not ported (see above)
            }
        }
        guard cursor.atEnd else { return nil }
        let epochMs = days(fromCivil: year, month, day) * 86_400_000 + timeMs - offsetMs
        let value = Double(epochMs)
        return Swift.abs(value) <= maxEpochMs ? value : nil
    }

    /// A cursor over the stamp's scalars; every `take` consumes only on a match.
    struct StampCursor {
        let scalars: [Unicode.Scalar]
        var index = 0

        init(_ text: String) { scalars = Array(text.unicodeScalars) }

        var atEnd: Bool { index == scalars.count }

        mutating func take(_ expected: Unicode.Scalar) -> Bool {
            guard index < scalars.count, scalars[index] == expected else { return false }
            index += 1
            return true
        }

        mutating func take(anyOf options: [Unicode.Scalar]) -> Unicode.Scalar? {
            guard index < scalars.count, options.contains(scalars[index]) else { return nil }
            index += 1
            return scalars[index - 1]
        }

        mutating func digits(exactly count: Int) -> Int64? {
            guard index + count <= scalars.count else { return nil }
            var value: Int64 = 0
            for scalar in scalars[index..<(index + count)] {
                guard ("0"..."9").contains(scalar) else { return nil }
                value = value * 10 + Int64(scalar.value - 48)
            }
            index += count
            return value
        }

        /// One or more digits after the point; the first three are the
        /// milliseconds (`.1` is 100 ms) and the rest are dropped, as V8 drops them.
        mutating func fractionMillis() -> Int64? {
            var taken = 0
            var millis: Int64 = 0
            while index < scalars.count, ("0"..."9").contains(scalars[index]) {
                if taken < 3 { millis = millis * 10 + Int64(scalars[index].value - 48) }
                taken += 1
                index += 1
            }
            guard taken > 0 else { return nil }
            for _ in min(taken, 3)..<3 { millis *= 10 }
            return millis
        }
    }
}

// MARK: - Reading (JSON.parse)

extension JSONNode {
    public struct ParseError: Error, Equatable, CustomStringConvertible {
        public let offset: Int
        public let reason: String
        public var description: String { "JSON.parse: \(reason) at scalar \(offset)" }
    }

    /// `JSON.parse(text)`, keeping object members in their order. Throws
    /// wherever `JSON.parse` throws a SyntaxError: a trailing comma, a single
    /// quote, a leading zero, `NaN`, an unescaped control character, trailing
    /// text. A key given twice keeps its FIRST position and its LAST value,
    /// which is what `JSON.parse` builds.
    ///
    /// WHY NOT JSONSerialization. It loses member order (so a parsed row could
    /// not be re-written byte for byte) and it reads `1`/`true` as NSNumbers
    /// that differ between Darwin and Linux Foundation. The engine reads the
    /// rows the page wrote; the rule for reading them is JSON.parse's.
    ///
    /// (A lone `\udxxx` escape, which JavaScript keeps as a lone surrogate,
    /// becomes U+FFFD: a Swift String cannot hold it.)
    public static func parse(_ text: String) throws -> JSONNode {
        var reader = Reader(Array(text.unicodeScalars))
        reader.skipSpace()
        let value = try reader.value(depth: 0)
        reader.skipSpace()
        guard reader.atEnd else { throw reader.fail("unexpected text after the value") }
        return value
    }

    struct Reader {
        /// Deeper than any row, shallow enough that a hostile row cannot blow
        /// the main thread's stack.
        static let maxDepth = 512

        let scalars: [Unicode.Scalar]
        var index = 0

        init(_ scalars: [Unicode.Scalar]) { self.scalars = scalars }

        var atEnd: Bool { index >= scalars.count }
        var current: Unicode.Scalar? { index < scalars.count ? scalars[index] : nil }

        func fail(_ reason: String) -> ParseError { ParseError(offset: index, reason: reason) }

        /// JSON's whitespace is these four and nothing else (not U+00A0, not U+FEFF).
        mutating func skipSpace() {
            while let scalar = current, scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" {
                index += 1
            }
        }

        mutating func expect(_ word: String) throws {
            for scalar in word.unicodeScalars {
                guard current == scalar else { throw fail("expected \(word)") }
                index += 1
            }
        }

        mutating func value(depth: Int) throws -> JSONNode {
            guard depth < Reader.maxDepth else { throw fail("nested too deeply") }
            guard let scalar = current else { throw fail("unexpected end of input") }
            switch scalar {
            case "{": return try object(depth: depth)
            case "[": return try array(depth: depth)
            case "\"": return .string(try string())
            case "t": try expect("true"); return .bool(true)
            case "f": try expect("false"); return .bool(false)
            case "n": try expect("null"); return .null
            case "-", "0"..."9": return .number(try number())
            default: throw fail("unexpected character")
            }
        }

        mutating func object(depth: Int) throws -> JSONNode {
            index += 1 // {
            var members: [JSONMember] = []
            skipSpace()
            if current == "}" { index += 1; return .object(members) }
            while true {
                skipSpace()
                guard current == "\"" else { throw fail("expected a key") }
                let key = try string()
                skipSpace()
                guard current == ":" else { throw fail("expected :") }
                index += 1
                skipSpace()
                let member = try value(depth: depth + 1)
                if let existing = members.firstIndex(where: { $0.key == key }) {
                    members[existing] = JSONMember(key, member)
                } else {
                    members.append(JSONMember(key, member))
                }
                skipSpace()
                if current == "," { index += 1; continue }
                if current == "}" { index += 1; return .object(members) }
                throw fail("expected , or }")
            }
        }

        mutating func array(depth: Int) throws -> JSONNode {
            index += 1 // [
            var items: [JSONNode] = []
            skipSpace()
            if current == "]" { index += 1; return .array(items) }
            while true {
                skipSpace()
                items.append(try value(depth: depth + 1))
                skipSpace()
                if current == "," { index += 1; continue }
                if current == "]" { index += 1; return .array(items) }
                throw fail("expected , or ]")
            }
        }

        mutating func string() throws -> String {
            index += 1 // opening quote
            var out = String.UnicodeScalarView()
            while true {
                guard let scalar = current else { throw fail("unterminated string") }
                index += 1
                switch scalar {
                case "\"":
                    return String(out)
                case "\\":
                    guard let escape = current else { throw fail("unterminated escape") }
                    index += 1
                    switch escape {
                    case "\"": out.append("\"")
                    case "\\": out.append("\\")
                    case "/": out.append("/")
                    case "b": out.append("\u{8}")
                    case "f": out.append("\u{C}")
                    case "n": out.append("\n")
                    case "r": out.append("\r")
                    case "t": out.append("\t")
                    case "u":
                        let unit = try hex4()
                        if (0xD800...0xDBFF).contains(unit), current == "\\",
                           index + 1 < scalars.count, scalars[index + 1] == "u" {
                            let save = index
                            index += 2
                            let low = try hex4()
                            if (0xDC00...0xDFFF).contains(low) {
                                let combined = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                                out.append(Unicode.Scalar(combined) ?? "\u{FFFD}")
                                continue
                            }
                            index = save
                        }
                        out.append(Unicode.Scalar(unit) ?? "\u{FFFD}")
                    default:
                        throw fail("bad escape")
                    }
                default:
                    guard scalar.value >= 0x20 else { throw fail("unescaped control character") }
                    out.append(scalar)
                }
            }
        }

        mutating func hex4() throws -> UInt32 {
            guard index + 4 <= scalars.count else { throw fail("short \\u escape") }
            var value: UInt32 = 0
            for scalar in scalars[index..<(index + 4)] {
                guard let digit = Int(String(scalar), radix: 16) else { throw fail("bad \\u escape") }
                value = value * 16 + UInt32(digit)
            }
            index += 4
            return value
        }

        /// JSON's number grammar, strictly: `-?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?`.
        /// The value is `Double(text)`, which rounds correctly as JSON.parse
        /// does, and overflows to an infinity as JSON.parse does (`1e400`).
        mutating func digitRun() -> Int {
            var count = 0
            while let scalar = current, ("0"..."9").contains(scalar) {
                index += 1
                count += 1
            }
            return count
        }

        mutating func number() throws -> Double {
            let start = index
            if current == "-" { index += 1 }
            if current == "0" {
                index += 1
            } else {
                guard digitRun() > 0 else { throw fail("expected a digit") }
            }
            if current == "." {
                index += 1
                guard digitRun() > 0 else { throw fail("expected a digit after .") }
            }
            if current == "e" || current == "E" {
                index += 1
                if current == "+" || current == "-" { index += 1 }
                guard digitRun() > 0 else { throw fail("expected an exponent") }
            }
            var text = String.UnicodeScalarView()
            text.append(contentsOf: scalars[start..<index])
            let spelled = String(text)
            if let value = Double(spelled) { return value }
            // The grammar above already held, so the only way `Double(_:)` can
            // refuse is a magnitude out of range, which JSON.parse reads as
            // ±Infinity (too large) or ±0 (too small) rather than failing.
            let negative = spelled.hasPrefix("-")
            let tiny = spelled.contains("e-") || spelled.contains("E-")
            return tiny ? (negative ? -0.0 : 0) : (negative ? -.infinity : .infinity)
        }
    }
}

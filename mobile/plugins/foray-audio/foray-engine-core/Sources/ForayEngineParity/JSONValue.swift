import Foundation
import ForayEngineCore

/// Any JSON value, compared structurally: what a fixture file holds, before
/// any macro or `$num` tag means anything (docs/native-engine-plan.md §6.2).
///
/// Numbers are `Double`, which is what both `JSON.parse` on the page and
/// Foundation's decoders produce, so `2` and `2.0` in a fixture are one value
/// here exactly as they are in the JS runner. A `JSONValue` never holds NaN,
/// an infinity or -0 read from a file (JSON cannot spell them); those travel
/// as `{"$num": ...}` objects, and only `JSValue` (the decoded side) holds the
/// real numbers.
public enum JSONValue: Codable, Equatable, CustomStringConvertible {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        // Bool BEFORE Double: Foundation's decoders refuse to read `true` as a
        // number and `1` as a Bool on every platform the core targets, so the
        // order only matters for speed, but it is the order a reader expects.
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
        self = .object(try container.decode([String: JSONValue].self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(values): try container.encode(values)
        case let .object(fields): try container.encode(fields)
        }
    }

    /// Decode one JSON document.
    public static func parse(_ data: Data) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// The member `key` of an object, or nil for a missing key or a non-object.
    public subscript(key: String) -> JSONValue? {
        guard case let .object(fields) = self else { return nil }
        return fields[key]
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(values) = self { return values }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(fields) = self { return fields }
        return nil
    }

    /// Compact, key-sorted text for a failure message. Numbers are spelled the
    /// way JavaScript spells them (`2`, not `2.0`), so a diff printed here
    /// reads the same as the one `record.mjs --check` prints for the same case.
    public var description: String {
        switch self {
        case .null: return "null"
        case let .bool(value): return String(value)
        case let .number(value): return JSNumber.string(value)
        case let .string(value): return JSONValue.quote(value)
        case let .array(values): return "[" + values.map(\.description).joined(separator: ",") + "]"
        case let .object(fields):
            return "{" + fields.keys.sorted().map { "\(JSONValue.quote($0)):\(fields[$0]!.description)" }
                .joined(separator: ",") + "}"
        }
    }

    static func quote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

/// How JavaScript's `String(number)` spells a number (ECMA-262
/// Number::toString), for the few places a parity result or message carries
/// a number as TEXT: the comparator's `differs by more than 0.1`, and a
/// failure message that must read the same as `record.mjs --check`'s.
///
/// WHY NOT `"\(double)"`. Swift prints `2.0`, `1e-07` and `1e+16` where
/// JavaScript prints `2`, `1e-7` and `10000000000000000`.
///
/// ONE implementation: the core's `JSWriter.numberToString`, which the shared
/// rows are printed with and the `number-format` family pins (NE-10s). Until
/// that card this was a copy of the same algorithm; a second copy is a second
/// definition that only one of the two families would ever check.
public enum JSNumber {
    public static func string(_ value: Double) -> String {
        JSWriter.numberToString(value)
    }
}

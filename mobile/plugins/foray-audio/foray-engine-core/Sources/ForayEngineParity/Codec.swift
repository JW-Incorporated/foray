import Foundation

/// A JavaScript value, as far as a parity case can build one: what a case's
/// `args` MEAN once the runner has expanded them, and what a Swift port's
/// answer is encoded from.
///
/// It exists beside `JSONValue` because the rules the fixtures pin are about
/// values JSON cannot hold. seam-gap's "a nonsense length collapses to no
/// beat" is a test about NaN and Infinity, and "called with nothing at all"
/// is a test about `undefined`. A `FamilyRunner` reads these the way the JS
/// function reads its arguments, then hands its typed Swift port the answer.
public enum JSValue: Equatable {
    case undefined
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSValue])
    case object([String: JSValue])

    /// `value.key` in JavaScript: a missing key, and any member of a
    /// non-object, is `undefined`. (Member access on `null`/`undefined` THROWS
    /// in JavaScript; a runner that can meet one checks `isNullish` first,
    /// because that throw is part of the rule it ports.)
    public subscript(key: String) -> JSValue {
        guard case let .object(fields) = self else { return .undefined }
        return fields[key] ?? .undefined
    }

    /// JavaScript truthiness: `if (value)`.
    public var isTruthy: Bool {
        switch self {
        case .undefined, .null: return false
        case let .bool(value): return value
        case let .number(value): return !(value == 0 || value.isNaN)
        case let .string(value): return !value.isEmpty
        case .array, .object: return true
        }
    }

    public var isNullish: Bool {
        switch self {
        case .undefined, .null: return true
        default: return false
        }
    }

    /// The number, when this is one (`typeof value === "number"`), else nil.
    public var numberValue: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    /// A plain conversion with NO tag or macro handling: what a JS runner gets
    /// from `JSON.parse` before `expandInputs` touches anything.
    public init(raw: JSONValue) {
        switch raw {
        case .null: self = .null
        case let .bool(value): self = .bool(value)
        case let .number(value): self = .number(value)
        case let .string(value): self = .string(value)
        case let .array(values): self = .array(values.map(JSValue.init(raw:)))
        case let .object(fields): self = .object(fields.mapValues(JSValue.init(raw:)))
        }
    }
}

/// A CASE is malformed, as opposed to the rule under test throwing. The codes
/// are the closed `$defs.harnessError` enum of
/// `player/parity/schema/fixture.schema.json`, the same ones the JS runner
/// raises, so a broken fixture reports the same code in both runtimes.
public struct HarnessError: Error, CustomStringConvertible, Equatable {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code): \(message)" }
}

/// The Swift half of `player/parity/codec.js`. Every rule here is that file's,
/// in the same order, and each one says which JS line it mirrors; the
/// `compare` family (which round-trips its inputs through exactly this code on
/// both sides) and the seam-gap family (which leans on `$seg`, `$ep`, `$tts`
/// and every `$num` tag) are what hold the two implementations together.
public enum Codec {
    /// codec.js `SPECIAL_NUMBERS`.
    public static let specialNumbers = ["NaN", "Infinity", "-Infinity", "-0"]
    /// codec.js `MACROS`.
    public static let macros = ["$seg", "$ep", "$tts", "$foray"]

    /// What `$foray: "<id>"` needs: the repo root, to read `data/forays.json`.
    public struct Context {
        public let repoRoot: URL?
        public init(repoRoot: URL?) { self.repoRoot = repoRoot }
    }

    // MARK: encode (codec.js `encode`)

    /// A value the Swift port produced, as fixture JSON. JSON-illegal numbers
    /// become their tags; an object member holding `undefined` is DROPPED, as
    /// `encode` and `JSON.stringify` both drop it (neither reader can tell
    /// "absent" from "undefined", so neither may the comparison).
    public static func encode(_ value: JSValue) -> JSONValue {
        switch value {
        case .undefined: return .object(["$undefined": .bool(true)])
        case .null: return .null
        case let .bool(flag): return .bool(flag)
        case let .string(text): return .string(text)
        case let .number(number): return encode(number)
        case let .array(values): return .array(values.map { encode($0) })
        case let .object(fields):
            var out: [String: JSONValue] = [:]
            for (key, member) in fields where member != .undefined {
                out[key] = encode(member)
            }
            return .object(out)
        }
    }

    public static func encode(_ number: Double) -> JSONValue {
        if number.isNaN { return .object(["$num": .string("NaN")]) }
        if number == .infinity { return .object(["$num": .string("Infinity")]) }
        if number == -.infinity { return .object(["$num": .string("-Infinity")]) }
        if number == 0 && number.sign == .minus { return .object(["$num": .string("-0")]) }
        return .number(number)
    }

    // MARK: decodeSpecial (codec.js `decodeSpecial`)

    /// Tags only, never macros: `{"$num": "NaN"}` -> NaN, `{"$undefined": true}`
    /// -> undefined, recursively. An unknown `$num` tag is E_BAD_SPECIAL.
    public static func decodeSpecial(_ value: JSONValue) throws -> JSValue {
        switch value {
        case let .array(values):
            return .array(try values.map(decodeSpecial))
        case let .object(fields):
            if fields.count == 1, let tag = fields["$num"] {
                switch tag.stringValue {
                case "NaN"?: return .number(.nan)
                case "Infinity"?: return .number(.infinity)
                case "-Infinity"?: return .number(-.infinity)
                case "-0"?: return .number(-0.0)
                default: throw HarnessError("E_BAD_SPECIAL", "unknown $num tag \(tag)")
                }
            }
            // `{"$undefined": <anything>}` is undefined: codec.js checks the key,
            // not the value.
            if fields.count == 1, fields["$undefined"] != nil { return .undefined }
            return .object(try fields.mapValues(decodeSpecial))
        default:
            return JSValue(raw: value)
        }
    }

    // MARK: expandInputs (codec.js `expandInputs`)

    /// A case's inputs as live values: macros expanded, tags decoded.
    public static func expandInputs(_ value: JSONValue, _ ctx: Context) throws -> JSValue {
        switch value {
        case let .array(values):
            return .array(try values.map { try expandInputs($0, ctx) })
        case let .object(fields):
            if fields.count == 1, let key = fields.keys.first, key.hasPrefix("$") {
                if key == "$num" || key == "$undefined" { return try decodeSpecial(value) }
                if macros.contains(key) { return try expandMacro(key, fields[key]!, ctx) }
                throw HarnessError("E_BAD_MACRO", "unknown tag \(key)")
            }
            var out: [String: JSValue] = [:]
            for (key, member) in fields {
                if key.hasPrefix("$") {
                    throw HarnessError("E_BAD_MACRO", "a tag (\(key)) must be the only key of its object")
                }
                out[key] = try expandInputs(member, ctx)
            }
            return .object(out)
        default:
            return JSValue(raw: value)
        }
    }

    static func expandMacro(_ name: String, _ arg: JSONValue, _ ctx: Context) throws -> JSValue {
        func tuple(_ min: Int, _ max: Int) throws -> [JSONValue] {
            guard let items = arg.arrayValue, items.count >= min, items.count <= max else {
                throw HarnessError("E_BAD_MACRO", "\(name) takes an array of \(min)-\(max) elements, got \(arg)")
            }
            return items
        }
        // The trailing "extra fields" object, expanded; absent is {}.
        func extra(_ items: [JSONValue], at index: Int) throws -> [String: JSValue] {
            guard index < items.count else { return [:] }
            guard case .object = items[index] else {
                throw HarnessError("E_BAD_MACRO", "\(name)'s last element must be an object of extra fields")
            }
            guard case let .object(fields) = try expandInputs(items[index], ctx) else { return [:] }
            return fields
        }
        // `{id, kind, ...}` then `...extra`: a later key wins, as a JS spread does.
        func item(_ base: [String: JSValue], _ more: [String: JSValue]) -> JSValue {
            .object(base.merging(more) { _, extraValue in extraValue })
        }
        switch name {
        case "$seg":
            // `const [id, start = 100, end = 210, more] = tuple(1, 4)`: a default
            // applies only to a MISSING element (JSON has no undefined), and the
            // id is taken raw, exactly as the destructuring takes it.
            let items = try tuple(1, 4)
            let start: JSValue = try items.count > 1 ? decodeSpecial(items[1]) : .number(100)
            let end: JSValue = try items.count > 2 ? decodeSpecial(items[2]) : .number(210)
            let more = try extra(items, at: 3)
            return item([
                "id": JSValue(raw: items[0]), "kind": .string("episode"),
                "start_sec": start, "end_sec": end
            ], more)
        case "$ep":
            let items = try tuple(1, 2)
            let more = try extra(items, at: 1)
            return item(["id": JSValue(raw: items[0]), "kind": .string("episode")], more)
        case "$tts":
            let items = try tuple(1, 2)
            let more = try extra(items, at: 1)
            return item(["id": JSValue(raw: items[0]), "kind": .string("tts")], more)
        case "$foray":
            if let id = arg.stringValue { return try committedForay(id, ctx) }
            if case let .object(fields) = arg, fields["id"]?.stringValue != nil, fields["items"]?.arrayValue != nil,
               case let .object(expanded) = try expandInputs(arg, ctx) {
                return item(["title": .string("")], expanded)
            }
            throw HarnessError("E_BAD_MACRO", "$foray takes a committed Foray id or {id, title?, items[]}")
        default:
            throw HarnessError("E_BAD_MACRO", "unknown macro \(name)")
        }
    }

    /// `$foray: "<id>"`: the committed Foray, RAW (codec.js returns a
    /// structured clone of the parsed JSON and expands nothing inside it).
    static func committedForay(_ id: String, _ ctx: Context) throws -> JSValue {
        guard let root = ctx.repoRoot else {
            throw HarnessError("E_BAD_MACRO", "$foray needs the repo root, and this run has none")
        }
        let file = root.appendingPathComponent("data").appendingPathComponent("forays.json")
        let doc = try JSONValue.parse(try Data(contentsOf: file))
        for foray in doc["forays"]?.arrayValue ?? [] where foray["id"]?.stringValue == id {
            return JSValue(raw: foray)
        }
        throw HarnessError("E_BAD_MACRO", "$foray names \"\(id)\", which is not in data/forays.json")
    }
}

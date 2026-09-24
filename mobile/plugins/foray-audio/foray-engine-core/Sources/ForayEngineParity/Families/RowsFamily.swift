import Foundation
import ForayEngineCore

/// The `rows` family against `Rows` and the `number-format` family against
/// `JSWriter` (ForayEngineCore/Persist, card NE-10s), from the fixtures
/// NE-10j recorded through the page's real writers (player/parity/rows.js).
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION (as in SeamGapFamily). Each
/// rows.js adapter hands its writer untyped JS values; the Swift builders take
/// typed ones. Every mapping below is one JS read:
///
///   `seconds`, `elapsedSec`, ...   a number is a number; anything else is nil,
///                                  the `typeof x === "number"` every gate asks
///   `title`, `segmentId`, ...      a string is a string; anything else is nil,
///                                  which every JS default and `nonEmpty` read
///                                  the same way (Rows.ForayProgressInput)
///   `meta = {}`                    absent meta reads as `{}`; a NULL meta
///                                  throws, but only past the gate, because
///                                  `meta.duration` is read after it
///   `new Date(nowMs)`              `toISOString()` throws a RangeError for a
///                                  time a Date cannot hold, and each adapter
///                                  meets that throw where its JS does:
///                                  cp_pos BEFORE its gate (the stamp is an
///                                  argument of positionRow), cp_foray and
///                                  cp_last_episode AFTER theirs
///
/// The result is what the recording Storage saw: `[{key, value}]`, or `[]`
/// for a refused write. `value` is the whole row as a STRING, so the
/// comparator compares the bytes of the row, not a re-sorted object.
public enum RowsFamily {
    public static let rowsModule = "player/parity/rows.js"
    public static let contractModule = "player/engine-contract.js"

    /// The family spans two modules (the rows' adapters, and OWNED_PREFIXES
    /// read from engine-contract.js), and a PureFamilyRunner ports exactly one.
    public static let runner = ModuleDispatchRunner(family: "rows", runners: [
        PureFamilyRunner(
            family: "rows",
            module: RowsFamily.rowsModule,
            reads: [:],
            calls: [
                "cpPosRow": { args in
                    let stamp = try RowsFamily.timestamp(RowsFamily.arg(args, 3))
                    guard let updatedAt = stamp else { return .threw("RangeError") }
                    let episodeId = try RowsFamily.id(RowsFamily.arg(args, 0))
                    let meta = RowsFamily.arg(args, 2)
                    let row = Rows.position(id: episodeId, seconds: RowsFamily.arg(args, 1).numberValue,
                                            duration: meta["duration"].numberValue, updatedAt: updatedAt)
                    if row != nil && meta == .null { return .threw("TypeError") }
                    return .returned(RowsFamily.writes(row))
                },
                "cpForayRow": { args in
                    // `{...progress}`: spreading null or undefined gives {}, whose
                    // members all read as undefined, which JSValue's subscript gives.
                    let p = RowsFamily.arg(args, 0)
                    let stamp = try RowsFamily.timestamp(RowsFamily.arg(args, 1))
                    let input = Rows.ForayProgressInput(
                        forayId: p["forayId"].stringValue, title: p["title"].stringValue,
                        elapsedSec: p["elapsedSec"].numberValue, totalSec: p["totalSec"].numberValue,
                        index: p["index"].numberValue, segmentId: p["segmentId"].stringValue,
                        intoSec: p["intoSec"].numberValue)
                    let row = Rows.forayProgress(input, updatedAt: stamp ?? "")
                    if row != nil && stamp == nil { return .threw("RangeError") }
                    return .returned(RowsFamily.writes(row))
                },
                "cpLastEpisodeRow": { args in
                    let stamp = try RowsFamily.timestamp(RowsFamily.arg(args, 1))
                    let row = Rows.lastEpisode(RowsFamily.node(RowsFamily.arg(args, 0)), updatedAt: stamp ?? "")
                    if row != nil && stamp == nil { return .threw("RangeError") }
                    return .returned(RowsFamily.writes(row))
                }
            ]),
        PureFamilyRunner(
            family: "rows",
            module: RowsFamily.contractModule,
            reads: ["OWNED_PREFIXES": .array(Rows.ownedPrefixes.map { JSValue.string($0) })],
            calls: [:])
    ])

    static func arg(_ args: [JSValue], _ index: Int) -> JSValue {
        index < args.count ? args[index] : .undefined
    }

    /// `new Date(nowMs).toISOString()`: nil where it throws. Every recorded
    /// case passes epoch milliseconds; anything else is a case this runner
    /// cannot translate, not a rule it may guess.
    static func timestamp(_ value: JSValue) throws -> String? {
        guard case let .number(ms) = value else {
            throw HarnessError("E_BAD_CASE", "nowMs must be epoch milliseconds, got \(Codec.encode(value))")
        }
        return Rows.timestamp(epochMs: ms)
    }

    /// An episode id. Every FALSY id is refused by `!id`, as the empty string
    /// is, so they all translate to "". A truthy non-string id (a number)
    /// would be interpolated into the key by JS; the engine's ids are strings
    /// and no case spells one, so it is refused as untranslatable.
    static func id(_ value: JSValue) throws -> String {
        if case let .string(text) = value { return text }
        if !value.isTruthy { return "" }
        throw HarnessError("E_BAD_CASE", "a non-string episode id \(Codec.encode(value)) has no Swift spelling")
    }

    /// A JS value as the JSON `JSON.stringify` would write of it: an
    /// `undefined` member is absent, an `undefined` array element is null. An
    /// object's members come out in key order, because a JSValue object is a
    /// dictionary; only the ORDER of a nested object inside a kept field could
    /// differ from JS, and no rows case has one (a snapshot field is a scalar).
    static func node(_ value: JSValue) -> JSONNode {
        switch value {
        case .undefined, .null: return .null
        case let .bool(flag): return .bool(flag)
        case let .number(number): return .number(number)
        case let .string(text): return .string(text)
        case let .array(items): return .array(items.map { node($0) })
        case let .object(fields):
            return .object(fields.keys.sorted().compactMap { key -> JSONMember? in
                guard let member = fields[key], member != .undefined else { return nil }
                return JSONMember(key, node(member))
            })
        }
    }

    /// What the recording Storage saw.
    static func writes(_ row: StoredRow?) -> JSValue {
        guard let row else { return .array([]) }
        return .array([.object(["key": .string(row.key), "value": .string(row.value)])])
    }
}

/// The `number-format` family: `jsonNumber(x)` is `JSON.stringify(x)`, the
/// way every number inside a shared row is printed.
public enum NumberFormatFamily {
    public static let runner = PureFamilyRunner(
        family: "number-format",
        module: RowsFamily.rowsModule,
        reads: [:],
        calls: [
            "jsonNumber": { args in
                guard case let .number(value) = RowsFamily.arg(args, 0) else {
                    throw HarnessError("E_BAD_CASE", "jsonNumber takes a number")
                }
                return .returned(.string(JSWriter.jsonNumber(value)))
            }
        ])
}

/// A family whose fixture files target more than one JS module: each file is
/// run by the port of ITS module, and a file naming any other module is
/// refused, as PureFamilyRunner refuses one (runner.js reads the module from
/// the file for the same reason).
public struct ModuleDispatchRunner: FamilyRunner {
    public let family: String
    public let runners: [String: PureFamilyRunner]

    public init(family: String, runners: [PureFamilyRunner]) {
        self.family = family
        var byModule: [String: PureFamilyRunner] = [:]
        for runner in runners { byModule[runner.module] = runner }
        self.runners = byModule
    }

    public func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard let module = file.module, let runner = runners[module] else {
            throw HarnessError("E_BAD_CASE", "\(file.path) targets \(file.module ?? "no module"); the Swift \(family) runner ports \(runners.keys.sorted().joined(separator: ", "))")
        }
        return try runner.run(testCase, in: file, context: context)
    }
}

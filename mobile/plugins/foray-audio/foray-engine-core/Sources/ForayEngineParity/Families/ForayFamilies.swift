import Foundation
import ForayEngineCore

/// The `foray-clock` family against `ForayClock` (ForayEngineCore/Policy),
/// card NE-29s, from the cases NE-29j recorded: runtime.json
/// (player/foray-queue.js), position.json (player/foray-resolve.js) and
/// committed.json (player/parity/forays.js, over the page's build of every
/// committed Foray; see `ForaysModuleRunner`).
///
/// Translation only (ForayHarness.swift): each call reads its arguments the
/// way the JS function does and hands the typed port the answer.
public enum ForayClockFamily {
    public static let queueModule = "player/foray-queue.js"
    public static let resolveModule = "player/foray-resolve.js"

    public static let runner: FamilyRunner = ModuleRoutedRunner(family: "foray-clock", routes: [
        ForayClockFamily.queueModule: PureFamilyRunner(
            family: "foray-clock",
            module: ForayClockFamily.queueModule,
            reads: [
                "JINGLE_DURATION_SEC": .number(ForayClock.jingleDurationSec),
                "NARRATION_CHARS_PER_SEC": .number(ForayClock.narrationCharsPerSec),
                "NARRATION_FALLBACK_SEC": .number(ForayClock.narrationFallbackSec),
                "DURATION_MEASURED": .string(ForayClock.durationMeasured),
                "DURATION_ESTIMATED": .string(ForayClock.durationEstimated),
                "DURATION_FALLBACK": .string(ForayClock.durationFallback),
                "JINGLE": .string(ForayClock.jingle)
            ],
            calls: [
                "narrationDuration": ForayClockFamily.narrationDuration,
                "itemRuntimeSec": ForayClockFamily.itemRuntimeSec,
                "forayRuntimeSec": ForayClockFamily.forayRuntimeSec,
                "runtimeIsEstimated": ForayClockFamily.runtimeIsEstimated
            ]),
        ForayClockFamily.resolveModule: PureFamilyRunner(
            family: "foray-clock",
            module: ForayClockFamily.resolveModule,
            reads: [:],
            calls: [
                "segmentStarts": ForayClockFamily.segmentStarts,
                "segmentAtElapsed": ForayClockFamily.segmentAtElapsed,
                "forayElapsed": ForayClockFamily.forayElapsed,
                "progressSegments": ForayClockFamily.progressSegments
            ]),
        ForaysModuleRunner.module: ForaysModuleRunner(family: "foray-clock")
    ])

    /// `narrationDuration(item)`: `item?.x`, so a non-object is no fields.
    static func narrationDuration(_ args: [JSValue]) throws -> CallOutcome {
        let d = ForayClock.narrationDuration(ForayArgs.item(ForayArgs.arg(args, 0)))
        return .returned(.object(["sec": .number(d.sec), "source": .string(d.source)]))
    }

    static func itemRuntimeSec(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.number(ForayClock.itemRuntimeSec(ForayArgs.item(ForayArgs.arg(args, 0)))))
    }

    /// `(items ?? []).reduce(...)`.
    static func forayRuntimeSec(_ args: [JSValue]) throws -> CallOutcome {
        let items = try ForayArgs.items(ForayArgs.arg(args, 0), "forayRuntimeSec's items")
        return .returned(.number(ForayClock.forayRuntimeSec(items)))
    }

    /// `Array.isArray(items)` first: anything else is simply false.
    static func runtimeIsEstimated(_ args: [JSValue]) throws -> CallOutcome {
        guard case let .array(values) = ForayArgs.arg(args, 0) else { return .returned(.bool(false)) }
        return .returned(.bool(ForayClock.runtimeIsEstimated(values.map(ForayArgs.item))))
    }

    static func segmentStarts(_ args: [JSValue]) throws -> CallOutcome {
        let starts = ForayClock.segmentStarts(try ForayArgs.items(ForayArgs.arg(args, 0), "segmentStarts's items"))
        return .returned(.array(starts.map { JSValue.number($0) }))
    }

    static func segmentAtElapsed(_ args: [JSValue]) throws -> CallOutcome {
        let items = try ForayArgs.items(ForayArgs.arg(args, 0), "segmentAtElapsed's items")
        guard let at = ForayClock.segmentAtElapsed(items, elapsed: ForayArgs.arg(args, 1).numberValue) else {
            return .returned(.null)
        }
        let fields: [String: JSValue] = ["index": .number(Double(at.index)), "into": .number(at.into),
                                         "start": .number(at.start)]
        return .returned(.object(fields))
    }

    /// `forayElapsed(items, index, playheadSec = null)`: `Number.isInteger`
    /// and `isNum` read only numbers.
    static func forayElapsed(_ args: [JSValue]) throws -> CallOutcome {
        let items = try ForayArgs.items(ForayArgs.arg(args, 0), "forayElapsed's items")
        let elapsed = ForayClock.forayElapsed(items, index: ForayArgs.arg(args, 1).numberValue,
                                              playheadSec: ForayArgs.arg(args, 2).numberValue)
        return .returned(.number(elapsed))
    }

    /// `progressSegments(resolved)`: `resolved?.playable ?? []` and
    /// `resolved?.entries ?? []`; an entry is used when
    /// `e && e.playable && Number.isInteger(e.queueIndex)`, with
    /// `e.segment_id ?? null` as its id (only a string id translates).
    static func progressSegments(_ args: [JSValue]) throws -> CallOutcome {
        let resolved = ForayArgs.arg(args, 0)
        let items = try ForayArgs.items(resolved["playable"], "progressSegments's playable")
        var entries: [ForayClock.ProgressEntry?]?
        switch resolved["entries"] {
        case .undefined, .null:
            entries = nil
        case let .array(values):
            var list: [ForayClock.ProgressEntry?] = []
            for entry in values {
                guard entry.isTruthy else {
                    list.append(nil)
                    continue
                }
                let id = entry["segment_id"]
                if !id.isNullish && id.stringValue == nil {
                    throw ArgReading.notRepresentable("an entry's segment_id", id)
                }
                list.append(ForayClock.ProgressEntry(playable: entry["playable"].isTruthy,
                                                     queueIndex: entry["queueIndex"].numberValue,
                                                     segmentId: id.stringValue))
            }
            entries = list
        default:
            throw ArgReading.notRepresentable("progressSegments's entries", resolved["entries"])
        }
        var out: [JSValue] = []
        for row in ForayClock.progressSegments(items, entries: entries) {
            let id: JSValue = row.id.map { JSValue.string($0) } ?? .null
            out.append(.object(["id": id, "startSec": .number(row.startSec), "durationSec": .number(row.durationSec)]))
        }
        return .returned(.array(out))
    }
}

/// The `foray-structure` family against `StructuralCheck` (J-4), card NE-29s:
/// check.json (player/foray-structure.js) and committed.json (every committed
/// Foray's build passes; the frozen capital-types-1 census).
public enum ForayStructureFamily {
    public static let module = "player/foray-structure.js"

    public static let runner: FamilyRunner = ModuleRoutedRunner(family: "foray-structure", routes: [
        ForayStructureFamily.module: PureFamilyRunner(
            family: "foray-structure",
            module: ForayStructureFamily.module,
            reads: [
                "REFUSED_STRUCTURE": .string(StructuralCheck.refusedStructure),
                "QUEUE_KINDS": .array(StructuralCheck.queueKinds.map { .string($0) }),
                "STRUCTURE_PROBLEMS": .array(StructuralCheck.problemCodes.map { .string($0) })
            ],
            calls: [
                "structuralCheck": ForayStructureFamily.structuralCheck,
                "seamCensus": ForayStructureFamily.seamCensus
            ]),
        ForaysModuleRunner.module: ForaysModuleRunner(family: "foray-structure")
    ])

    /// `!Array.isArray(items)` is `empty`, whatever it is.
    static func structuralCheck(_ args: [JSValue]) throws -> CallOutcome {
        guard case let .array(values) = ForayArgs.arg(args, 0) else {
            return .returned(ForayArgs.encode(StructuralCheck.check(nil)))
        }
        return .returned(ForayArgs.encode(StructuralCheck.check(values.map(ForayArgs.item))))
    }

    /// `Array.isArray(items) ? items : []`.
    static func seamCensus(_ args: [JSValue]) throws -> CallOutcome {
        let value = ForayArgs.arg(args, 0)
        guard case .array = value else { return .returned(ForayArgs.encode(StructuralCheck.seamCensus(nil))) }
        return .returned(ForayArgs.encode(StructuralCheck.seamCensus(try ForayArgs.censusItems(value))))
    }
}

/// The `media` family, card NE-29s: the Foray half of the lock-screen mapping
/// NE-12j left (media-mapping.json, `MediaMapping`), the lock-screen rules
/// over every committed Foray (committed.json), and lock-screen / car presses
/// into a Foray playing in the engine (remote.json, through `EngineCore`'s own
/// remote handlers: plan §4.5).
public enum MediaFamily {
    public static let runner: FamilyRunner = ModuleRoutedRunner(family: "media", routes: [
        MediaEpisodeFamily.mappingModule: PureFamilyRunner(
            family: "media",
            module: MediaEpisodeFamily.mappingModule,
            reads: MediaEpisodeFamily.mappingRunner.reads,
            calls: MediaEpisodeFamily.mappingRunner.calls.merging(
                ["narrationCredit": MediaFamily.narrationCredit]) { current, _ in current }),
        ForaysModuleRunner.module: ForaysModuleRunner(family: "media"),
        ModuleRoutedRunner.scenarios: MediaRemoteRunner(driver: EngineScenarioDriver())
    ])

    /// `narrationCredit({forayTitle = "", nextItem = null} = {})`: null throws.
    static func narrationCredit(_ args: [JSValue]) throws -> CallOutcome {
        guard let opts = ArgReading.objectParam(ForayArgs.arg(args, 0), hasDefault: true) else {
            return .threw("TypeError")
        }
        let title: String? = opts["forayTitle"] == .undefined ? "" : opts["forayTitle"].stringValue
        let credit = MediaMapping.narrationCredit(forayTitle: title, nextItem: MediaEpisodeFamily.item(opts["nextItem"]))
        return .returned(.string(credit))
    }
}

/// remote.json: a Foray loaded into the engine, pressed from the lock screen.
struct MediaRemoteRunner: FamilyRunner {
    let family = "media"
    let driver: EngineScenarioDriver

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard testCase.kind == .scenario else {
            throw HarnessError("E_BAD_CASE", "\(file.path) names no module, so its cases must be scenarios")
        }
        return try driver.run(testCase, context: context).encoded
    }
}

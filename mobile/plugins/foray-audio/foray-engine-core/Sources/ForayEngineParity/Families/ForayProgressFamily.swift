import Foundation
import ForayEngineCore

/// The `foray-progress` family against ResumeRules' Foray half and `Rows`
/// (ForayEngineCore), card NE-29s, from the cases NE-29j recorded:
/// progress.json (the pure half of player/foray-progress.js) and storage.json
/// (its storage half through player/parity/foray-store.js `storageRun`).
///
/// Translation only (ForayHarness.swift). The storage half needs a Storage,
/// which no fixture can hold: `storageRun` builds one from data and runs the
/// ops in order, and `ForayStorageRun` below is that adapter's Swift twin. It
/// decides nothing: validity, the throttle, staleness, the order of the list
/// and the row's bytes are all the core's (`ResumeRules`, `Rows`).
public enum ForayProgressFamily {
    public static let module = "player/foray-progress.js"
    public static let storeModule = "player/parity/foray-store.js"

    public static let runner: FamilyRunner = ModuleRoutedRunner(family: "foray-progress", routes: [
        ForayProgressFamily.module: PureFamilyRunner(
            family: "foray-progress",
            module: ForayProgressFamily.module,
            reads: [
                "KEY_PREFIX": .string(Rows.forayKey("")),
                "MIN_RESUME_SEC": .number(ResumeRules.forayMinResumeSec),
                "NEAR_END_SEC": .number(ResumeRules.forayNearEndSec),
                "MAX_AGE_H": .number(ResumeRules.forayMaxAgeH),
                "DRIFT_UNVERIFIED": .string(ResumeRules.ForayDrift.unverified.rawValue),
                "DRIFT_EXACT": .string(ResumeRules.ForayDrift.exact.rawValue),
                "DRIFT_MOVED": .string(ResumeRules.ForayDrift.moved.rawValue),
                "DRIFT_DROPPED": .string(ResumeRules.ForayDrift.dropped.rawValue),
                "DRIFT_UNANCHORED": .string(ResumeRules.ForayDrift.unanchored.rawValue),
                "DRIFT_TOLERANCE_SEC": .number(ResumeRules.forayDriftToleranceSec),
                "PLAYED_LABEL": .string(ResumeRules.forayPlayedLabel),
                "SAVE_EVERY_SEC": .number(ResumeRules.forayWriteEverySec)
            ],
            calls: [
                "progressKey": ForayProgressFamily.progressKey,
                "makeProgress": ForayProgressFamily.makeProgress,
                "isProgressRecord": ForayProgressFamily.isProgressRecord,
                "resumePoint": ForayProgressFamily.resumePoint,
                "reconcileSegment": ForayProgressFamily.reconcileSegment,
                "percentDone": ForayProgressFamily.percentDone,
                "remainingLabel": ForayProgressFamily.remainingLabel,
                "progressLabel": ForayProgressFamily.progressLabel
            ]),
        ForayProgressFamily.storeModule: ForayStorageRunner()
    ])

    static func progressKey(_ args: [JSValue]) throws -> CallOutcome {
        guard let id = ForayArgs.arg(args, 0).stringValue else {
            throw ArgReading.notRepresentable("progressKey's forayId", ForayArgs.arg(args, 0))
        }
        return .returned(.string(Rows.forayKey(id)))
    }

    /// `makeProgress({...})` has no default: null or undefined throws.
    static func makeProgress(_ args: [JSValue]) throws -> CallOutcome {
        let p = ForayArgs.arg(args, 0)
        if p.isNullish { return .threw("TypeError") }
        let row = Rows.makeForayProgress(try input(p), updatedAt: try stamp(p["now"]))
        return .returned(ForayArgs.value(row))
    }

    static func isProgressRecord(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.bool(ResumeRules.isForayProgressRecord(row(ForayArgs.arg(args, 0)))))
    }

    /// `resumePoint(record, {totalSec = null, maxIndex = null, segments = null, present = true} = {})`.
    static func resumePoint(_ args: [JSValue]) throws -> CallOutcome {
        guard let opts = ArgReading.objectParam(ForayArgs.arg(args, 1), hasDefault: true) else { return .threw("TypeError") }
        let found = ResumeRules.forayResumePoint(row(ForayArgs.arg(args, 0)), totalSec: opts["totalSec"].numberValue,
                                                 maxIndex: opts["maxIndex"].numberValue, segments: live(opts["segments"]),
                                                 present: opts["present"] != .bool(false))
        guard let point = found else { return .returned(.null) }
        let fields: [String: JSValue] = [
            "elapsedSec": .number(point.elapsedSec), "index": .number(point.index),
            "remainingSec": .number(point.remainingSec), "percent": .number(point.percent),
            "finished": .bool(point.finished), "drift": .string(point.drift.rawValue)
        ]
        return .returned(.object(fields))
    }

    /// `reconcileSegment(record, segments, {present = true} = {})`.
    static func reconcileSegment(_ args: [JSValue]) throws -> CallOutcome {
        guard let opts = ArgReading.objectParam(ForayArgs.arg(args, 2), hasDefault: true) else { return .threw("TypeError") }
        let at = ResumeRules.reconcileSegment(row(ForayArgs.arg(args, 0)), segments: live(ForayArgs.arg(args, 1)),
                                              present: opts["present"] != .bool(false))
        var out: [String: JSValue] = ["drift": .string(at.drift.rawValue)]
        if let elapsed = at.elapsedSec { out["elapsedSec"] = .number(elapsed) }
        if let index = at.index { out["index"] = .number(Double(index)) }
        return .returned(.object(out))
    }

    static func percentDone(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.number(ResumeRules.percentDone(elapsedSec: ForayArgs.arg(args, 0).numberValue,
                                                 totalSec: ForayArgs.arg(args, 1).numberValue)))
    }

    /// `remainingLabel(remainingSec, {estimated = false} = {})`: `estimated` by truthiness.
    static func remainingLabel(_ args: [JSValue]) throws -> CallOutcome {
        guard let opts = ArgReading.objectParam(ForayArgs.arg(args, 1), hasDefault: true) else { return .threw("TypeError") }
        let label = ResumeRules.remainingLabel(ForayArgs.arg(args, 0).numberValue, estimated: opts["estimated"].isTruthy)
        return .returned(.string(label))
    }

    /// `progressLabel(point, {estimated = false} = {})`: `!point` is "".
    static func progressLabel(_ args: [JSValue]) throws -> CallOutcome {
        guard let opts = ArgReading.objectParam(ForayArgs.arg(args, 1), hasDefault: true) else { return .threw("TypeError") }
        let point = ForayArgs.arg(args, 0)
        guard point.isTruthy else { return .returned(.string("")) }
        let label = ResumeRules.progressLabel(finished: point["finished"].isTruthy,
                                              remainingSec: point["remainingSec"].numberValue,
                                              estimated: opts["estimated"].isTruthy)
        return .returned(.string(label))
    }

    /// A row object as the rules read it; nil for anything but an object.
    static func row(_ value: JSValue) -> ResumeRules.ForayRow? {
        guard case .object = value else { return nil }
        return ResumeRules.ForayRow(forayId: value["foray_id"].stringValue, elapsedSec: value["elapsed_sec"].numberValue,
                                    totalSec: value["total_sec"].numberValue, index: value["index"].numberValue,
                                    segmentId: value["segment_id"].stringValue, intoSec: value["into_sec"].numberValue)
    }

    /// The live running order: nil unless it is an array (`Array.isArray`);
    /// an entry that is not an object is nil (it is never a descriptor).
    static func live(_ value: JSValue) -> [ResumeRules.LiveSegment?]? {
        guard case let .array(values) = value else { return nil }
        return values.map { entry in
            guard case .object = entry else { return nil }
            return ResumeRules.LiveSegment(id: entry["id"].stringValue, startSec: entry["startSec"].numberValue,
                                           durationSec: entry["durationSec"].numberValue)
        }
    }

    /// `makeProgress`'s / `save`'s argument, typed as `Rows.ForayProgressInput`
    /// reads it. `foray_id: forayId` is written RAW by makeProgress, so an id
    /// that is not a string (or absent) has no typed spelling.
    static func input(_ p: JSValue) throws -> Rows.ForayProgressInput {
        let id = p["forayId"]
        if id != .undefined && id.stringValue == nil { throw ArgReading.notRepresentable("forayId", id) }
        return Rows.ForayProgressInput(forayId: id.stringValue, title: p["title"].stringValue,
                                       elapsedSec: p["elapsedSec"].numberValue, totalSec: p["totalSec"].numberValue,
                                       index: p["index"].numberValue, segmentId: p["segmentId"].stringValue,
                                       intoSec: p["intoSec"].numberValue)
    }

    /// `typeof now === "string" ? now : now.toISOString()`: every case names
    /// its instant as a string; the wall clock is never read.
    static func stamp(_ now: JSValue) throws -> String {
        guard let text = now.stringValue else { throw ArgReading.notRepresentable("now", now) }
        return text
    }
}

/// storage.json: `storageRun({storage, initial, everySec, ops})`.
struct ForayStorageRunner: FamilyRunner {
    let family = "foray-progress"

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard testCase.kind == .call, testCase.call == "storageRun" else {
            throw HarnessError("E_UNKNOWN_EXPORT", "\(ForayProgressFamily.storeModule) has no Swift port of export \"\(testCase.call ?? "")\"")
        }
        let args = try testCase.args.map { try Codec.expandInputs($0, context) }
        // Key order matters twice: `write` stringifies the record as given, and
        // the initial rows are the storage's insertion order.
        let ordered = try OrderedFixtureArgs.args(of: testCase.id, in: file, context: context)
        var run = try ForayStorageRun(spec: ForayArgs.arg(args, 0), ordered: ordered.first ?? .null)
        return .object(["return": Codec.encode(try run.run())])
    }
}

/// foray-store.js's adapter, op by op.
struct ForayStorageRun {
    /// `FIXED_NOW`: the instant a case that names none runs at.
    static let fixedNow = "2026-08-16T10:00:00.000Z"

    /// The Storage a case runs against. `fallback` is the store's own
    /// stand-in when the case has none (`getItem` null, `setItem` throws,
    /// no `key()`).
    enum Storage { case memory, none, noKey, fallback }

    let spec: JSValue
    let ordered: JSONNode
    let direct: Storage
    let store: Storage
    var keys: [String] = []
    var values: [String: String] = [:]
    var failWrites = false
    var throttle: ResumeRules.ForayWriteThrottle

    init(spec: JSValue, ordered: JSONNode) throws {
        let storage: Storage
        switch spec["storage"] {
        case .undefined: storage = .memory
        case let .string(name) where name == "memory": storage = .memory
        case let .string(name) where name == "none": storage = .none
        case let .string(name) where name == "noKey": storage = .noKey
        default: throw HarnessError("E_BAD_CASE", "storageRun: unknown storage \(Codec.encode(spec["storage"]))")
        }
        var keys: [String] = []
        var values: [String: String] = [:]
        if storage == .memory, let members = ordered["initial"]?.members {
            for member in members {
                guard let text = member.value.stringValue else {
                    throw HarnessError("E_BAD_CASE", "storageRun: initial.\(member.key) must be a string")
                }
                if values[member.key] == nil { keys.append(member.key) }
                values[member.key] = text
            }
        }
        self.spec = spec
        self.ordered = ordered
        self.direct = storage
        self.store = storage == .none ? .fallback : storage
        self.keys = keys
        self.values = values
        // `everySec` is passed only when present: `isNum(x) && x > 0 ? x : SAVE_EVERY_SEC`.
        self.throttle = ResumeRules.ForayWriteThrottle(everySec: spec["everySec"].numberValue)
    }

    mutating func run() throws -> JSValue {
        guard case let .array(ops) = spec["ops"] else {
            if spec["ops"] == .undefined { return result([]) }
            throw HarnessError("E_BAD_CASE", "storageRun: ops must be an array")
        }
        let orderedOps = ordered["ops"]?.arrayValue ?? []
        var results: [JSValue] = []
        for (i, op) in ops.enumerated() {
            guard case let .array(parts) = op, let name = parts.first?.stringValue else {
                throw HarnessError("E_BAD_CASE", "storageRun: op \(i) is not [name, ...args]")
            }
            let a1 = parts.count > 1 ? parts[1] : .undefined
            switch name {
            case "failWrites":
                guard direct == .memory else { throw HarnessError("E_BAD_CASE", "failWrites needs the memory storage") }
                failWrites = a1 == .bool(true)
                results.append(.null)
            case "write":
                let raw = orderedOps.indices.contains(i) ? orderedOps[i].arrayValue?.dropFirst().first : nil
                results.append(.bool(try write(direct, record: a1, ordered: raw ?? .null)))
            case "read": results.append(try read(direct, a1))
            case "clear":
                clear(direct, a1)
                results.append(.null)
            case "list": results.append(try list(direct, a1))
            case "save": results.append(.bool(try save(stamped(a1), finished: false)))
            case "markFinished": results.append(.bool(try save(stamped(a1), finished: true)))
            case "get": results.append(try read(store, a1))
            case "storeClear":
                clear(store, a1)
                if let id = a1.stringValue { throttle.clear(forayId: id) }
                results.append(.null)
            case "storeList": results.append(try list(store, a1))
            case "counters":
                results.append(.object(["refusedWrites": .number(Double(throttle.refusedWrites)),
                                        "failedWrites": .number(Double(throttle.refusedWrites))]))
            default:
                throw HarnessError("E_BAD_CASE", "storageRun: unknown op \"\(name)\"")
            }
        }
        return result(results)
    }

    func result(_ results: [JSValue]) -> JSValue {
        var rows: [String: JSValue] = [:]
        if direct == .memory { for key in keys { rows[key] = .string(values[key] ?? "") } }
        return .object(["results": .array(results), "rows": .object(rows)])
    }

    // MARK: the Storage

    /// `setItem`: false where the JS write throws (a refusing memory
    /// storage, no `setItem` at all, the store's stand-in).
    mutating func setItem(_ storage: Storage, _ key: String, _ value: String) -> Bool {
        guard storage == .memory, !failWrites else { return false }
        if values[key] == nil { keys.append(key) }
        values[key] = value
        return true
    }

    func getItem(_ storage: Storage, _ key: String) -> String? {
        storage == .memory ? values[key] : nil
    }

    // MARK: foray-progress.js's storage functions

    /// `readProgress(storage, forayId)`.
    func read(_ storage: Storage, _ forayId: JSValue) throws -> JSValue {
        guard storage != .none, let id = forayId.stringValue, Rows.nonEmpty(id),
              let raw = getItem(storage, Rows.forayKey(id)), !raw.isEmpty,
              let node = try? JSONNode.parse(raw) else { return .null }
        let value = ForayArgs.value(node)
        return ResumeRules.isForayProgressRecord(ForayProgressFamily.row(value)) ? value : .null
    }

    /// `writeProgress(storage, record)`: the record stringified in the key
    /// order the case wrote it in.
    mutating func write(_ storage: Storage, record: JSValue, ordered: JSONNode) throws -> Bool {
        guard storage != .none, ResumeRules.isForayProgressRecord(ForayProgressFamily.row(record)),
              let id = record["foray_id"].stringValue else { return false }
        return setItem(storage, Rows.forayKey(id), JSWriter.stringify(try ForayStorageRun.detagged(ordered)))
    }

    /// `clearProgress(storage, forayId)`.
    mutating func clear(_ storage: Storage, _ forayId: JSValue) {
        guard storage == .memory, let id = forayId.stringValue, Rows.nonEmpty(id) else { return }
        let key = Rows.forayKey(id)
        keys.removeAll { $0 == key }
        values[key] = nil
    }

    /// `listProgress(storage, listOpts(o))`: every stored row with the
    /// prefix that reads back, less the stale ones, most recent first.
    func list(_ storage: Storage, _ o: JSValue) throws -> JSValue {
        // listOpts: `now` a string is Date.parse'd, absent is FIXED_NOW.
        let now: Double
        switch o["now"] {
        case .undefined, .null: now = JSDate.parse(ForayStorageRun.fixedNow) ?? .nan
        case let .string(text): now = JSDate.parse(text) ?? .nan
        case let .number(ms): now = ms
        default: throw ArgReading.notRepresentable("list's now", o["now"])
        }
        let maxAgeH: Double
        switch o["maxAgeH"] {
        case .undefined: maxAgeH = ResumeRules.forayMaxAgeH
        case let .number(hours): maxAgeH = hours
        default: throw ArgReading.notRepresentable("list's maxAgeH", o["maxAgeH"])
        }
        // No storage, or no `key()`: nothing to enumerate.
        guard storage == .memory else { return .array([]) }
        let prefix = Rows.forayKey("")
        var out: [(value: JSValue, stamp: String)] = []
        for key in keys where key.hasPrefix(prefix) {
            let row = try read(storage, .string(String(key.dropFirst(prefix.count))))
            guard row != .null else { continue }
            let stamp: Double?
            let text: String
            switch row["updated_at"] {
            case .undefined: stamp = nil; text = "undefined"
            case .null: stamp = nil; text = "null"
            case let .string(value): stamp = JSDate.parse(value); text = value
            default: throw ArgReading.notRepresentable("a row's updated_at", row["updated_at"])
            }
            if ResumeRules.forayRowIsStale(updatedAtMs: stamp, nowMs: now, maxAgeH: maxAgeH) { continue }
            out.append((row, text))
        }
        // Array.prototype.sort is stable: equal stamps keep storage order.
        let sorted = out.enumerated().sorted { a, b in
            if ResumeRules.forayRowSortsBefore(a.element.stamp, b.element.stamp) { return true }
            if ResumeRules.forayRowSortsBefore(b.element.stamp, a.element.stamp) { return false }
            return a.offset < b.offset
        }
        return .array(sorted.map { $0.element.value })
    }

    // MARK: ForayProgressStore

    /// `{...(p ?? {}), now: p?.now ?? FIXED_NOW}`.
    func stamped(_ p: JSValue) -> JSValue {
        var fields: [String: JSValue] = [:]
        if case let .object(given) = p { fields = given }
        if fields["now"]?.isNullish ?? true { fields["now"] = .string(ForayStorageRun.fixedNow) }
        return .object(fields)
    }

    /// `store.save(p)`, or `store.markFinished(p)` (a save at the Foray's own
    /// total, forced past the throttle).
    mutating func save(_ p: JSValue, finished: Bool) throws -> Bool {
        var input = try ForayProgressFamily.input(p)
        if finished { input.elapsedSec = input.totalSec }
        let force = finished || p["force"].isTruthy
        guard let row = throttle.due(input, force: force, updatedAt: try ForayProgressFamily.stamp(p["now"])),
              let id = input.forayId, let elapsed = input.elapsedSec else { return false }
        let ok = setItem(store, row.key, row.value)
        throttle.recorded(forayId: id, elapsedSec: elapsed, ok: ok)
        return ok
    }

    /// A fixture's ordered JSON with its `$num` / `$undefined` tags decoded, as
    /// `JSON.stringify` then prints it (NaN is null; an undefined member is
    /// absent; an undefined array element is null).
    static func detagged(_ node: JSONNode) throws -> JSONNode {
        switch node {
        case let .array(items):
            return .array(try items.map { (item: JSONNode) throws -> JSONNode in
                if case .object = item, let decoded = try tag(item) { return decoded ?? .null }
                return try detagged(item)
            })
        case let .object(members):
            if let decoded = try tag(node) { return decoded ?? .null }
            var out: [JSONMember] = []
            for member in members {
                if let decoded = try tag(member.value) {
                    if let value = decoded { out.append(JSONMember(member.key, value)) }
                    continue
                }
                out.append(JSONMember(member.key, try detagged(member.value)))
            }
            return .object(out)
        default:
            return node
        }
    }

    /// A tag object's value: nil if it is not a tag, `.some(nil)` for
    /// `$undefined`, the number for `$num`. A macro has no place in a row.
    static func tag(_ node: JSONNode) throws -> JSONNode?? {
        guard let members = node.members, members.count == 1, let member = members.first, member.key.hasPrefix("$") else {
            return nil
        }
        switch member.key {
        case "$undefined": return .some(nil)
        case "$num":
            switch member.value.stringValue {
            case "NaN"?: return .some(.number(.nan))
            case "Infinity"?: return .some(.number(.infinity))
            case "-Infinity"?: return .some(.number(-.infinity))
            case "-0"?: return .some(.number(-0.0))
            default: throw HarnessError("E_BAD_SPECIAL", "unknown $num tag \(member.value)")
            }
        default:
            throw HarnessError("E_BAD_MACRO", "\(member.key) has no place in a stored row")
        }
    }
}

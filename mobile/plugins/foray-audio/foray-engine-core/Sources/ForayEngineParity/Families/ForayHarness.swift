import Foundation
import ForayEngineCore

/// What the NE-29s families share: reading a built queue item the way the JS
/// rules read it, routing a family's files by module, and the committed
/// Forays (player/parity/forays.js), card NE-29s.
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION (SeamGapFamily's rule).
/// Where JavaScript would do something with a value that a typed port has no
/// parameter for, the case fails as `E_BAD_CASE` ("not representable") rather
/// than this file picking an answer.
enum ForayArgs {
    static func arg(_ args: [JSValue], _ index: Int) -> JSValue {
        index < args.count ? args[index] : .undefined
    }

    /// One queue item: nil when it is not a plain object (JS `isPlain`). Every
    /// field is read with the JS rule's own type test (`isNum`,
    /// `typeof s === "string"`, `=== true`), which a nil stands for.
    static func item(_ value: JSValue) -> ForayItem? {
        guard case .object = value else { return nil }
        return ForayItem(
            id: value["id"].stringValue, kind: value["kind"].stringValue, type: value["type"].stringValue,
            title: value["title"].stringValue, show: value["show"].stringValue,
            audioUrl: value["audio_url"].stringValue, startSec: value["start_sec"].numberValue,
            endSec: value["end_sec"].numberValue, authoredEndSec: value["authored_end_sec"].numberValue,
            durationSec: value["duration_sec"].numberValue, durationSource: value["duration_source"].stringValue,
            script: value["script"].stringValue, sourceItemId: value["source_item_id"].stringValue,
            itemId: value["item_id"].stringValue, daiSuspected: value["dai_suspected"] == .bool(true),
            needsDriftCheck: value["needs_drift_check"] == .bool(true),
            startAnchor: value["start_anchor"].stringValue, endAnchor: value["end_anchor"].stringValue,
            referenceDurationSec: value["reference_duration_sec"].numberValue)
    }

    /// `items ?? []` then iterated: null/undefined are no list (nil), an
    /// array is its items. Anything else makes the JS throw on iteration or
    /// read a `length` a typed list does not have: not representable.
    static func items(_ value: JSValue, _ what: String) throws -> [ForayItem?]? {
        switch value {
        case .undefined, .null: return nil
        case let .array(values): return values.map(item)
        default: throw ArgReading.notRepresentable(what, value)
        }
    }

    /// The seam census reads a null entry as "no item" (`!from`) and any
    /// other non-object through `?.`, where a truthy primitive would count as
    /// an item with no fields. Only the first has a nil spelling. And
    /// `from.source_item_id !== to.source_item_id` tells null from undefined,
    /// which one nil cannot: only a string or an absent id translates.
    static func censusItems(_ value: JSValue) throws -> [ForayItem?]? {
        guard case let .array(values) = value else { return try items(value, "seamCensus's items") }
        return try values.map { entry -> ForayItem? in
            if case .object = entry {
                let source = entry["source_item_id"]
                if source != .undefined && source.stringValue == nil {
                    throw ArgReading.notRepresentable("a census item's source_item_id", source)
                }
                return item(entry)
            }
            if entry.isTruthy { throw ArgReading.notRepresentable("a census entry", entry) }
            return nil
        }
    }

    static func encode(_ verdict: StructuralCheck.Verdict) -> JSValue {
        .object([
            "ok": .bool(verdict.ok),
            "reason": verdict.reason.map { JSValue.string($0) } ?? .null,
            "problems": .array(verdict.problems.map {
                .object(["index": .number(Double($0.index)), "code": .string($0.code)])
            })
        ])
    }

    static func encode(_ census: StructuralCheck.Census) -> JSValue {
        .object([
            "items": .number(Double(census.items)), "segments": .number(Double(census.segments)),
            "seams": .number(Double(census.seams)), "beats": .number(Double(census.beats)),
            "jingles": .number(Double(census.jingles)), "sameSource": .number(Double(census.sameSource)),
            "sourceChanges": .number(Double(census.sourceChanges))
        ])
    }

    /// A parsed JSON value as JavaScript holds it after `JSON.parse`.
    static func value(_ node: JSONNode) -> JSValue {
        switch node {
        case .null: return .null
        case let .bool(flag): return .bool(flag)
        case let .number(number): return .number(number)
        case let .string(text): return .string(text)
        case let .array(items): return .array(items.map(value))
        case let .object(members):
            var fields: [String: JSValue] = [:]
            for member in members { fields[member.key] = value(member.value) } // a repeated key: the last wins
            return .object(fields)
        }
    }
}

/// A family whose fixture files are run by different parts, chosen by the
/// FILE's module (a scenario file names none). A file naming any other module
/// is refused, as `PureFamilyRunner` refuses one.
struct ModuleRoutedRunner: FamilyRunner {
    static let scenarios = "(scenarios)"

    let family: String
    let routes: [String: FamilyRunner]

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        let key = file.module ?? ModuleRoutedRunner.scenarios
        guard let part = routes[key] else {
            throw HarnessError("E_BAD_CASE", "\(file.path) targets \(file.module ?? "no module"); the Swift \(family) runner ports "
                + routes.keys.sorted().joined(separator: ", "))
        }
        return try part.run(testCase, in: file, context: context)
    }
}

/// The committed Forays (`player/parity/forays.js`), shared by the
/// foray-clock, foray-structure and media families.
///
/// THE BUILD IS THE PAGE'S. Every function in forays.js takes the RAW authored
/// Foray (`$foray: "<id>"`) and asks a rule about the page's BUILD of it
/// (`resolveForay` -> `buildForayQueue`), which the engine never makes (plan
/// §3 A-1, §11). So the Swift side reads that build from
/// `player/parity/foray-builds.json`, which `tools/parity/foray-builds.mjs
/// --write` emits from the real JS build and `player/parity/run.test.js`
/// checks: every committed case's Foray has a build there, and every build
/// there passes the same authored rules in JS. The rule under test is then
/// the Swift port's, over exactly the items `playForay` would carry.
struct ForaysModuleRunner: FamilyRunner {
    static let module = "player/parity/forays.js"
    static let buildsFile = "player/parity/foray-builds.json"

    let family: String

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard file.module == ForaysModuleRunner.module else {
            throw HarnessError("E_BAD_CASE", "\(file.path) targets \(file.module ?? "no module"); this part ports \(ForaysModuleRunner.module)")
        }
        guard testCase.kind == .call, let name = testCase.call else {
            throw HarnessError("E_BAD_CASE", "\(ForaysModuleRunner.module) cases are calls")
        }
        let args = try testCase.args.map { try Codec.expandInputs($0, context) }
        let result: JSValue
        switch name {
        case "committedForays":
            result = .object(["atLeastTwo": .bool(try ForayBuilds.committedCount(context) >= 2)])
        case "frozenCensus":
            guard let id = ForayArgs.arg(args, 0).stringValue else {
                throw HarnessError("E_BAD_CASE", "frozenCensus takes a Foray id")
            }
            guard let items = try ForayBuilds.table(context).frozen[id] else {
                throw HarnessError("E_BAD_CASE", "\(id) has no frozen build in \(ForaysModuleRunner.buildsFile); run node tools/parity/foray-builds.mjs --write")
            }
            result = ForayArgs.encode(StructuralCheck.seamCensus(try ForayArgs.censusItems(.array(items))))
        default:
            guard let built = try ForayBuilds.build(ForayArgs.arg(args, 0), context) else {
                // `build()` throws a TypeError for anything but {id, title, items[]}.
                return .object(["throws": .object(["name": .string("TypeError")])])
            }
            switch name {
            case "clockAudit": result = ForayBuilds.clockAudit(built)
            case "structureOf": result = ForayArgs.encode(StructuralCheck.check(built.playable.map(ForayArgs.item)))
            case "appAsArtist": result = .number(Double(ForayBuilds.appAsArtist(built)))
            case "lockScreenAudit": result = ForayBuilds.lockScreenAudit(built)
            case "lockScreenClock": result = ForayBuilds.lockScreenClock(built)
            default:
                throw HarnessError("E_UNKNOWN_EXPORT", "\(ForaysModuleRunner.module) has no Swift port of export \"\(name)\"")
            }
        }
        return .object(["return": Codec.encode(result)])
    }
}

/// forays.js's functions, over the page's build.
enum ForayBuilds {
    /// `resolveForay(foray)`'s parts these rules read.
    struct Built {
        /// The raw authored document.
        let foray: JSValue
        /// `r.title`: the document's title (`foray?.title ?? ""`).
        let title: String
        /// `r.playable`: the built queue.
        let playable: [JSValue]
        var items: [ForayItem?] { playable.map(ForayArgs.item) }
        /// `r.totalSec`: `forayRuntimeSec(r.playable)`.
        var totalSec: Double { ForayClock.forayRuntimeSec(items) }
    }

    struct Table {
        let data: [String: [JSValue]]
        let frozen: [String: [JSValue]]
    }

    private static let lock = NSLock()
    private static var cache: [String: Table] = [:]

    /// The build table, read once per repo root.
    static func table(_ context: Codec.Context) throws -> Table {
        guard let root = context.repoRoot else {
            throw HarnessError("E_BAD_CASE", "the committed Forays need the repo root, and this run has none")
        }
        lock.lock()
        defer { lock.unlock() }
        if let hit = cache[root.path] { return hit }
        let url = root.appendingPathComponent(ForaysModuleRunner.buildsFile)
        let doc: JSONValue
        do {
            doc = try JSONValue.parse(try Data(contentsOf: url))
        } catch {
            throw HarnessError("E_BAD_CASE", "cannot read \(ForaysModuleRunner.buildsFile): \(error)")
        }
        func section(_ key: String) -> [String: [JSValue]] {
            (doc[key]?.objectValue ?? [:]).mapValues { ($0.arrayValue ?? []).map(JSValue.init(raw:)) }
        }
        let table = Table(data: section("data"), frozen: section("frozen"))
        cache[root.path] = table
        return table
    }

    /// `build(foray)`: nil where forays.js throws its TypeError (not
    /// `{id, title, items[]}`); a Foray with no build in the table cannot run.
    static func build(_ foray: JSValue, _ context: Codec.Context) throws -> Built? {
        guard case .object = foray, case .array = foray["items"] else { return nil }
        guard let id = foray["id"].stringValue else {
            throw ArgReading.notRepresentable("a Foray's id", foray["id"])
        }
        guard let playable = try table(context).data[id] else {
            throw HarnessError("E_BAD_CASE", "\(id) has no build in \(ForaysModuleRunner.buildsFile); run node tools/parity/foray-builds.mjs --write")
        }
        let title: String
        switch foray["title"] {
        case .undefined, .null: title = ""
        case let .string(text): title = text
        default: throw ArgReading.notRepresentable("a Foray's title", foray["title"])
        }
        return Built(foray: foray, title: title, playable: playable)
    }

    /// `committedForays()`'s count: data/forays.json's Forays.
    static func committedCount(_ context: Codec.Context) throws -> Int {
        guard let root = context.repoRoot else {
            throw HarnessError("E_BAD_CASE", "committedForays needs the repo root, and this run has none")
        }
        let doc = try JSONValue.parse(try Data(contentsOf: root.appendingPathComponent("data/forays.json")))
        return doc["forays"]?.arrayValue?.count ?? 0
    }

    /// `rows(r)`: the lock-screen metadata of every playable item, and the
    /// credit of every item that is not a segment.
    static func rows(_ r: Built) -> [(item: JSValue, meta: MediaMapping.Metadata, credit: String?)] {
        let total = Double(r.playable.count)
        return r.playable.enumerated().map { index, item in
            let next = index + 1 < r.playable.count ? MediaEpisodeFamily.item(r.playable[index + 1]) : nil
            let meta = MediaMapping.metadata(item: MediaEpisodeFamily.item(item), nextItem: next, forayTitle: r.title,
                                             index: Double(index), total: total)
            let credit = item["kind"] == .string(EngineConstants.QueueState.episode)
                ? nil : MediaMapping.narrationCredit(forayTitle: r.title, nextItem: next)
            return (item, meta, credit)
        }
    }

    /// `appAsArtist(foray)`: how many playable items the lock screen credits
    /// to the app. 0 is the rule (L-06 / F15).
    static func appAsArtist(_ r: Built) -> Int {
        rows(r).filter { $0.meta.artist == MediaMapping.appName || $0.credit == MediaMapping.appName }.count
    }

    /// `lockScreenAudit(foray)`: violation counts, 0 each.
    static func lockScreenAudit(_ r: Built) -> JSValue {
        let list = rows(r)
        func key(_ meta: MediaMapping.Metadata) -> String { "\(meta.title)|\(meta.artist)|\(meta.album)" }
        var frozen = 0
        if list.count > 1 {
            for i in 1..<list.count where key(list[i].meta) == key(list[i - 1].meta) { frozen += 1 }
        }
        let episode = JSValue.string(EngineConstants.QueueState.episode)
        func count(_ test: ((item: JSValue, meta: MediaMapping.Metadata, credit: String?)) -> Bool) -> JSValue {
            .number(Double(list.filter(test).count))
        }
        return .object([
            "blankTitle": count { $0.meta.title.utf16.isEmpty },
            "blankArtist": count { $0.meta.artist.utf16.isEmpty },
            "albumMissingForay": count { !contains($0.meta.album, r.title) },
            "frozenDisplays": .number(Double(frozen)),
            // `meta.artist !== item.show`: an absent or non-string show never equals a string.
            "segmentNotShow": count { $0.item["kind"] == episode && $0.item["show"] != .string($0.meta.artist) },
            "narrationArtwork": count { row in
                row.item["kind"] != episode
                    && (row.meta.artwork.count != 1 || row.meta.artwork[0].src != MediaMapping.appArtworkUrl)
            }
        ])
    }

    /// `lockScreenClock(foray)`: at the first tape item from the midpoint on,
    /// halfway through the Foray, the lock screen reports the FORAY's clock.
    static func lockScreenClock(_ r: Built) -> JSValue {
        let mid = r.playable.count / 2
        func span(_ item: JSValue) -> Double { item["end_sec"].toNumber - item["start_sec"].toNumber }
        guard let index = r.playable.indices.first(where: { $0 >= mid && span(r.playable[$0]).isFinite }) else {
            return .object(["tapeItemFound": .bool(false), "durationIsForayTotal": .bool(false),
                            "durationIsNotSegment": .bool(false), "positionIsForayClock": .bool(false)])
        }
        let item = r.playable[index]
        let total = r.totalSec
        let position = (total / 2).rounded(.down)
        let view = MediaMapping.sessionView(MediaMapping.View(
            item: MediaEpisodeFamily.item(item), forayTitle: r.title, index: Double(index),
            total: Double(r.playable.count), durationSec: total, positionSec: position, playing: true))
        let duration = view.positionState?.duration
        return .object([
            "tapeItemFound": .bool(true),
            "durationIsForayTotal": .bool(duration == total),
            "durationIsNotSegment": .bool(duration != span(item)),
            "positionIsForayClock": .bool(view.positionState?.position == position)
        ])
    }

    /// `clockAudit(foray)`: the Foray clock's four invariants, all true.
    static func clockAudit(_ r: Built) -> JSValue {
        let items = r.items
        let starts = ForayClock.segmentStarts(items)
        let total = ForayClock.forayRuntimeSec(items)
        var acc = 0.0
        var cumulative = true
        var mapsBack = true
        var roundTrips = true
        for (i, item) in items.enumerated() {
            let length = ForayClock.itemRuntimeSec(item)
            if Swift.abs(starts[i] - acc) > 1e-9 { cumulative = false }
            acc += length
            if length > 0 && ForayClock.segmentAtElapsed(items, elapsed: starts[i])?.index != i { mapsBack = false }
            let into = JSMath.min(1, length)
            let base = item?.startSec.flatMap { $0.isFinite ? $0 : nil } ?? 0
            if Swift.abs(ForayClock.forayElapsed(items, index: Double(i), playheadSec: base + into) - (starts[i] + into)) > 1e-9 {
                roundTrips = false
            }
        }
        let stated: Bool
        if case let .number(runtime) = r.foray["runtime_sec"] {
            stated = Swift.abs(runtime - total) <= 0.5
        } else {
            stated = true
        }
        return .object([
            "statedRuntimeHolds": .bool(stated),
            "startsAreCumulative": .bool(cumulative && Swift.abs(acc - total) <= 1e-9),
            "everyStartMapsBack": .bool(mapsBack),
            "elapsedRoundTrips": .bool(roundTrips)
        ])
    }

    /// `String.prototype.includes`, code unit by code unit.
    static func contains(_ text: String, _ part: String) -> Bool {
        let (t, p) = (Array(text.utf16), Array(part.utf16))
        if p.isEmpty { return true }
        guard p.count <= t.count else { return false }
        for start in 0...(t.count - p.count) where Array(t[start..<(start + p.count)]) == p { return true }
        return false
    }
}

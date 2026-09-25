import Foundation

/* The shared rows (docs/native-engine-plan.md §4.6, card NE-10s): the three
 * `CapacitorStorage.` rows the native engine and the page BOTH write, and the
 * engine-private restore record beside them.
 *
 *   cp_pos:<id>       player/position-store.js  positionRow + makePositionRecord
 *   cp_foray:<id>     player/foray-progress.js  ForayProgressStore.save + makeProgress
 *   cp_last_episode   player/episode-progress.js makeLastEpisode (+ updated_at)
 *
 * "Positions survive switching engines" (plan §4.6) only if a row the engine
 * wrote is, byte for byte, the row the page would have written: the page reads
 * it back with its own parser, DurableStore's `isNewer` orders it against the
 * page's copy by its `updated_at`, and the page may re-save it unchanged. So
 * every builder here is its JS function, line for line, in the same field
 * order, printed through `JSWriter`; the `rows` parity family (recorded from
 * the real JS writers, NE-10j) runs each one against the recorded bytes.
 *
 * THE RULE, as for every port: JS is the reference. A change to a row is a JS
 * change, a re-record (which puts the ids in swift-pending.json), then this
 * file. Nothing here may decide something the JS does not.
 *
 * The time a row is stamped with is the caller's (`updatedAt`, from
 * `Rows.timestamp(epochMs:)`), exactly as the JS writers take theirs from an
 * injected or wall clock: the core never reads a clock. */

/// One write to storage: the key and the exact string `setItem` receives.
public struct StoredRow: Equatable {
    public let key: String
    public let value: String

    public init(key: String, value: String) {
        self.key = key
        self.value = value
    }
}

public enum Rows {
    // MARK: keys

    /// The rows the engine owns on iOS (`player/engine-contract.js`
    /// OWNED_PREFIXES, generated into EngineConstants): EngineStore (NE-19)
    /// writes exactly these, and DurableStore defers them (NE-23).
    public static let ownedPrefixes: [String] = EngineConstants.EngineContract.ownedPrefixes

    /// `positionKey(id)`: position-store.js exports the function, not the
    /// prefix, so the prefix is spelled once here and pinned by every recorded
    /// cp_pos case's key (and by `ownedPrefixes` containing it, in RowsTests).
    public static let positionPrefix = "cp_pos:"

    public static func positionKey(_ id: String) -> String { positionPrefix + id }

    /// `progressKey(forayId)`.
    public static func forayKey(_ forayId: String) -> String {
        EngineConstants.ForayProgress.keyPrefix + forayId
    }

    /// episode-progress.js `KEY`.
    public static let lastEpisodeKey: String = EngineConstants.EpisodeProgress.key

    /// The `updated_at` every row carries: `new Date(epochMs).toISOString()`.
    /// Nil where JavaScript would throw (a time a Date cannot hold).
    public static func timestamp(epochMs: Double) -> String? {
        JSWriter.isoString(epochMs: epochMs)
    }

    // MARK: cp_pos:<id>

    /// `PositionStore.save(id, seconds, {duration})`'s write, or nil where it
    /// writes nothing.
    ///
    /// positionRow's gate: `!id || typeof seconds !== "number" ||
    /// !Number.isFinite(seconds) || seconds < 0` refuses. `seconds` is nil for
    /// "not a number" (the `typeof` check). Then makePositionRecord's four
    /// fields in its order; a duration that is not a finite number is `null`.
    /// `-0` passes the gate (`-0 < 0` is false) and prints as `0`.
    public static func position(id: String, seconds: Double?, duration: Double?,
                                updatedAt: String) -> StoredRow? {
        guard !id.isEmpty, let seconds, seconds.isFinite, seconds >= 0 else { return nil }
        let row: JSONNode = .object([
            JSONMember("seconds", .number(seconds)),
            JSONMember("duration", finiteOrNull(duration)),
            JSONMember("updated_at", .string(updatedAt)),
            JSONMember("source", .string("local"))
        ])
        return StoredRow(key: positionKey(id), value: JSWriter.stringify(row))
    }

    /// A `cp_pos` row as `PositionStore.load` accepts it.
    public struct PositionRecord: Equatable {
        public let seconds: Double
        /// Nil when the row's duration is not a number (the writer stores `null`).
        public let duration: Double?
        public let updatedAt: String?

        public init(seconds: Double, duration: Double?, updatedAt: String?) {
            self.seconds = seconds
            self.duration = duration
            self.updatedAt = updatedAt
        }
    }

    /// `PositionStore.load`: nothing for an empty value or one that does not
    /// parse, and a row whose `seconds` is not a finite number is no row.
    public static func readPosition(_ raw: String?) -> PositionRecord? {
        guard let raw, !raw.isEmpty, let row = try? JSONNode.parse(raw),
              let seconds = row["seconds"]?.numberValue, seconds.isFinite else { return nil }
        return PositionRecord(seconds: seconds, duration: row["duration"]?.numberValue,
                              updatedAt: row["updated_at"]?.stringValue)
    }

    // MARK: cp_foray:<id>

    /// What `ForayProgressStore.save(p)` is handed, typed. Every field is nil
    /// where the JS value is absent OR of the wrong type: each JS default
    /// (`title = ""`, `index = -1`, `segmentId = null`, `intoSec = 0`) and
    /// each type check (`nonEmpty`, `Number.isInteger`, `isNum`) lands on the
    /// same answer for both, so one nil carries both.
    public struct ForayProgressInput: Equatable {
        public var forayId: String?
        public var title: String?
        public var elapsedSec: Double?
        public var totalSec: Double?
        public var index: Double?
        public var segmentId: String?
        public var intoSec: Double?

        public init(forayId: String?, title: String? = nil, elapsedSec: Double?, totalSec: Double?,
                    index: Double? = nil, segmentId: String? = nil, intoSec: Double? = nil) {
            self.forayId = forayId
            self.title = title
            self.elapsedSec = elapsedSec
            self.totalSec = totalSec
            self.index = index
            self.segmentId = segmentId
            self.intoSec = intoSec
        }
    }

    /// `ForayProgressStore.save({...p, force: true})`'s write, or nil where it
    /// writes nothing. The 5-second throttle is foray-progress's rule, not the
    /// row's (NE-29j); the engine's cadence decides WHEN, this decides WHAT.
    ///
    /// save's gate: a blank `forayId`, a non-finite `elapsedSec`, or a
    /// `totalSec` that is not a finite number above 0 refuses. writeProgress
    /// then re-checks `isProgressRecord`, which after makeProgress's clamps
    /// cannot refuse anything this gate let through.
    public static func forayProgress(_ p: ForayProgressInput, updatedAt: String) -> StoredRow? {
        guard let forayId = p.forayId, nonEmpty(forayId),
              let elapsed = p.elapsedSec, elapsed.isFinite,
              let total = p.totalSec, total.isFinite, total > 0 else { return nil }
        return StoredRow(key: forayKey(forayId), value: JSWriter.stringify(makeForayProgress(p, updatedAt: updatedAt)))
    }

    /// `makeProgress(p)`: the stored shape, with NO gate (NE-29s; the gate is
    /// `forayProgress`'s, which is `save`'s). Every clamp is makeProgress's:
    /// a blank title is "", a clock that is not a finite number above 0 is 0,
    /// an index that is not a non-negative integer is -1, a blank segment id
    /// is null (not absent: the row round-trips through JSON), an offset that
    /// is not a finite number above 0 is 0. A nil `forayId` is the JS
    /// `undefined`, which the row then does not carry.
    public static func makeForayProgress(_ p: ForayProgressInput, updatedAt: String) -> JSONNode {
        let index: Double
        if let value = p.index, value.isFinite, value.rounded(.towardZero) == value, value >= 0 {
            index = value // Number.isInteger(index) && index >= 0 (-0 included; it prints 0)
        } else {
            index = -1
        }
        let title = p.title.flatMap { nonEmpty($0) ? $0 : nil } ?? ""
        let segment: JSONNode
        if let id = p.segmentId, nonEmpty(id) {
            segment = .string(id)
        } else {
            segment = .null // null, not absent: the row round-trips through JSON (makeProgress)
        }
        let into = p.intoSec.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0
        var members: [JSONMember] = []
        if let forayId = p.forayId { members.append(JSONMember("foray_id", .string(forayId))) }
        members += [
            JSONMember("title", .string(title)),
            JSONMember("elapsed_sec", .number(clampNum(p.elapsedSec ?? .nan))),
            JSONMember("total_sec", .number(clampNum(p.totalSec ?? .nan))),
            JSONMember("index", .number(index)),
            JSONMember("segment_id", segment),
            JSONMember("into_sec", .number(into)),
            JSONMember("updated_at", .string(updatedAt))
        ]
        return .object(members)
    }

    /// A `cp_foray` row as `readProgress` accepts it (`isProgressRecord`).
    public struct ForayProgressRecord: Equatable {
        public let forayId: String
        public let title: String?
        public let elapsedSec: Double
        public let totalSec: Double
        public let index: Double?
        public let segmentId: String?
        public let intoSec: Double?
        public let updatedAt: String?
    }

    /// `readProgress`: a row names a Foray and carries a finite clock, or it
    /// is no row. `segment_id` and `into_sec` are NOT required, because rows
    /// written before they existed are still resume points (foray-progress.js).
    public static func readForayProgress(_ raw: String?) -> ForayProgressRecord? {
        guard let raw, !raw.isEmpty, let row = try? JSONNode.parse(raw), row.members != nil,
              let forayId = row["foray_id"]?.stringValue, nonEmpty(forayId),
              let elapsed = row["elapsed_sec"]?.numberValue, elapsed.isFinite, elapsed >= 0,
              let total = row["total_sec"]?.numberValue, total.isFinite, total > 0 else { return nil }
        return ForayProgressRecord(forayId: forayId, title: row["title"]?.stringValue, elapsedSec: elapsed,
                                   totalSec: total, index: row["index"]?.numberValue,
                                   segmentId: row["segment_id"]?.stringValue,
                                   intoSec: row["into_sec"]?.numberValue,
                                   updatedAt: row["updated_at"]?.stringValue)
    }

    // MARK: cp_last_episode

    /// episode-progress.js `SNAPSHOT_FIELDS`, in its order: the row's order.
    /// Not exported by the module (it is a private const), so it is spelled
    /// here and pinned by `rows/cp-last-episode-snapshot-order-and-extras-dropped`,
    /// whose item lists every field in a different order plus fields that must drop.
    public static let lastEpisodeSnapshotFields = [
        "id", "title", "show", "artwork_url", "audio_url", "duration_min", "duration_sec"
    ]

    /// `writeLastEpisode(storage, makeLastEpisode(item))`, as client.js pairs
    /// them: nil for no item or an item with a falsy id (a null pointer would
    /// CLEAR the row, and playing an id-less item must not).
    ///
    /// On iOS the page sends `makeLastEpisode(item)` minus `updated_at` as
    /// playEpisode's `lastEpisodeRow`, and the engine stores it "verbatim plus
    /// updated_at" (plan §5.2). Running the page's row back through the same
    /// rule IS verbatim, because the rule is idempotent: it keeps the snapshot
    /// fields in their order and appends the stamp. It also restores the order
    /// the bridge loses: a Capacitor `JSObject` is a dictionary, so the fields
    /// arrive unordered and leave in SNAPSHOT_FIELDS order.
    ///
    /// A field is kept unless it is absent or null (`!== undefined && !==
    /// null`): `""` and `0` stay. Its value is written as given, whatever its type.
    public static func lastEpisode(_ item: JSONNode, updatedAt: String) -> StoredRow? {
        guard item.isTruthy, let id = item["id"], id.isTruthy else { return nil }
        var members: [JSONMember] = []
        for field in lastEpisodeSnapshotFields {
            if let value = item[field], value != .null { members.append(JSONMember(field, value)) }
        }
        members.append(JSONMember("updated_at", .string(updatedAt)))
        return StoredRow(key: lastEpisodeKey, value: JSWriter.stringify(.object(members)))
    }

    /// `readLastEpisode`: an object with a truthy `id`, or nothing.
    public static func readLastEpisode(_ raw: String?) -> JSONNode? {
        guard let raw, !raw.isEmpty, let row = try? JSONNode.parse(raw), row.members != nil,
              row["id"]?.isTruthy == true else { return nil }
        return row
    }

    // MARK: ordering (durable-store.js isNewer)

    /// durable-store.js `stampOf`: the first of `updated_at`, `updatedAt`,
    /// `ts` that `Date.parse` reads, in epoch ms; nil for a value that does
    /// not parse or carries none of them. Only a STRING field is read as a
    /// stamp: every shared row's writer stamps with `toISOString`, and
    /// `Date.parse` of a number's text is V8's lenient fallback (JSDate.parse).
    public static func stamp(of raw: String) -> Double? {
        guard let row = try? JSONNode.parse(raw), row.members != nil else { return nil }
        for field in ["updated_at", "updatedAt", "ts"] {
            if let text = row[field]?.stringValue, let time = JSDate.parse(text) { return time }
        }
        return nil
    }

    /// durable-store.js `isNewer(candidate, mine)`: true only when both carry
    /// a stamp and the candidate's is strictly later. Hydration adopts the
    /// newer copy of a row, so an engine-written row must order against the
    /// page's by its `updated_at` exactly as two page rows do.
    public static func isNewer(_ candidate: String, than mine: String) -> Bool {
        guard let a = stamp(of: candidate), let b = stamp(of: mine) else { return false }
        return a > b
    }

    // MARK: the JS helpers the builders share

    /// foray-progress.js `nonEmpty`: a string with something left after
    /// `String.prototype.trim`.
    public static func nonEmpty(_ text: String) -> Bool {
        text.unicodeScalars.contains { !isJSWhitespace($0) }
    }

    /// What `trim` strips: ECMAScript WhiteSpace (TAB, VT, FF, SP, NBSP,
    /// ZWNBSP and every Zs character) and LineTerminator (LF, CR, LS, PS).
    /// The Zs set is spelled out rather than read from the Unicode tables, so
    /// it cannot move with a toolchain's Unicode version while V8's does not.
    static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A,
             0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// makePositionRecord's `typeof duration === "number" &&
    /// Number.isFinite(duration) ? duration : null`.
    static func finiteOrNull(_ value: Double?) -> JSONNode {
        guard let value, value.isFinite else { return .null }
        return .number(value)
    }

    /// foray-progress.js `clampNum`: a finite number above 0, else 0.
    static func clampNum(_ value: Double) -> Double {
        value.isFinite && value > 0 ? value : 0
    }
}

// MARK: - The engine-private restore record

/// What the engine needs to paint Now Playing and answer a car's play after
/// iOS terminated the app (plan §4.5, the cold path, NE-24):
/// `{v, mode, queue[], index, offsetSec, forayId?, rate, voiceId?, advanceLog,
/// pendingEvents, updated_at, build}` in UserDefaults `ForayEngine.restore`,
/// OUTSIDE `CapacitorStorage.` so DurableStore never sees it (§4.6).
///
/// It is not a shared row and the page never parses it, so no JS writer
/// defines its bytes; it is still written through `JSWriter` so one
/// serialiser, with one number format, writes everything the engine stores.
///
/// `queue`, `advanceLog` and `pendingEvents` are kept as the JSON they arrived
/// as: queue items and continuation hops are the page's objects (a hop carries
/// its `lastEpisodeRow`, §5.2), and a pending event is the
/// `{kind:"position", episode_id, seconds, duration, at}` the page drains
/// through `logEvent` with its original timestamp (§5.5). Their typed readers
/// belong to the cards that act on them (NE-14s, NE-24).
public struct RestoreRecord: Equatable {
    public static let version: Double = 1

    public enum Mode: String, CaseIterable {
        case episode
        case foray
        /// Written at a one-way relinquish (§4.6 step 6): a cold play then
        /// finds no actionable item, and the legacy lane owns playback.
        case relinquished
    }

    public var mode: Mode
    public var queue: [JSONNode]
    public var index: Int
    public var offsetSec: Double
    public var forayId: String?
    public var rate: Double
    public var voiceId: String?
    public var advanceLog: [JSONNode]
    public var pendingEvents: [JSONNode]
    public var updatedAt: String
    /// CFBundleVersion of the build that wrote it.
    public var build: String

    public init(mode: Mode, queue: [JSONNode], index: Int, offsetSec: Double, forayId: String? = nil,
                rate: Double, voiceId: String? = nil, advanceLog: [JSONNode] = [], pendingEvents: [JSONNode] = [],
                updatedAt: String, build: String) {
        self.mode = mode
        self.queue = queue
        self.index = index
        self.offsetSec = offsetSec
        self.forayId = forayId
        self.rate = rate
        self.voiceId = voiceId
        self.advanceLog = advanceLog
        self.pendingEvents = pendingEvents
        self.updatedAt = updatedAt
        self.build = build
    }

    /// The `{mode: "relinquished"}` record: nothing to restore, by design.
    public static func relinquished(updatedAt: String, build: String) -> RestoreRecord {
        RestoreRecord(mode: .relinquished, queue: [], index: 0, offsetSec: 0, rate: 1,
                      updatedAt: updatedAt, build: build)
    }

    /// The stored string. A relinquished record carries only `v`, `mode`,
    /// `updated_at` and `build`: there is no queue to keep, and a record that
    /// kept one would invite a later build to restore it.
    public func serialized() -> String {
        var members: [JSONMember] = [
            JSONMember("v", .number(RestoreRecord.version)),
            JSONMember("mode", .string(mode.rawValue))
        ]
        if mode != .relinquished {
            members.append(JSONMember("queue", .array(queue)))
            members.append(JSONMember("index", .number(Double(index))))
            members.append(JSONMember("offsetSec", .number(offsetSec)))
            if let forayId { members.append(JSONMember("forayId", .string(forayId))) }
            members.append(JSONMember("rate", .number(rate)))
            if let voiceId { members.append(JSONMember("voiceId", .string(voiceId))) }
            members.append(JSONMember("advanceLog", .array(advanceLog)))
            members.append(JSONMember("pendingEvents", .array(pendingEvents)))
        }
        members.append(JSONMember("updated_at", .string(updatedAt)))
        members.append(JSONMember("build", .string(build)))
        return JSWriter.stringify(.object(members))
    }

    /// Read a stored record back, or nil. A record this build cannot trust is
    /// NO record, never a guess: another version, an unknown mode, a missing
    /// stamp or build, or a queue whose index or offset makes no sense. The
    /// cold path then answers `.noActionableNowPlayingItem` (§4.5) and the
    /// page's own shared rows still restore the listener when it next opens.
    public static func parse(_ raw: String?) -> RestoreRecord? {
        guard let raw, let row = try? JSONNode.parse(raw), row.members != nil,
              row["v"]?.numberValue == version,
              let modeText = row["mode"]?.stringValue, let mode = Mode(rawValue: modeText),
              let updatedAt = row["updated_at"]?.stringValue,
              let build = row["build"]?.stringValue else { return nil }
        if mode == .relinquished { return .relinquished(updatedAt: updatedAt, build: build) }
        guard let queue = row["queue"]?.arrayValue,
              let indexValue = row["index"]?.numberValue, indexValue.isFinite,
              indexValue.rounded(.towardZero) == indexValue, indexValue >= 0,
              queue.isEmpty ? indexValue == 0 : indexValue < Double(queue.count),
              let offset = row["offsetSec"]?.numberValue, offset.isFinite, offset >= 0,
              let rate = row["rate"]?.numberValue, rate.isFinite, rate > 0,
              let advanceLog = row["advanceLog"]?.arrayValue,
              let pendingEvents = row["pendingEvents"]?.arrayValue else { return nil }
        let forayId = row["forayId"]?.stringValue
        if mode == .foray && forayId == nil { return nil }
        return RestoreRecord(mode: mode, queue: queue, index: Int(indexValue), offsetSec: offset,
                             forayId: forayId, rate: rate, voiceId: row["voiceId"]?.stringValue,
                             advanceLog: advanceLog, pendingEvents: pendingEvents,
                             updatedAt: updatedAt, build: build)
    }
}

import Foundation

/* Decoding the contract (docs/native-engine-plan.md §5.1-§5.4, card NE-11s).
 *
 * Every payload that crosses the engineHello / engineSend / engineRead bridge
 * and the "engine" event, decoded into a typed value or REFUSED. The rule for
 * accepting one is the page's: `player/parity/schema/engine-contract.schema.json`
 * (generated from engine-contract.js), whose every valid and invalid example is
 * one case of the `contract` or `snapshot` parity family. So an engineSend the
 * page believes it may send is one the engine decodes, and a snapshot the
 * engine sends is one the page believes (NE-20 builds on both).
 *
 * WHY NOT Codable. The bridge's values reach the engine as JSONNode (JSWriter's
 * JSON.parse semantics), and the schema needs three things JSONDecoder does
 * not give on every platform the core targets: a REQUIRED key that may be
 * null (`durationSec`, `voiceId`) told apart from a missing one; `1` refused as
 * a Bool and `true` as a number identically on Darwin and on Linux (the
 * engine-parity job runs swift:5.10 on Linux, whose Foundation reads JSON
 * numbers through NSNumber differently); and conditional requirements (a
 * `native` hello must carry a snapshot, a refusal must carry a reason). One
 * small reader below does all three and says where a payload failed.
 *
 * THE SCHEMA'S RULES, AS READ HERE:
 *   - unknown KEYS are allowed everywhere (an added field is not a protocol
 *     change); unknown VALUES in a closed set are refused
 *   - `integer` is a finite whole number (Number.isInteger); it is read into
 *     an Int, so a whole number beyond Int's range (about 9.2e18, which no
 *     sender writes: every such field is a count, a sequence or an index) is
 *     refused where the page would accept it
 *   - `number` is finite; `nonNegative` is >= 0 (so -0 passes, as in JS)
 *   - a string's `minLength: 1` is "not empty"
 *   - a key that is absent is not checked; a key that is present is checked,
 *     required or not (a `snapshot` inside a legacy hello must still be one)
 */

/// Why a payload was refused: where (a JSON-pointer-ish path, "" for the
/// payload itself) and what rule it broke. For a diagnostics row; parity
/// compares only accept / refuse, because the page words its errors its own way.
public struct ContractError: Error, Equatable, CustomStringConvertible {
    public let path: String
    public let reason: String

    public init(path: String, reason: String) {
        self.path = path
        self.reason = reason
    }

    public var description: String { "\(path.isEmpty ? "(payload)" : path): \(reason)" }
}

/// The schema's leaf rules: each reads one value at `path` or throws.
enum ContractRead {
    typealias Reader<T> = (JSONNode, String) throws -> T

    static func fail(_ path: String, _ reason: String) -> ContractError {
        ContractError(path: path, reason: reason)
    }

    static func string(_ node: JSONNode, _ path: String) throws -> String {
        guard case let .string(text) = node else { throw fail(path, "must be a string") }
        return text
    }

    static func nonEmptyString(_ node: JSONNode, _ path: String) throws -> String {
        let text = try string(node, path)
        guard !text.isEmpty else { throw fail(path, "must not be empty") }
        return text
    }

    static func bool(_ node: JSONNode, _ path: String) throws -> Bool {
        guard case let .bool(flag) = node else { throw fail(path, "must be a boolean") }
        return flag
    }

    /// `type: number`: JSON has no NaN or Infinity, so a value that cannot be
    /// written to the wire cannot have come from it.
    static func number(_ node: JSONNode, _ path: String) throws -> Double {
        guard case let .number(value) = node, value.isFinite else { throw fail(path, "must be a finite number") }
        return value
    }

    static func nonNegative(_ node: JSONNode, _ path: String) throws -> Double {
        let value = try number(node, path)
        guard !(value < 0) else { throw fail(path, "must be >= 0") }
        return value
    }

    /// `exclusiveMinimum: 0`.
    static func positive(_ node: JSONNode, _ path: String) throws -> Double {
        let value = try number(node, path)
        guard value > 0 else { throw fail(path, "must be > 0") }
        return value
    }

    /// `type: integer, minimum: <min>`.
    static func integer(atLeast min: Int) -> Reader<Int> {
        { node, path in
            let value = try ContractRead.number(node, path)
            guard value.rounded(.towardZero) == value else { throw ContractRead.fail(path, "must be a whole number") }
            guard let whole = Int(exactly: value) else { throw ContractRead.fail(path, "is beyond the engine's integer range") }
            guard whole >= min else { throw ContractRead.fail(path, "must be >= \(min)") }
            return whole
        }
    }

    static let nonNegativeInt: Reader<Int> = integer(atLeast: 0)

    /// `enum: [...]` over strings: a closed set of values.
    static func token<T: RawRepresentable>(_ type: T.Type) -> Reader<T> where T.RawValue == String {
        { node, path in
            guard case let .string(text) = node, let value = T(rawValue: text) else {
                throw ContractRead.fail(path, "\(node) is not one of the closed set")
            }
            return value
        }
    }

    /// `pattern: ^(forever|none|until:[1-9][0-9]{0,5})$`.
    static func holdPolicy(_ node: JSONNode, _ path: String) throws -> SessionPolicy.HoldPolicy {
        let text = try string(node, path)
        guard let policy = SessionPolicy.HoldPolicy(text) else {
            throw ContractRead.fail(path, "is not forever, none or until:<minutes>")
        }
        return policy
    }

    /// `type: object`, whatever it holds.
    static func object(_ node: JSONNode, _ path: String) throws -> JSONNode {
        guard case .object = node else { throw ContractRead.fail(path, "must be an object") }
        return node
    }

    /// `type: array` with `items` (and `minItems`).
    static func array<T>(of item: @escaping Reader<T>, minItems: Int = 0) -> Reader<[T]> {
        { node, path in
            guard case let .array(elements) = node else { throw ContractRead.fail(path, "must be an array") }
            guard elements.count >= minItems else { throw ContractRead.fail(path, "needs at least \(minItems) item(s)") }
            return try elements.enumerated().map { try item($0.element, "\(path)/\($0.offset)") }
        }
    }

    /// `type: [<t>, "null"]`: the value, or nil for null.
    static func nullable<T>(_ read: @escaping Reader<T>) -> Reader<T?> {
        { (node: JSONNode, path: String) throws -> T? in
            if node == .null { return nil }
            return try read(node, path)
        }
    }
}

/// One JSON object's members, read by the schema's `required` / `properties`.
struct ContractObject {
    let node: JSONNode
    let path: String

    init(_ node: JSONNode, at path: String = "") throws {
        guard case .object = node else { throw ContractRead.fail(path, "must be an object") }
        self.node = node
        self.path = path
    }

    func has(_ key: String) -> Bool { node[key] != nil }

    func required<T>(_ key: String, _ read: ContractRead.Reader<T>) throws -> T {
        guard let value = node[key] else { throw ContractRead.fail(path, "missing \(key)") }
        return try read(value, "\(path)/\(key)")
    }

    /// Absent is nil; present is checked.
    func optional<T>(_ key: String, _ read: ContractRead.Reader<T>) throws -> T? {
        guard let value = node[key] else { return nil }
        return try read(value, "\(path)/\(key)")
    }

    /// Present and possibly null (`required` + a nullable type).
    func requiredNullable<T>(_ key: String, _ read: @escaping ContractRead.Reader<T>) throws -> T? {
        try required(key, ContractRead.nullable(read))
    }

    /// Absent or null is nil; anything else is checked.
    func optionalNullable<T>(_ key: String, _ read: @escaping ContractRead.Reader<T>) throws -> T? {
        try optional(key, ContractRead.nullable(read)) ?? nil
    }

    /// A nested object, read at its own path.
    func nested(_ key: String) throws -> ContractObject {
        try required(key) { node, path in try ContractObject(node, at: path) }
    }
}

extension EngineContract {
    // MARK: - Helpers of the schema ($defs that are not payloads)

    /// `$defs.item`: a queue item. Only `id` is the contract's; the rest of
    /// the item (audio_url, bounds, kind, ...) is kept as sent, for the rules
    /// that read it.
    public struct Item: Equatable {
        public let id: String
        public let node: JSONNode

        init(contract node: JSONNode, at path: String) throws {
            let o = try ContractObject(node, at: path)
            id = try o.required("id", ContractRead.nonEmptyString)
            self.node = node
        }
    }

    /// `$defs.hop`: one continuation hop (continuation.js): planSeq and
    /// hopSeq order it, nextId names what it plays. The rest (its
    /// lastEpisodeRow, `at`) is kept as sent.
    public struct Hop: Equatable {
        public let planSeq: Int
        public let hopSeq: Int
        public let nextId: String
        public let node: JSONNode

        init(contract node: JSONNode, at path: String) throws {
            let o = try ContractObject(node, at: path)
            planSeq = try o.required("planSeq", ContractRead.nonNegativeInt)
            hopSeq = try o.required("hopSeq", ContractRead.nonNegativeInt)
            nextId = try o.required("nextId", ContractRead.nonEmptyString)
            self.node = node
        }
    }

    /// `$defs.pendingEvent`: `{seq, kind: "position", episode_id, seconds, duration, at}`.
    public struct PendingEvent: Equatable {
        public let seq: Int
        public let kind: String
        public let node: JSONNode

        init(contract node: JSONNode, at path: String) throws {
            let o = try ContractObject(node, at: path)
            seq = try o.required("seq", ContractRead.nonNegativeInt)
            kind = try o.required("kind", ContractRead.string)
            self.node = node
        }
    }

    /// `$defs.nowPlaying`.
    public struct NowPlaying: Equatable {
        public let title: String
        public let artist: String
        public let album: String
    }

    // MARK: - Payloads

    /// engineHello's request (§5.1).
    public struct HelloRequest: Equatable {
        public let pageBuild: String
        public let protocolVersion: Int

        public init(pageBuild: String, protocolVersion: Int) {
            self.pageBuild = pageBuild
            self.protocolVersion = protocolVersion
        }

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            pageBuild = try o.required("pageBuild", ContractRead.string)
            protocolVersion = try o.required("protocol", ContractRead.integer(atLeast: 1))
        }
    }

    /// engineHello's answer (§5.1). A `native` answer must say everything the
    /// page needs to attach; the NE-01 stub's `{mode: "legacy", reason}` says
    /// only "not me".
    public struct HelloResponse: Equatable {
        public let mode: EngineMode.Mode
        public let reason: Vocabulary.ModeReason
        public let engineVersion: String?
        public let protocolVersion: Int?
        public let capabilities: [Capability]?
        public let ownedKeyPrefixes: [String]?
        public let snapshot: Snapshot?
        public let pendingAdvances: [Hop]?
        public let pendingEvents: [PendingEvent]?

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            mode = try o.required("mode", ContractRead.token(EngineMode.Mode.self))
            reason = try o.required("reason", ContractRead.token(Vocabulary.ModeReason.self))
            engineVersion = try o.optional("engineVersion", ContractRead.string)
            protocolVersion = try o.optional("protocol", ContractRead.integer(atLeast: 1))
            capabilities = try o.optional("capabilities", ContractRead.array(of: ContractRead.token(Capability.self)))
            ownedKeyPrefixes = try o.optional("ownedKeyPrefixes", ContractRead.array(of: ContractRead.string))
            snapshot = try o.optional("snapshot") { try Snapshot(contract: $0, at: $1) }
            pendingAdvances = try o.optional("pendingAdvances", ContractRead.array(of: { try Hop(contract: $0, at: $1) }))
            pendingEvents = try o.optional("pendingEvents", ContractRead.array(of: { try PendingEvent(contract: $0, at: $1) }))
            if mode == .native {
                for key in ["engineVersion", "protocol", "capabilities", "ownedKeyPrefixes", "snapshot"] where !o.has(key) {
                    throw ContractRead.fail("", "a native hello is missing \(key)")
                }
            }
        }
    }

    /// playForay's args (§5.2; M2).
    public struct PlayForay: Equatable {
        public let forayId: String
        public let title: String
        public let items: [Item]
        public let buildReport: JSONNode
        public let startElapsedSec: Double?
        public let isLocalFile: Bool
        public let allowAdPad: Bool
        public let voiceId: String?
    }

    /// One engineSend command with its args (§5.2). Where the plan names no
    /// argument (seekBy, seekTo, jump, setRate, ...) the name is NE-11j's,
    /// from engine-contract.js `COMMAND_ARGS`.
    public enum Command: Equatable {
        /// `lastEpisodeRow` is `makeLastEpisode(item)` without `updated_at`;
        /// the engine stores it verbatim plus `updated_at` (NE-10s `Rows`).
        case playEpisode(item: Item, startSec: Double?, moved: Bool?, lastEpisodeRow: JSONNode)
        case playForay(PlayForay)
        case setContinuation(planSeq: Int, autoAdvance: Bool, chain: [Hop], previous: Hop?)
        case play
        case pause
        case toggle
        case next
        case previous
        case seekBy(deltaSec: Double)
        case seekTo(sec: Double)
        case jump(index: Int)
        /// `persist: false` is data deletion.
        case stop(persist: Bool)
        case setRate(Double)
        case setVoice(voiceId: String?)
        case setInterludeEnabled(Bool)
        case setPageVisible(Bool)
        case ackAdvances(upToSeq: Int)
        case ackEvents(upToSeq: Int)
        case restoreBar
        case purge
        case relinquish(cap: RelinquishCap)
        case audition(text: String, voiceId: String?)
        case setModeOverride(EngineMode.Override)
        case setHoldPolicy(SessionPolicy.HoldPolicy)
        /// Developer only (NE-25c).
        case probeSession

        public var name: CommandName {
            switch self {
            case .playEpisode: return .playEpisode
            case .playForay: return .playForay
            case .setContinuation: return .setContinuation
            case .play: return .play
            case .pause: return .pause
            case .toggle: return .toggle
            case .next: return .next
            case .previous: return .previous
            case .seekBy: return .seekBy
            case .seekTo: return .seekTo
            case .jump: return .jump
            case .stop: return .stop
            case .setRate: return .setRate
            case .setVoice: return .setVoice
            case .setInterludeEnabled: return .setInterludeEnabled
            case .setPageVisible: return .setPageVisible
            case .ackAdvances: return .ackAdvances
            case .ackEvents: return .ackEvents
            case .restoreBar: return .restoreBar
            case .purge: return .purge
            case .relinquish: return .relinquish
            case .audition: return .audition
            case .setModeOverride: return .setModeOverride
            case .setHoldPolicy: return .setHoldPolicy
            case .probeSession: return .probeSession
            }
        }

        /// A command's args. A command that takes args REQUIRES them; one that
        /// takes none accepts any object (or no `args` at all), because an
        /// unknown key is never a refusal.
        static func decode(_ name: CommandName, args: ContractObject?) throws -> Command {
            func a() throws -> ContractObject {
                guard let args else { throw ContractRead.fail("", "\(name.rawValue) needs args") }
                return args
            }
            let R = ContractRead.self
            switch name {
            case .playEpisode:
                let o = try a()
                let row = try o.nested("lastEpisodeRow")
                _ = try row.required("id", R.nonEmptyString)
                return .playEpisode(item: try o.required("item") { try Item(contract: $0, at: $1) },
                                    startSec: try o.optional("startSec", R.nonNegative),
                                    moved: try o.optional("moved", R.bool),
                                    lastEpisodeRow: row.node)
            case .playForay:
                let o = try a()
                return .playForay(PlayForay(
                    forayId: try o.required("forayId", R.nonEmptyString),
                    title: try o.required("title", R.string),
                    items: try o.required("items", R.array(of: { try Item(contract: $0, at: $1) }, minItems: 1)),
                    buildReport: try o.required("buildReport", R.object),
                    startElapsedSec: try o.optional("startElapsedSec", R.nonNegative),
                    isLocalFile: try o.required("isLocalFile", R.bool),
                    allowAdPad: try o.required("allowAdPad", R.bool),
                    voiceId: try o.requiredNullable("voiceId", R.string)))
            case .setContinuation:
                let o = try a()
                return .setContinuation(planSeq: try o.required("planSeq", R.nonNegativeInt),
                                        autoAdvance: try o.required("autoAdvance", R.bool),
                                        chain: try o.required("chain", R.array(of: { try Hop(contract: $0, at: $1) })),
                                        previous: try o.optionalNullable("previous") { try Hop(contract: $0, at: $1) })
            case .play: return .play
            case .pause: return .pause
            case .toggle: return .toggle
            case .next: return .next
            case .previous: return .previous
            case .seekBy: return .seekBy(deltaSec: try a().required("deltaSec", R.number))
            case .seekTo: return .seekTo(sec: try a().required("sec", R.nonNegative))
            case .jump: return .jump(index: try a().required("index", R.nonNegativeInt))
            case .stop: return .stop(persist: try a().required("persist", R.bool))
            case .setRate: return .setRate(try a().required("rate", R.positive))
            case .setVoice: return .setVoice(voiceId: try a().requiredNullable("voiceId", R.string))
            case .setInterludeEnabled: return .setInterludeEnabled(try a().required("enabled", R.bool))
            case .setPageVisible: return .setPageVisible(try a().required("visible", R.bool))
            case .ackAdvances: return .ackAdvances(upToSeq: try a().required("upToSeq", R.nonNegativeInt))
            case .ackEvents: return .ackEvents(upToSeq: try a().required("upToSeq", R.nonNegativeInt))
            case .restoreBar: return .restoreBar
            case .purge: return .purge
            case .relinquish: return .relinquish(cap: try a().required("cap", R.token(RelinquishCap.self)))
            case .audition:
                let o = try a()
                return .audition(text: try o.required("text", R.nonEmptyString),
                                 voiceId: try o.requiredNullable("voiceId", R.string))
            case .setModeOverride: return .setModeOverride(try a().required("mode", R.token(EngineMode.Override.self)))
            case .setHoldPolicy: return .setHoldPolicy(try a().required("policy", R.holdPolicy))
            case .probeSession: return .probeSession
            }
        }
    }

    /// engineSend's request (§5.1): `{v: 1, cmdSeq, cmd, args, source, issuedAtWallMs}`.
    public struct SendRequest: Equatable {
        public let cmdSeq: Int
        public let command: Command
        /// Recorded before any no-op return (D-4).
        public let source: Vocabulary.Source
        public let issuedAtWallMs: Double?

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            _ = try o.required("v", EngineContract.version)
            cmdSeq = try o.required("cmdSeq", ContractRead.nonNegativeInt)
            let name = try o.required("cmd", ContractRead.token(CommandName.self))
            let args = try o.optional("args") { try ContractObject($0, at: $1) }
            source = try o.required("source", ContractRead.token(Vocabulary.Source.self))
            issuedAtWallMs = try o.optional("issuedAtWallMs", ContractRead.nonNegative)
            command = try Command.decode(name, args: args)
        }
    }

    /// engineSend's answer: `{ok, reason?, snapshot}`. It never rejects; a
    /// refusal is `ok: false` with a reason from the closed set.
    public struct SendResponse: Equatable {
        public let ok: Bool
        public let reason: Refusal?
        public let snapshot: Snapshot

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            ok = try o.required("ok", ContractRead.bool)
            reason = try o.optional("reason", ContractRead.token(Refusal.self))
            snapshot = try o.required("snapshot") { try Snapshot(contract: $0, at: $1) }
            if !ok && reason == nil { throw ContractRead.fail("", "a refusal must carry its reason") }
        }
    }

    /// engineRead's request. `prefixes` names shared rows only: the engine's
    /// private keys are never read through here, nor any row it does not own.
    public struct ReadRequest: Equatable {
        public let what: ReadKind
        public let prefixes: [String]?

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            what = try o.required("what", ContractRead.token(ReadKind.self))
            prefixes = try o.optional("prefixes", ContractRead.array(of: { (node: JSONNode, path: String) throws -> String in
                let prefix = try ContractRead.string(node, path)
                guard EngineContract.ownedPrefixes.contains(prefix) else {
                    throw ContractRead.fail(path, "\(prefix) is not a row the engine owns")
                }
                return prefix
            }))
        }
    }

    /// engineRead("rows")'s answer: key -> the exact string stored (JSWriter's
    /// bytes), so the page adopts a row without re-serialising it.
    public struct RowsResponse: Equatable {
        public let rows: [String: String]

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            let table = try o.nested("rows")
            var rows: [String: String] = [:]
            for member in table.node.members ?? [] {
                rows[member.key] = try ContractRead.string(member.value, "\(table.path)/\(member.key)")
            }
            self.rows = rows
        }
    }

    /// engineRead("diagnostics")'s answer: DiagRow objects, as written.
    public struct DiagnosticsResponse: Equatable {
        public let rows: [JSONNode]

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            rows = try o.required("rows", ContractRead.array(of: ContractRead.object))
        }
    }

    /// Snapshot v1 (§5.3).
    public struct Snapshot: Equatable {
        public let seq: Int
        public let capturedAtWallMs: Double
        public let capturedAtMonotonicMs: Double
        public let mode: SnapshotMode
        public let forayId: String?
        public let index: Int?
        public let itemId: String?
        public let itemKind: String?
        public let state: PlayerState
        public let wasPlaying: Bool?
        public let running: Bool
        public let inSeamGap: Bool
        public let inInterlude: Bool
        public let buffering: Bool
        public let ended: Bool
        public let positionSec: Double
        /// nil while the duration is unknown (JSON carries no Infinity).
        public let durationSec: Double?
        public let sourceTimeSec: Double?
        public let playheadItemId: String?
        public let isNarrationPlayhead: Bool
        public let narrationElapsedSec: Double?
        public let rate: Double
        public let effectiveRate: Double
        public let canNext: Bool
        public let canPrevious: Bool
        public let autoAdvance: Bool
        public let lastError: String?
        public let voiceFallback: String?
        /// Counts here; the logs themselves travel in engineHello.
        public let skippedSegments: Int
        public let pendingAdvances: Int
        public let pendingEvents: Int
        public let session: SessionPolicy.Phase
        public let holdPolicy: SessionPolicy.HoldPolicy
        public let nowPlaying: NowPlaying

        public init(contract node: JSONNode) throws {
            try self.init(contract: node, at: "")
        }

        init(contract node: JSONNode, at path: String) throws {
            let R = ContractRead.self
            let o = try ContractObject(node, at: path)
            _ = try o.required("v", EngineContract.version)
            seq = try o.required("seq", R.nonNegativeInt)
            capturedAtWallMs = try o.required("capturedAtWallMs", R.nonNegative)
            capturedAtMonotonicMs = try o.required("capturedAtMonotonicMs", R.nonNegative)
            mode = try o.required("mode", R.token(SnapshotMode.self))
            forayId = try o.optionalNullable("forayId", R.string)
            index = try o.optionalNullable("index", R.nonNegativeInt)
            itemId = try o.optionalNullable("itemId", R.string)
            itemKind = try o.optionalNullable("itemKind", R.string)
            state = try o.required("state", R.token(PlayerState.self))
            wasPlaying = try o.optional("wasPlaying", R.bool)
            running = try o.required("running", R.bool)
            inSeamGap = try o.required("inSeamGap", R.bool)
            inInterlude = try o.required("inInterlude", R.bool)
            buffering = try o.required("buffering", R.bool)
            ended = try o.required("ended", R.bool)
            positionSec = try o.required("positionSec", R.nonNegative)
            durationSec = try o.requiredNullable("durationSec", R.nonNegative)
            sourceTimeSec = try o.requiredNullable("sourceTimeSec", R.nonNegative)
            playheadItemId = try o.requiredNullable("playheadItemId", R.string)
            isNarrationPlayhead = try o.required("isNarrationPlayhead", R.bool)
            narrationElapsedSec = try o.optional("narrationElapsedSec", R.nonNegative)
            rate = try o.required("rate", R.positive)
            effectiveRate = try o.required("effectiveRate", R.nonNegative)
            canNext = try o.required("canNext", R.bool)
            canPrevious = try o.required("canPrevious", R.bool)
            autoAdvance = try o.required("autoAdvance", R.bool)
            lastError = try o.optionalNullable("lastError", R.string)
            voiceFallback = try o.optionalNullable("voiceFallback", R.string)
            skippedSegments = try o.required("skippedSegments", R.nonNegativeInt)
            pendingAdvances = try o.required("pendingAdvances", R.nonNegativeInt)
            pendingEvents = try o.required("pendingEvents", R.nonNegativeInt)
            session = try o.required("session", R.token(SessionPolicy.Phase.self))
            holdPolicy = try o.required("holdPolicy", R.holdPolicy)
            let np = try o.nested("nowPlaying")
            nowPlaying = NowPlaying(title: try np.required("title", R.string),
                                    artist: try np.required("artist", R.string),
                                    album: try np.required("album", R.string))
        }
    }

    /// An "engine" event (§5.4). Only the fields its `type` requires are read:
    /// an `advanced` event carrying some other `code` is not the contract's
    /// business, so it is not a refusal.
    public struct Event: Equatable {
        public let type: EventType
        /// `snapshot` events.
        public let snapshot: Snapshot?
        /// `error` events (`chain-start`, C-6).
        public let code: String?
        /// `modeChanged` events.
        public let mode: EngineMode.Mode?
        public let reason: Vocabulary.ModeReason?
        public let node: JSONNode

        public init(contract node: JSONNode) throws {
            let o = try ContractObject(node)
            type = try o.required("type", ContractRead.token(EventType.self))
            var snapshot: Snapshot?
            var code: String?
            var mode: EngineMode.Mode?
            var reason: Vocabulary.ModeReason?
            switch type {
            case .snapshot:
                snapshot = try o.required("snapshot") { try Snapshot(contract: $0, at: $1) }
            case .error:
                code = try o.required("code", ContractRead.nonEmptyString)
            case .modeChanged:
                mode = try o.required("mode", ContractRead.token(EngineMode.Mode.self))
                reason = try o.required("reason", ContractRead.token(Vocabulary.ModeReason.self))
            case .advanced, .skipped, .voiceFallback, .diag:
                break
            }
            self.snapshot = snapshot
            self.code = code
            self.mode = mode
            self.reason = reason
            self.node = node
        }
    }

    // MARK: - Accept or refuse

    /// `const: PROTOCOL` for a payload's `v`.
    static func version(_ node: JSONNode, _ path: String) throws -> Int {
        guard node == .number(Double(protocolVersion)) else { throw ContractRead.fail(path, "must be \(protocolVersion)") }
        return protocolVersion
    }

    /// Why `payload` is not a valid `kind`, or nil when it is.
    public static func refusal(_ kind: Kind, _ payload: JSONNode) -> ContractError? {
        do {
            switch kind {
            case .helloRequest: _ = try HelloRequest(contract: payload)
            case .helloResponse: _ = try HelloResponse(contract: payload)
            case .sendRequest: _ = try SendRequest(contract: payload)
            case .sendResponse: _ = try SendResponse(contract: payload)
            case .readRequest: _ = try ReadRequest(contract: payload)
            case .rowsResponse: _ = try RowsResponse(contract: payload)
            case .diagnosticsResponse: _ = try DiagnosticsResponse(contract: payload)
            case .snapshot: _ = try Snapshot(contract: payload)
            case .event: _ = try Event(contract: payload)
            }
            return nil
        } catch let error as ContractError {
            return error
        } catch {
            return ContractError(path: "", reason: "\(error)")
        }
    }

    /// `contractAccepts(kind, payload)`: accept or refuse, and nothing else:
    /// what the contract and snapshot parity families compare.
    public static func accepts(_ kind: Kind, _ payload: JSONNode) -> Bool {
        refusal(kind, payload) == nil
    }
}

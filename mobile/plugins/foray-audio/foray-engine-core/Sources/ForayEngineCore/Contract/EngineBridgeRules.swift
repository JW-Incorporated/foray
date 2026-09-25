import Foundation

// ── WHAT THE BRIDGE SAYS, AND WHEN (card NE-20; docs/native-engine-plan.md §5.1-§5.4) ──
//
// The plugin's three methods (`engineHello`, `engineSend`, `engineRead`) and
// its one event (`engine`) carry JSON the page validates against the same
// schema the parity `contract` and `snapshot` families pin. Everything that
// decides the SHAPE of those payloads, and when an event may leave, is here,
// pure, so the host `swift test` checks every answer against
// `EngineContract.accepts` without a Simulator, and the plugin only moves the
// bytes across Capacitor.
//
// The page-side model of the same rules is `player/parity/reference-engine.js`
// (NE-21): `_body()` is `EngineSnapshot.body`, `snapshot()`'s content version
// is `SnapshotStamper`, and `_transition()` / `_pump()` are
// `SnapshotCoalescer`.

public enum EngineBridgeRules {

    /// What `engineHello` names this engine: the Copy header's `v<ver>`
    /// (player/diagnostic-log.js reads `hello.engineVersion`).
    public static let engineVersion = "1.0.0"

    /// The Capacitor event every engine event rides on: native-engine.js
    /// `ENGINE_EVENT` (shell-invariants pins the two together).
    public static let eventName = "engine"

    /// §5.4: at most one `snapshot` event per this many ms while the page is
    /// visible (reference-engine.js `SNAPSHOT_EVENT_MIN_MS`).
    public static let snapshotEventMinMs: Double = 1000

    /// THE CAPABILITIES THIS BINARY MAY ADVERTISE: what it implements AND what
    /// the parity gate lets it claim. `player/parity/coverage.js`
    /// `advertisedCapabilities` reads this literal, and `coverage.test.js`
    /// refuses any entry whose families still owe swift-pending or unported
    /// work (plan §6.6). So:
    ///   - `episode` (NE-27b, the M1 flip): the core plays episodes (NE-14s),
    ///     and NE-14k emptied `manager-episode` / `deck-episode` of the 42
    ///     unported transport-reconcile tests, so every family it lists owes
    ///     nothing.
    ///   - `continuation`: `setContinuation` and the hop walk are the core's
    ///     (NE-14s), and its family owes nothing.
    ///   - `restore` (NE-27b): the cold path boots from the restore record
    ///     (NE-24), and its families owe nothing.
    ///   - `foray` is NOT, yet: it waits for M2 (NE-30s).
    /// These three are exactly what shell-invariants lets an M1 native
    /// default (mobile/ENGINE_DEFAULT.json) list. A capability missing here is
    /// refused `capability-off` by `engineSend`, whatever the plist says.
    public static let advertisedCapabilities: [String] = ["episode", "continuation", "restore"]

    /// `ForayEngineCapabilities` (the plist, from mobile/ENGINE_DEFAULT.json)
    /// ∩ `advertisedCapabilities`, in the contract's order. Nil (no plist key)
    /// is the empty set: a build nobody configured claims nothing.
    public static func capabilities(declared: [String]?) -> [EngineContract.Capability] {
        let declared = Set(declared ?? [])
        return EngineContract.Capability.allCases.filter {
            declared.contains($0.rawValue) && advertisedCapabilities.contains($0.rawValue)
        }
    }

    /// The capability a command needs before the engine will act on it, if
    /// any (reference-engine.js refuses exactly these two `capability-off`).
    public static func requiredCapability(_ command: EngineContract.Command) -> EngineContract.Capability? {
        switch command {
        case .playEpisode: return .episode
        case .playForay: return .foray
        default: return nil
        }
    }

    // MARK: - engineHello

    /// Not the native engine: `{mode: "legacy", reason, protocol}`. The page
    /// reads `legacy` as "run the JS player" (`decidePageMode`,
    /// `engine-legacy`), whatever the reason.
    public static func legacyHello(reason: Vocabulary.ModeReason) -> JSONNode {
        .object([
            JSONMember("mode", .string(EngineMode.Mode.legacy.rawValue)),
            JSONMember("reason", .string(reason.rawValue)),
            JSONMember("protocol", .number(Double(EngineContract.protocolVersion)))
        ])
    }

    /// The native answer (§5.1): everything the page needs to attach, with
    /// the unacked hops and position events it drains on attach (§5.5).
    public static func nativeHello(reason: Vocabulary.ModeReason, capabilities: [EngineContract.Capability],
                                   snapshot: JSONNode, pendingAdvances: [AdvanceEntry],
                                   pendingEvents: [PendingEvent]) -> JSONNode {
        .object([
            JSONMember("mode", .string(EngineMode.Mode.native.rawValue)),
            JSONMember("reason", .string(reason.rawValue)),
            JSONMember("engineVersion", .string(engineVersion)),
            JSONMember("protocol", .number(Double(EngineContract.protocolVersion))),
            JSONMember("capabilities", .array(capabilities.map { JSONNode.string($0.rawValue) })),
            JSONMember("ownedKeyPrefixes", .array(EngineContract.ownedPrefixes.map { JSONNode.string($0) })),
            JSONMember("snapshot", snapshot),
            JSONMember("pendingAdvances", .array(pendingAdvances.map(\.node))),
            JSONMember("pendingEvents", .array(pendingEvents.map(\.node)))
        ])
    }

    // MARK: - engineSend

    /// The one refusal a send reports: the first of the turn's failures that
    /// is a contract token. The core only ever fails with one (`refuse`), so
    /// the fallback is a guard, not a path.
    public static func refusal(for failures: [String]) -> EngineContract.Refusal? {
        guard !failures.isEmpty else { return nil }
        return failures.lazy.compactMap(EngineContract.Refusal.init(rawValue:)).first ?? .unknownCmd
    }

    /// `{ok, reason?, snapshot}`. Never a rejection (§5.1).
    public static func sendResponse(refusal: EngineContract.Refusal?, snapshot: JSONNode) -> JSONNode {
        var members = [JSONMember("ok", .bool(refusal == nil))]
        if let refusal { members.append(JSONMember("reason", .string(refusal.rawValue))) }
        members.append(JSONMember("snapshot", snapshot))
        return .object(members)
    }

    // MARK: - engineRead

    /// `{rows: {key: stored string}}`, keys sorted so two reads of the same
    /// rows are the same bytes.
    public static func rowsResponse(_ rows: [String: String]) -> JSONNode {
        .object([JSONMember("rows", .object(rows.keys.sorted().map { JSONMember($0, .string(rows[$0]!)) }))])
    }

    /// `{rows: [DiagRow]}`: the whole ring, oldest first, in one call.
    public static func diagnosticsResponse(_ rows: [DiagRow]) -> JSONNode {
        .object([JSONMember("rows", .array(rows.map(\.node)))])
    }

    // MARK: - Events (§5.4)

    public static func snapshotEvent(_ snapshot: JSONNode) -> JSONNode {
        .object([JSONMember("type", .string(EngineContract.EventType.snapshot.rawValue)), JSONMember("snapshot", snapshot)])
    }

    /// The core's own events: a walked hop (`advanced`, the entry the page
    /// applies and acks, §5.5) and a failure (`error`, C-6's `chain-start`).
    public static func event(_ event: EngineEvent) -> JSONNode {
        switch event {
        case let .advanced(entry):
            return .object([JSONMember("type", .string(EngineContract.EventType.advanced.rawValue)),
                            JSONMember("hop", entry.node)])
        case let .error(code, message):
            return .object([JSONMember("type", .string(EngineContract.EventType.error.rawValue)),
                            JSONMember("code", .string(code)), JSONMember("message", .string(message))])
        case let .skipped(itemId, index, reason):
            // NE-30s: ADR-0007's ladder refused a segment at load.
            return .object([JSONMember("type", .string(EngineContract.EventType.skipped.rawValue)),
                            JSONMember("itemId", .string(itemId)), JSONMember("index", .number(Double(index))),
                            JSONMember("reason", .string(reason))])
        }
    }

    /// The engine gave the process back (a relinquish, the hello watchdog):
    /// from here the page must run the JS player.
    public static func modeChangedEvent(reason: Vocabulary.ModeReason) -> JSONNode {
        .object([JSONMember("type", .string(EngineContract.EventType.modeChanged.rawValue)),
                 JSONMember("mode", .string(EngineMode.Mode.legacy.rawValue)),
                 JSONMember("reason", .string(reason.rawValue))])
    }

    /// One ring row as written (already through DiagGate), for a page that is
    /// looking: a `fault` the Developer drawer should not have to Copy to see.
    public static func diagEvent(_ row: DiagRow) -> JSONNode {
        .object([JSONMember("type", .string(EngineContract.EventType.diag.rawValue)), JSONMember("row", row.node)])
    }

    /// The ring kinds that also go out live as a `diag` event. Only faults:
    /// the ring holds everything, and the page reads it whole through
    /// `engineRead("diagnostics")` (NE-26); a live copy of every row would be
    /// the bridge traffic the coalescing exists to avoid.
    public static let liveDiagKinds: Set<String> = ["fault"]
}

// MARK: - Snapshot v1 (§5.3)

/// The snapshot's CONTENT, from the core's state and the deck's reading at
/// the moment it is taken. Everything but `seq` and the two capture stamps,
/// which `SnapshotStamper` adds.
public enum EngineSnapshot {

    public static func body(core: EngineCore, deck: DeckReading, lastError: String?) -> [JSONMember] {
        let state = core.state
        let type = state.stateType
        // A stopped engine keeps its queue (the reducer is idle); the page
        // sees nothing loaded, as it does after its own stop.
        let item: EngineItem? = type == "idle" ? nil : state.currentItem
        let mode: EngineContract.SnapshotMode = item == nil ? .nothing : (state.forayId != nil ? .foray : .episode)
        let loaded = item != nil && state.loadedId != nil
        let playhead = loaded ? max(0, finite(deck.positionSec) ?? 0) : 0
        let duration: JSONNode = loaded ? (finite(deck.durationSec).flatMap { $0 > 0 ? JSONNode.number($0) : nil } ?? .null) : .null
        let rate = state.rate > 0 && state.rate.isFinite ? state.rate : PlaybackRate.defaultRate
        let effectiveRate = type == "playing" && !state.buffering ? rate : 0
        let metadata = item.map { MediaMapping.metadata(item: MediaMapping.Item(
            kind: $0.node["kind"]?.stringValue, title: $0.node["title"]?.stringValue, show: $0.node["show"]?.stringValue)) }

        var members: [JSONMember] = [
            JSONMember("v", .number(Double(EngineContract.protocolVersion))),
            JSONMember("mode", .string(mode.rawValue))
        ]
        if let forayId = state.forayId, item != nil { members.append(JSONMember("forayId", .string(forayId))) }
        members.append(JSONMember("index", item == nil ? .null : .number(Double(state.currentIndex))))
        members.append(JSONMember("itemId", item.map { JSONNode.string($0.id) } ?? .null))
        members.append(JSONMember("itemKind", item.map { JSONNode.string($0.node["kind"]?.stringValue ?? kindName($0.kind)) } ?? .null))
        members.append(JSONMember("state", .string(type)))
        if case let .interrupted(_, wasPlaying) = state.player {
            members.append(JSONMember("wasPlaying", .bool(wasPlaying)))
        }
        members += [
            JSONMember("running", .bool(state.isRunning)),
            // The interlude is NE-31s's.
            JSONMember("inSeamGap", .bool(state.inSeamGap)),
            JSONMember("inInterlude", .bool(false)),
            JSONMember("buffering", .bool(state.buffering)),
            JSONMember("ended", .bool(type == "ended")),
            JSONMember("positionSec", .number(playhead)),
            JSONMember("durationSec", duration),
            JSONMember("sourceTimeSec", loaded ? .number(playhead) : .null),
            JSONMember("playheadItemId", state.loadedId.map { JSONNode.string($0) } ?? .null),
            JSONMember("isNarrationPlayhead", .bool(false)),
            JSONMember("rate", .number(rate)),
            JSONMember("effectiveRate", .number(effectiveRate)),
            JSONMember("canNext", .bool(core.canNext)),
            JSONMember("canPrevious", .bool(item != nil && core.canPrevious)),
            JSONMember("autoAdvance", .bool(state.autoAdvance)),
            JSONMember("lastError", lastError.map { JSONNode.string($0) } ?? .null),
            JSONMember("skippedSegments", .number(Double(state.skippedSegments))),
            JSONMember("pendingAdvances", .number(Double(state.advanceLog.count))),
            JSONMember("pendingEvents", .number(Double(state.pendingEvents.count))),
            JSONMember("session", .string(state.session.rawValue)),
            JSONMember("holdPolicy", .string(state.holdPolicy.text)),
            JSONMember("nowPlaying", .object([
                JSONMember("title", .string(metadata?.title ?? "")),
                JSONMember("artist", .string(metadata?.artist ?? "")),
                JSONMember("album", .string(metadata?.album ?? ""))
            ]))
        ]
        return members
    }

    private static func finite(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return value
    }

    private static func kindName(_ kind: PlayerItemKind) -> String {
        kind == .tts ? EngineConstants.QueueState.tts : "episode"
    }
}

/// `seq` is a CONTENT version (reference-engine.js `snapshot()`): it moves
/// exactly when something other than the capture time changed, so the page
/// can drop a snapshot older than the one it holds, and the coalescer can
/// tell a transition that changed nothing from one that did.
public struct SnapshotStamper {
    public private(set) var seq = 0
    private var lastKey: String?

    public init() {}

    /// The stamped snapshot, and whether its content differs from the last
    /// one stamped.
    public mutating func stamp(_ body: [JSONMember], wallMs: Double, monoMs: Double) -> (snapshot: JSONNode, changed: Bool) {
        let key = JSWriter.stringify(.object(body))
        let changed = key != lastKey
        if changed {
            lastKey = key
            seq += 1
        }
        var members = body
        let header = [
            JSONMember("seq", .number(Double(seq))),
            JSONMember("capturedAtWallMs", .number(wallMs.isFinite ? max(0, wallMs) : 0)),
            JSONMember("capturedAtMonotonicMs", .number(monoMs.isFinite ? max(0, monoMs) : 0))
        ]
        // `v` first, then the stamps, then the rest, as §5.3 lists them.
        let versionAt = members.firstIndex { $0.key == "v" }.map { $0 + 1 } ?? 0
        members.insert(contentsOf: header, at: versionAt)
        return (.object(members), changed)
    }
}

/// WHEN A SNAPSHOT EVENT MAY LEAVE (§5.4): on a transition that changed the
/// content, at most one per `snapshotEventMinMs`, the latest winning, and
/// never while the page is hidden. A hidden page reads on visible instead,
/// so coming back into view sends exactly one, whatever piled up.
///
/// Pure: the host arms a timer for `.openWindow` (re-arming replaces the
/// last one) and calls `windowClosed()` when it fires.
public struct SnapshotCoalescer {
    public enum Step: Equatable {
        /// Send the current snapshot now.
        case emit
        /// Arm the window timer; nothing more goes out until it closes.
        case openWindow(ms: Double)
    }

    public private(set) var visible: Bool
    /// A change arrived that no event has carried yet.
    public private(set) var dirty = false
    public private(set) var windowOpen = false

    public init(visible: Bool = true) {
        self.visible = visible
    }

    /// A transition changed the snapshot's content.
    public mutating func changed() -> [Step] {
        dirty = true
        return pump()
    }

    /// The window's timer fired.
    public mutating func windowClosed() -> [Step] {
        windowOpen = false
        return pump()
    }

    /// `setPageVisible`. Hidden: nothing leaves until visible again. Hidden
    /// to visible: one snapshot NOW (a window left over from before the page
    /// hid does not hold it back). Visible to visible: just a change.
    public mutating func setVisible(_ newValue: Bool) -> [Step] {
        let wasVisible = visible
        visible = newValue
        guard newValue else { return [] }
        dirty = true
        if !wasVisible { windowOpen = false }
        return pump()
    }

    private mutating func pump() -> [Step] {
        guard visible, !windowOpen, dirty else { return [] }
        dirty = false
        windowOpen = true
        return [.emit, .openWindow(ms: EngineBridgeRules.snapshotEventMinMs)]
    }
}

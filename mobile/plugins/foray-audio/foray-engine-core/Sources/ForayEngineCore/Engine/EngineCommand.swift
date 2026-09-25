import Foundation

// ── WHAT COMES OUT OF `EngineCore.handle` (card NE-14s; plan §4.2) ─────────
//
// The core never touches AVFoundation, the audio session, MediaPlayer,
// UserDefaults or a timer. It returns these, in order, and the host
// interprets each through its seam (NE-15h). Order is the contract: "the stop
// row before the pause", "the activation before the play" and "the save
// before the load" are claims about positions in this array, and the parity
// driver and the XCTests assert them there.

/// Why BackgroundGrace was begun: a span that is silent while the engine
/// intends to play (plan §4.4). `UIBackgroundModes: audio` keeps the app alive
/// only while audio renders, so each of these holds a background task until
/// the deck confirms `.playing`, the intent ends, or the task expires.
public enum GraceReason: String, Equatable, Sendable, CaseIterable {
    case remotePlay = "remote-play"
    case backgroundTap = "background-tap"
    case interruptionResume = "interruption-resume"
    case routeResume = "route-resume"
    case coldPlay = "cold-play"
    /// The next episode of a continuation chain loading after an end.
    case autoAdvance = "auto-advance"
    /// A Foray seam reached in the background with the next item prepared
    /// (NE-30s): the span runs from the out-point until it is audible.
    case seam = "seam"
    /// The same, with nothing prepared: the next item loads cold inside the
    /// beat, the case that most needs the process kept awake (NE-30s).
    case prepareMiss = "prepare-miss"
}

/// How a grace span ended. Every begin has exactly one of these.
public enum GraceOutcome: String, Equatable, Sendable, CaseIterable {
    /// The deck confirmed `timeControlStatus == .playing`.
    case playing
    /// The intent ended without sound: a pause, a stop, a failed load, an
    /// activation the system refused.
    case notRunning = "not-running"
    /// The background task's expiration handler fired first.
    case expired
    case relinquished
}

/// A `cp_pos:<id>` write: the row's exact bytes (NE-10s `Rows.position`) and
/// the facts it was built from, for the diagnostics and the parity driver.
public struct PositionWrite: Equatable {
    public let itemId: String
    public let seconds: Double
    public let duration: Double?
    public let row: StoredRow
}

/// One entry of the bounded `pendingEvents` log the page drains on attach
/// (plan §5.5): today only `{kind: "position", episode_id, seconds, duration,
/// at}`, the event the page's PositionStore logs, so the privacy disclosure is
/// unchanged.
public struct PendingEvent: Equatable {
    public let seq: Int
    public let kind: String
    public let episodeId: String
    public let seconds: Double
    public let duration: Double?
    public let atMs: Double

    /// `$defs.pendingEvent`, as the contract and the restore record carry it.
    public var node: JSONNode {
        .object([
            JSONMember("seq", .number(Double(seq))),
            JSONMember("kind", .string(kind)),
            JSONMember("episode_id", .string(episodeId)),
            JSONMember("seconds", .number(seconds)),
            JSONMember("duration", duration.map { JSONNode.number($0) } ?? .null),
            JSONMember("at", .number(atMs))
        ])
    }
}

extension PendingEvent {
    /// One entry of a restore record's `pendingEvents`, read back after a
    /// termination (NE-24). Nil for anything `node` would not have written:
    /// a restored event is re-sent to the page, so it must be one it knows.
    init?(restored node: JSONNode) {
        guard let seqValue = node["seq"]?.numberValue, seqValue.isFinite, seqValue >= 0,
              seqValue.rounded(.towardZero) == seqValue,
              let kind = node["kind"]?.stringValue,
              let episodeId = node["episode_id"]?.stringValue, !episodeId.isEmpty,
              let seconds = node["seconds"]?.numberValue, seconds.isFinite,
              let atMs = node["at"]?.numberValue, atMs.isFinite else { return nil }
        let duration = node["duration"]?.numberValue
        self.init(seq: Int(seqValue), kind: kind, episodeId: episodeId, seconds: seconds,
                  duration: duration.flatMap { $0.isFinite ? $0 : nil }, atMs: atMs)
    }
}

/// One walked continuation hop (plan §5.5): the page applies it on attach
/// through `applyEngineAdvance`, idempotently, and acks it by `seq`.
public struct AdvanceEntry: Equatable {
    public let seq: Int
    public let hop: EngineContract.Hop
    public let atMs: Double

    /// The hop as sent, plus `seq` and `at`.
    public var node: JSONNode {
        var members = hop.node.members ?? []
        members.removeAll { $0.key == "seq" || $0.key == "at" }
        members.append(JSONMember("seq", .number(Double(seq))))
        members.append(JSONMember("at", .number(atMs)))
        return .object(members)
    }
}

extension AdvanceEntry {
    /// One walked hop from a restore record's `advanceLog` (NE-24): the hop
    /// as the page sent it, which the contract decodes again, with its `seq`
    /// and `at`. Nil for an entry the contract would refuse.
    init?(restored node: JSONNode) {
        guard let seqValue = node["seq"]?.numberValue, seqValue.isFinite, seqValue >= 0,
              seqValue.rounded(.towardZero) == seqValue,
              let atMs = node["at"]?.numberValue, atMs.isFinite,
              let hop = try? EngineContract.Hop(contract: node, at: "") else { return nil }
        self.init(seq: Int(seqValue), hop: hop, atMs: atMs)
    }
}

/// A diagnostics row before the ring stamps it (`seq`, `at`, `mono` are the
/// ring's, NE-19). Tokens only through `Vocabulary`.
public struct DiagEntry: Equatable {
    public let kind: String
    public let fields: [JSONMember]

    public init(kind: String, fields: [JSONMember]) {
        self.kind = kind
        self.fields = fields
    }

    public subscript(field key: String) -> JSONNode? {
        fields.last(where: { $0.key == key })?.value
    }
}

/// Events for the page (plan §5.4), best effort.
public enum EngineEvent: Equatable {
    /// A continuation hop was walked (source autoadvance, or a next press).
    case advanced(AdvanceEntry)
    /// `error{code}`: `chain-start` when a hop's start failed (C-6), `load`
    /// for any other failed item.
    case error(code: String, message: String)
    /// `skipped` (plan §5.4; NE-30s): ADR-0007's ladder refused a segment at
    /// load (the copy in hand is not the one the times were authored
    /// against), so it was never audible and the Foray went on without it.
    case skipped(itemId: String, index: Int, reason: String)
}

/// What the core asks the world to do.
public enum EngineCommand: Equatable {
    case deck(DeckCommand)
    /// Activate the audio session and answer with `.sessionResult` for this
    /// id IN THE SAME TURN (plan §4.2). Nothing audible is emitted until then.
    case sessionActivate(requestId: Int)
    /// `notifyOthers` only for a close, a final end or a data deletion
    /// (plan §4.4): a pause or a relinquish never invites the app we
    /// interrupted back.
    case sessionDeactivate(notifyOthers: Bool)
    case sessionReapplyCategory
    case sessionRebuild
    case graceBegin(GraceReason)
    case graceEnd(GraceOutcome)
    case timerArm(EngineTimer, afterMs: Double, repeating: Bool)
    case timerCancel(EngineTimer)
    case writePosition(PositionWrite)
    /// A shared row the page also reads (`cp_last_episode`).
    case writeRow(StoredRow)
    case appendEvent(PendingEvent)
    /// The engine-private restore record; nil removes it (data deletion).
    case writeRestore(RestoreRecord?)
    /// Speak an audition line (OQ-5): audible, so it follows an activation.
    case speak(text: String, voiceId: String?)
    case emit(EngineEvent)
    case diag(DiagEntry)
    /// The command did not happen; the reason is a contract `Refusal` token.
    case commandFailed(reason: String)

    /// The command's name in a turn, as `SessionPolicy.audibleStartViolations`
    /// reads it: `deckPlay`, `speak`, `interludeStart` and `silenceStart` are
    /// audible; `sessionActivate` and `sessionDeactivate` move the session.
    public var turnName: String {
        switch self {
        case let .deck(command):
            switch command {
            case .load: return "deckLoad"
            case .play: return "deckPlay"
            case .pause: return "deckPause"
            case .seek: return "deckSeek"
            case .setRate: return "deckSetRate"
            case .setOutPoint: return "deckSetOutPoint"
            case .unload: return "deckUnload"
            case .prepare: return "deckPrepare"
            }
        case .sessionActivate: return SessionPolicy.TurnMarker.activate
        case .sessionDeactivate: return SessionPolicy.TurnMarker.deactivate
        case .sessionReapplyCategory: return "sessionReapplyCategory"
        case .sessionRebuild: return "sessionRebuild"
        case .graceBegin: return "graceBegin"
        case .graceEnd: return "graceEnd"
        case .timerArm: return "timerArm"
        case .timerCancel: return "timerCancel"
        case .writePosition: return "writePosition"
        case .writeRow: return "writeRow"
        case .appendEvent: return "appendEvent"
        case .writeRestore: return "writeRestore"
        case .speak: return "speak"
        case .emit: return "emit"
        case .diag: return "diag"
        case .commandFailed: return "commandFailed"
        }
    }
}

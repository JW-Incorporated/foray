import Foundation

/// The web <-> native contract, protocol v1: the Swift side of
/// `player/engine-contract.js` (docs/native-engine-plan.md §5, card NE-11s).
///
/// Three parts, each held to the JS by a parity family:
///
///   names        the closed sets both sides switch on (commands, events,
///                refusals, capabilities, ...): `contract`, `handshake`,
///                `snapshot` reads
///   decoding     `ContractDecoding.swift`: every payload that crosses the
///                bridge, decoded into typed values or refused, with the SAME
///                accept/refuse answer the page's schema validator gives
///                (`contract` and `snapshot` families, one case per example of
///                player/parity/schema/engine-contract.schema.json)
///   page rules   `decidePageMode` and `extrapolate`, below: the PAGE's rules,
///                ported so the `handshake` and `snapshot` families hold both
///                sides to one reading. The engine never calls them to decide
///                anything; NE-20 checks the hello it builds against
///                `decidePageMode` (a native answer the page would refuse is a
///                bridge that silently runs the JS player), and NE-21's
///                reference engine compares scrubber positions against
///                `extrapolate`.
///
/// Every token enum's raw values are the JS strings, in the JS order; the
/// parity reads return `allCases`, and SessionPolicyTests'
/// `testTokensAreTheGeneratedOnes` checks each against the generated
/// `EngineConstants.EngineContract`.
public enum EngineContract {
    /// `PROTOCOL`. A page and an engine that disagree run the JS player
    /// (`decidePageMode`); an added field is not a protocol change.
    public static let protocolVersion = Int(EngineConstants.EngineContract.`protocol`)

    /// `OWNED_PREFIXES`: the shared rows the native engine owns on iOS
    /// (§4.6). `Rows` writes exactly these; the trailing colons are
    /// load-bearing (engine-contract.js says why).
    public static let ownedPrefixes = EngineConstants.EngineContract.ownedPrefixes

    /// `BRIDGE_METHODS`: the three plugin methods (§5.1), iOS only.
    public enum BridgeMethod: String, CaseIterable, Sendable {
        case engineHello
        case engineSend
        case engineRead
    }

    /// `COMMANDS`: every engineSend `cmd` (§5.2). Anything else is refused with
    /// `unknown-cmd`, never guessed at. The decoded command, with its args,
    /// is `Command` (ContractDecoding.swift).
    public enum CommandName: String, CaseIterable, Sendable {
        case playEpisode
        case playForay
        case setContinuation
        case play
        case pause
        case toggle
        case next
        case previous
        case seekBy
        case seekTo
        case jump
        case stop
        case setRate
        case setVoice
        case setInterludeEnabled
        case setPageVisible
        case ackAdvances
        case ackEvents
        case restoreBar
        case purge
        case relinquish
        case audition
        case setModeOverride
        case setHoldPolicy
        case probeSession
    }

    /// `EVENTS`: the `type` of every "engine" event (§5.4).
    public enum EventType: String, CaseIterable, Sendable {
        case snapshot
        case advanced
        case skipped
        case error
        case voiceFallback
        case diag
        case modeChanged
    }

    /// `REFUSALS`: why an engineSend was refused, fully expanded, so a reason
    /// on the wire is always one exact string both sides switch on.
    public enum Refusal: String, CaseIterable, Sendable {
        case notLoaded = "not-loaded"
        case noNext = "no-next"
        case noPrevious = "no-previous"
        case ended
        case refusedStructure = "refused-structure"
        case capabilityOff = "capability-off"
        case sessionFailedCannotInterruptOthers = "session-failed:cannot-interrupt-others"
        case sessionFailedCannotStartPlaying = "session-failed:cannot-start-playing"
        case sessionFailedOther = "session-failed:other"
        case engineBusy = "engine-busy"
        case relinquished
        case unknownCmd = "unknown-cmd"
    }

    /// `READ_KINDS`: engineRead's `what`.
    public enum ReadKind: String, CaseIterable, Sendable {
        case snapshot
        case rows
        case diagnostics
    }

    /// `PAGE_MODES`: the page's own answer, `decidePageMode`.
    public enum PageMode: String, CaseIterable, Sendable {
        case native
        case js
    }

    /// `CAPABILITIES`: what a native engine can play (§6.6), each advertised
    /// only when its parity families owe nothing.
    public enum Capability: String, CaseIterable, Sendable {
        case episode
        case continuation
        case restore
        case foray
    }

    /// `RELINQUISH_CAPS`: the capability the page needed and the engine
    /// lacks, or `all` when the handshake itself failed.
    public enum RelinquishCap: String, CaseIterable, Sendable {
        case episode
        case continuation
        case restore
        case foray
        case all
    }

    /// `SNAPSHOT_MODES`: what is loaded. `.nothing` is spelled `none` on the
    /// wire; not named `none`, which Swift reads as `Optional.none` wherever a
    /// `SnapshotMode?` is compared.
    public enum SnapshotMode: String, CaseIterable, Sendable {
        case nothing = "none"
        case episode
        case foray
    }

    /// `PLAYER_STATES`: the six reducer states, spelled as their `type`.
    public enum PlayerState: String, CaseIterable, Sendable {
        case idle
        case loadingItem
        case playing
        case transitioning
        case interrupted
        case ended
    }

    /// `CONTRACT_KINDS`: the payloads the schema describes, in its order.
    public enum Kind: String, CaseIterable, Sendable {
        case helloRequest
        case helloResponse
        case sendRequest
        case sendResponse
        case readRequest
        case rowsResponse
        case diagnosticsResponse
        case snapshot
        case event
    }

    /// `HANDSHAKE_REASONS`: why `decidePageMode` answered what it did.
    public enum HandshakeReason: String, CaseIterable, Sendable {
        case native
        case notIos = "not-ios"
        case noMethod = "no-method"
        case noHello = "no-hello"
        case badHello = "bad-hello"
        case engineLegacy = "engine-legacy"
        case protocolMismatch = "protocol-mismatch"
    }

    // MARK: - The page's rules

    /// `helloRequest(pageBuild)`: the page's build stamp and the protocol it
    /// speaks. A missing stamp is "".
    public static func helloRequest(pageBuild: String?) -> HelloRequest {
        HelloRequest(pageBuild: pageBuild ?? "", protocolVersion: protocolVersion)
    }

    /// `decideMode`'s answer.
    public struct PageDecision: Equatable, Sendable {
        public let mode: PageMode
        public let reason: HandshakeReason
        /// True when an engine MIGHT be running natively and the page is about
        /// to run the JS player anyway: the page sends relinquish{cap: "all"}
        /// first, so there are never two producers (A-2).
        public let relinquish: Bool
    }

    /// `decideMode({platform, methodPresent, hello})`: does this page drive a
    /// native engine? `hello` is engineHello's answer as sent, or nil for a
    /// timeout or a rejection. `mode` is checked BEFORE `protocol`, because
    /// the NE-01 stub answers `{mode: "legacy", reason: "not-built"}` with no
    /// protocol at all, and that is the ordinary case, not a mismatch.
    public static func decidePageMode(platform: String?, methodPresent: Bool, hello: JSONNode?) -> PageDecision {
        func out(_ mode: PageMode, _ reason: HandshakeReason, _ relinquish: Bool) -> PageDecision {
            PageDecision(mode: mode, reason: reason, relinquish: relinquish)
        }
        guard platform == "ios" else { return out(.js, .notIos, false) }
        guard methodPresent else { return out(.js, .noMethod, false) }
        // JSON null and "no answer" are one case: the page reads both as `== null`.
        guard let hello, hello != .null else { return out(.js, .noHello, true) }
        guard let response = try? HelloResponse(contract: hello) else { return out(.js, .badHello, true) }
        guard response.mode == .native else { return out(.js, .engineLegacy, false) }
        guard response.protocolVersion == protocolVersion else { return out(.js, .protocolMismatch, true) }
        return out(.native, .native, false)
    }

    /// `extrapolate(snapshot, receivedAtMs, nowMs)`: where the playhead is
    /// `nowMs` after a snapshot arrived at `receivedAtMs` (§5.4), by the
    /// PAGE's own receipt clock (two processes' clocks cannot be subtracted).
    ///
    /// Frozen (the position as sent) while `inSeamGap`, `buffering` or not
    /// `running`: extrapolating any of those is a scrubber running ahead of
    /// audio that is not playing. Clamped to [0, durationSec] when the
    /// duration is known; a clock that went backwards counts as no time.
    ///
    /// Each parameter is what the JS reads: a non-finite number is nil, and
    /// the three flags are `=== true`.
    public static func extrapolate(positionSec: Double?, durationSec: Double?, inSeamGap: Bool, buffering: Bool,
                                   running: Bool, effectiveRate: Double?, receivedAtMs: Double?, nowMs: Double?) -> Double {
        let finite = { (value: Double?) -> Double? in value.flatMap { $0.isFinite ? $0 : nil } }
        let pos = finite(positionSec) ?? 0
        let dur = finite(durationSec).flatMap { $0 > 0 ? $0 : nil }
        // Math.max / Math.min, not Swift's: they differ on a signed zero
        // (JSMath says how), and a -0 is a red case.
        let clamp = { (x: Double) -> Double in JSMath.max(0, dur.map { JSMath.min($0, x) } ?? x) }
        if inSeamGap || buffering || !running { return clamp(pos) }
        let rate = finite(effectiveRate).flatMap { $0 > 0 ? $0 : nil } ?? 0
        var elapsedMs = 0.0
        if let received = finite(receivedAtMs), let now = finite(nowMs) { elapsedMs = JSMath.max(0, now - received) }
        return clamp(pos + (rate * elapsedMs) / 1000)
    }
}

import Foundation

/// The audio session's policy: the Swift port of `sessionTransition` and
/// `audibleStartViolations` in `player/engine-contract.js` (docs/native-engine-plan.md
/// §4.4, card NE-11s). JS is the reference; the `session` and
/// `session-invariant` parity families are the contract, and engine-contract.js
/// is where each edge's reason is written down.
///
/// WHY A PURE TABLE. `AVAudioSession` is a process-wide singleton that three
/// code paths used to poke at (the legacy hold, ForayTts, the web player's
/// implicit activation), and every car-test failure the deck lists comes back
/// to "who activated, and when". Here the WHOLE decision is one function of
/// `(phase, input, holdPolicy)`, pinned case by case against the JS table, and
/// `AudioSessionOwner` (NE-16) only carries out the actions it returns. The
/// interpreter never decides to activate or deactivate on its own.
///
/// ACTIVATION IS A REQUEST AND A RESPONSE (§4.2). An edge that needs the
/// session emits `.activate` and LEAVES THE PHASE WHERE IT WAS. The
/// interpreter calls `setActive(true)` synchronously and feeds the outcome
/// back as `.sessionResult`; only an ok result moves the phase to `.active`.
/// So nothing ever reports `.active` on the strength of an activation that has
/// not happened, which is what makes the audible-start invariant checkable.
///
/// QUIRKS ARE PORTED, NOT TIDIED (the rule of every port in this package): a
/// change goes JS first, then a re-record, then this file.
public enum SessionPolicy {
    /// `SESSION_PHASES`. `.relinquished` is terminal: after it the engine
    /// answers every input with nothing (§4.6).
    public enum Phase: String, CaseIterable, Sendable {
        case inactive
        case active
        case lostToInterruption
        case relinquished
    }

    /// `PLAY_VIAS`: what caused a play the session may activate for (S-1:
    /// activation only on a user-caused play). An audition tap counts (OQ-5).
    public enum PlayVia: String, CaseIterable, Sendable {
        case tap
        case remote
        case autoresume
        case auditionTap
    }

    /// `SESSION_ACTIONS`: what `AudioSessionOwner` does to AVAudioSession for
    /// an edge.
    ///
    /// `.deactivate` is `setActive(false)` with NO `.notifyOthersOnDeactivation`;
    /// `.deactivateNotify` carries it and is reserved for the three endings
    /// that mean "4a is done" (close, final end, data deletion). Notifying at
    /// a pause would invite the app 4a interrupted to take the car back
    /// mid-episode. `.commandFailed` is `.commandFailed` to the remote and
    /// `{ok: false, reason}` to the page.
    public enum Action: String, CaseIterable, Sendable {
        case activate
        case deactivate
        case deactivateNotify = "deactivate-notify"
        case reapplyCategory = "reapply-category"
        case rebuild
        case commandFailed = "command-failed"
    }

    /// `SESSION_ROWS`: the row an edge writes when the policy deliberately
    /// IGNORED an input. A drive's Copy paste has to show it arrived, or
    /// "ignored" and "never delivered" read the same.
    public enum Row: String, CaseIterable, Sendable {
        case staleSuspension = "stale-suspension"
        case micMuted = "mic-muted"
        case staleHold = "stale-hold"
        case mediaServicesReset = "media-services-reset"
    }

    /// `SESSION_INPUTS`, as names: the order the JS table lists them in.
    public enum InputKind: String, CaseIterable, Sendable {
        case userPlay
        case sessionResult
        case pause
        case beat
        case narration
        case background
        case holdExpired
        case interruptionBegan
        case interruptionEnded
        case mediaServicesReset
        case relinquish
        case close
        case finalEnd
        case dataDeletion
    }

    /// One input, with the fields its edge reads. Where JS reads a field with
    /// `=== true`, the Swift field is a plain `Bool`: only a real `true` is
    /// true there, and the adapter that builds the input says so.
    public enum Input: Equatable, Sendable {
        case userPlay(via: PlayVia)
        /// The interpreter's answer to `.activate`. `token` is the failure's
        /// session error, admitted through `sessionFailedReason` (an unknown
        /// token is `other`).
        case sessionResult(ok: Bool, token: String?)
        case pause
        case beat
        case narration
        case background
        /// `running`: whether the engine is audibly running when the hold
        /// timer fires (a timer it failed to cancel).
        case holdExpired(running: Bool)
        /// `reason` is already admitted (`interruptionReason(_:)`);
        /// `activatedInProcess` is whether THIS process activated the session.
        case interruptionBegan(reason: Vocabulary.InterruptionReason, running: Bool, activatedInProcess: Bool)
        case interruptionEnded(shouldResume: Bool, wasPlaying: Bool)
        case mediaServicesReset
        case relinquish
        case close
        case finalEnd
        case dataDeletion

        public var kind: InputKind {
            switch self {
            case .userPlay: return .userPlay
            case .sessionResult: return .sessionResult
            case .pause: return .pause
            case .beat: return .beat
            case .narration: return .narration
            case .background: return .background
            case .holdExpired: return .holdExpired
            case .interruptionBegan: return .interruptionBegan
            case .interruptionEnded: return .interruptionEnded
            case .mediaServicesReset: return .mediaServicesReset
            case .relinquish: return .relinquish
            case .close: return .close
            case .finalEnd: return .finalEnd
            case .dataDeletion: return .dataDeletion
            }
        }
    }

    /// `pauseHoldPolicy` (§4.4): hold the session through any pause
    /// (`.forever`, the default, S-4 as written), release it at a pause
    /// (`.noHold`, spelled `none`: the H-1b arm), or release it after
    /// `until:<minutes>` of pause (OQ-12 decides whether that ships).
    ///
    /// `.noHold` and not `.none`, which Swift would read as `Optional.none`
    /// wherever a `HoldPolicy?` is compared.
    public enum HoldPolicy: Equatable, Sendable {
        case forever
        case noHold
        case until(minutes: Int)

        /// `HOLD_POLICY_KINDS`, in order.
        public static let kinds = ["forever", "none", "until"]

        /// `DEFAULT_HOLD_POLICY`.
        public static let `default` = HoldPolicy.forever

        /// `parseHoldPolicy(policy)`: `forever`, `none`, or `until:<m>` with m
        /// a positive whole number of at most six digits and nothing else
        /// (`/^until:([1-9][0-9]{0,5})$/`); anything else is nil. As one
        /// string so it round-trips through UserDefaults, a Developer row and a
        /// Copy header unchanged.
        public init?(_ text: String) {
            switch text {
            case "forever": self = .forever
            case "none": self = .noHold
            default:
                let prefix = "until:"
                guard text.hasPrefix(prefix) else { return nil }
                let rest = String(text.dropFirst(prefix.count))
                let digits = Array(rest.unicodeScalars)
                // ASCII digits only: `[0-9]` in the JS pattern, where Swift's
                // `isNumber` would also admit other scripts' digits.
                guard (1...6).contains(digits.count), digits[0] != "0",
                      digits.allSatisfy({ ("0"..."9").contains($0) }),
                      let minutes = Int(rest) else { return nil }
                self = .until(minutes: minutes)
            }
        }

        /// The stored / logged spelling: the inverse of `init?(_:)`.
        public var text: String {
            switch self {
            case .forever: return "forever"
            case .noHold: return "none"
            case let .until(minutes): return "until:\(minutes)"
            }
        }

        /// `parseHoldPolicy`'s `kind`.
        public var kind: String {
            switch self {
            case .forever: return "forever"
            case .noHold: return "none"
            case .until: return "until"
            }
        }
    }

    /// One edge's outcome: the next phase, what to do, and the row / refusal
    /// it carries (`{phase, actions, row, reason}` in the JS).
    public struct Transition: Equatable, Sendable {
        public let phase: Phase
        public let actions: [Action]
        public let row: Row?
        /// The refusal for a failed activation (`session-failed:<token>`).
        public let reason: String?

        public init(phase: Phase, actions: [Action] = [], row: Row? = nil, reason: String? = nil) {
            self.phase = phase
            self.actions = actions
            self.row = row
            self.reason = reason
        }
    }

    /// `sessionFailedReason(token)`: `session-failed:<token>`, a token outside
    /// the closed session-error set admitted as `other`, so the wire never
    /// carries an unknown token.
    public static func sessionFailedReason(_ token: String?) -> String {
        let admitted = token.flatMap(Vocabulary.SessionError.init(rawValue:)) ?? .other
        return "session-failed:\(admitted.rawValue)"
    }

    /// The interruption `reason` an edge reads: one of the closed set, and
    /// anything else (a reason a later iOS adds, or none) is `unknown`, as
    /// `INTERRUPTION_REASONS.includes(input.reason) ? input.reason : "unknown"`
    /// reads it. `AudioSessionOwner` (NE-16) admits the notification's reason
    /// through this, so the adapter and the table cannot disagree.
    public static func interruptionReason(_ raw: String?) -> Vocabulary.InterruptionReason {
        raw.flatMap(Vocabulary.InterruptionReason.init(rawValue:)) ?? .unknown
    }

    /// `sessionTransition(phase, input, holdPolicy)`: one SessionPolicy edge.
    /// Each branch is the JS branch of the same name, in the same order.
    public static func transition(from phase: Phase, on input: Input,
                                  holdPolicy: HoldPolicy = .default) -> Transition {
        func to(_ next: Phase, _ actions: [Action] = [], row: Row? = nil, reason: String? = nil) -> Transition {
            Transition(phase: next, actions: actions, row: row, reason: reason)
        }
        func stay(_ actions: [Action] = [], row: Row? = nil, reason: String? = nil) -> Transition {
            to(phase, actions, row: row, reason: reason)
        }

        // Terminal: no deactivate and no notify on the way in, and nothing
        // after (§4.6: an app 4a interrupted must not be invited back by a
        // lane switch).
        if phase == .relinquished { return stay() }

        switch input {
        case .userPlay:
            // S-5: activate once. An active session is not re-activated per press.
            return phase == .active ? stay() : stay([.activate])

        case let .sessionResult(ok, token):
            if ok { return to(.active) }
            return stay([.commandFailed], reason: sessionFailedReason(token))

        case .pause, .beat, .narration, .background:
            // S-4: a pause, a seam beat, a narration handover or going to the
            // background does not release the session. Only a PAUSE under the
            // `none` policy does (the H-1b arm), and never with notify.
            if phase == .active, input == .pause, holdPolicy == .noHold { return to(.inactive, [.deactivate]) }
            return stay()

        case let .holdExpired(running):
            if phase == .active, case .until = holdPolicy, !running { return to(.inactive, [.deactivate]) }
            // A timer the engine failed to cancel (it is playing again, or the
            // policy changed) must not stop the audio; it is written down.
            return stay(row: .staleHold)

        case let .interruptionBegan(reason, running, activatedInProcess):
            if reason == .builtInMicMuted { return stay(row: .micMuted) }
            // A late began(appWasSuspended) for a suspension that is already
            // over: this process activated and is audibly running, so the
            // notification describes the past (stale=y), not a stop.
            if reason == .appWasSuspended && running && activatedInProcess {
                return stay(row: .staleSuspension)
            }
            return phase == .active ? to(.lostToInterruption) : stay()

        case let .interruptionEnded(shouldResume, wasPlaying):
            guard phase == .lostToInterruption else { return stay() }
            // The system took the session; it comes back only by activating
            // again, and only for a listener who was actually listening.
            if shouldResume && wasPlaying { return stay([.activate]) }
            // NP-9: Now Playing and the remote targets stay, so a later tap
            // or car button is a userPlay (S-5).
            return to(.inactive)

        case .mediaServicesReset:
            return to(.inactive, [.reapplyCategory, .rebuild], row: .mediaServicesReset)

        case .relinquish:
            return to(.relinquished)

        case .close, .finalEnd, .dataDeletion:
            return phase == .active ? to(.inactive, [.deactivateNotify]) : to(.inactive)
        }
    }

    // MARK: - The audible-start invariant (§4.4, the session-invariant family)

    /// `AUDIBLE_COMMANDS`: the engine commands that make sound. Each must come
    /// after the session was active at the start of the turn, or after a
    /// SUCCESSFUL activation in the same turn, because `AVPlayer.play()`, a
    /// synthesizer and an audio engine all activate an inactive session
    /// IMPLICITLY (§4.3): exactly the second, unowned session start this deck
    /// exists to remove.
    public static let audibleCommands = ["deckPlay", "speak", "interludeStart", "silenceStart"]

    /// The session traffic the interpreter interleaves into a turn.
    public enum TurnMarker {
        /// The core's request (`setActive(true)`).
        public static let activate = "sessionActivate"
        /// The interpreter's answer, success.
        public static let resultOk = "sessionResult:ok"
        /// The interpreter's answer, failure.
        public static let resultFailed = "sessionResult:failed"
        /// A deactivate in the same turn (hold policy `none`).
        public static let deactivate = "sessionDeactivate"
    }

    /// An audible command with no active session behind it.
    public struct Violation: Equatable, Sendable {
        /// Its index in the turn.
        public let at: Int
        public let cmd: String

        public init(at: Int, cmd: String) {
            self.at = at
            self.cmd = cmd
        }
    }

    /// `audibleStartViolations(sessionAtEntry, turn)`: every audible command
    /// in one `handle()` turn that had no active session behind it; empty
    /// means the turn keeps the invariant. `EngineCore` (NE-14s) runs every
    /// turn it emits through this in DEBUG and in its fixtures.
    ///
    /// A `sessionResult:ok` counts only as the answer to a `sessionActivate`
    /// asked earlier in the same turn: a success nobody requested is not an
    /// activation this engine owns.
    public static func audibleStartViolations(sessionAtEntry: Phase, turn: [String]) -> [Violation] {
        var active = sessionAtEntry == .active
        var asked = false
        var violations: [Violation] = []
        for (at, cmd) in turn.enumerated() {
            switch cmd {
            case TurnMarker.activate:
                asked = true
            case TurnMarker.resultOk:
                if asked { active = true }
                asked = false
            case TurnMarker.resultFailed:
                asked = false
            case TurnMarker.deactivate:
                active = false
            default:
                if audibleCommands.contains(cmd) && !active { violations.append(Violation(at: at, cmd: cmd)) }
            }
        }
        return violations
    }
}

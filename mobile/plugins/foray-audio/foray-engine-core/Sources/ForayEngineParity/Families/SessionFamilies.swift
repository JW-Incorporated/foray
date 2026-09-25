import Foundation
import ForayEngineCore

/// The `session`, `session-invariant` and `engine-mode` families against
/// `SessionPolicy` and `EngineMode` (ForayEngineCore/Policy), from the JS
/// reference tables in `player/engine-contract.js` (recorded by NE-11j,
/// ported by NE-11s).
///
/// TRANSLATION ONLY. Each JS function reads its input loosely (`input.ok ===
/// true`, `input?.kind`, `Number.isInteger(strikes) && strikes > 0`), and the
/// typed Swift port takes the answer: a strict `true` is a Bool, a string in
/// a closed set is its enum case, and anything the JS turns into a RangeError
/// or a TypeError is answered with that throw, IN THE ORDER the JS checks
/// (engine-contract.js validates phase, then input kind, then hold policy,
/// and reads `via` only after the terminal `relinquished` check).
public enum SessionFamily {
    public static let module = "player/engine-contract.js"

    public typealias Transition = (SessionPolicy.Phase, SessionPolicy.Input, SessionPolicy.HoldPolicy) -> SessionPolicy.Transition

    /// The real port.
    public static let runner = SessionFamily.makeRunner(transition: { SessionPolicy.transition(from: $0, on: $1, holdPolicy: $2) })

    /// The session runner over any transition function: the seam
    /// SessionPolicyTests uses to prove a MUTATED table turns named cases red
    /// (card NE-11s's mutations), with everything else about the run real.
    public static func makeRunner(transition: @escaping Transition) -> PureFamilyRunner {
        PureFamilyRunner(
            family: "session",
            module: module,
            reads: [
                "SESSION_PHASES": strings(SessionPolicy.Phase.allCases.map(\.rawValue)),
                "SESSION_INPUTS": strings(SessionPolicy.InputKind.allCases.map(\.rawValue)),
                "PLAY_VIAS": strings(SessionPolicy.PlayVia.allCases.map(\.rawValue)),
                "SESSION_ACTIONS": strings(SessionPolicy.Action.allCases.map(\.rawValue)),
                "SESSION_ROWS": strings(SessionPolicy.Row.allCases.map(\.rawValue)),
                "HOLD_POLICY_KINDS": strings(SessionPolicy.HoldPolicy.kinds),
                "DEFAULT_HOLD_POLICY": .string(SessionPolicy.HoldPolicy.default.text)
            ],
            calls: [
                "sessionTransition": { args in sessionTransition(args, transition) },
                "parseHoldPolicy": { args in
                    guard let text = ArgReading.arg(args, 0).stringValue, let policy = SessionPolicy.HoldPolicy(text) else {
                        return .returned(.null)
                    }
                    var minutes = JSValue.null
                    if case let .until(m) = policy { minutes = .number(Double(m)) }
                    return .returned(.object(["kind": .string(policy.kind), "minutes": minutes]))
                },
                "sessionFailedReason": { args in
                    .returned(.string(SessionPolicy.sessionFailedReason(ArgReading.arg(args, 0).stringValue)))
                }
            ])
    }

    /// `sessionTransition(phase, input, holdPolicy = DEFAULT_HOLD_POLICY)`.
    static func sessionTransition(_ args: [JSValue], _ transition: Transition) -> CallOutcome {
        guard let phase = ArgReading.arg(args, 0).stringValue.flatMap(SessionPolicy.Phase.init(rawValue:)) else {
            return .threw("RangeError")
        }
        // `input?.kind`: a missing or null input has no kind.
        let input = ArgReading.arg(args, 1)
        guard let kind = input["kind"].stringValue.flatMap(SessionPolicy.InputKind.init(rawValue:)) else {
            return .threw("RangeError")
        }
        // A default parameter applies to `undefined` only; null is parsed, and refused.
        let rawHold = ArgReading.arg(args, 2)
        let hold: SessionPolicy.HoldPolicy
        if rawHold == .undefined {
            hold = .default
        } else {
            guard let text = rawHold.stringValue, let parsed = SessionPolicy.HoldPolicy(text) else { return .threw("RangeError") }
            hold = parsed
        }
        let isTrue = { (value: JSValue) in value == .bool(true) }

        let typed: SessionPolicy.Input
        switch kind {
        case .userPlay:
            guard let via = input["via"].stringValue.flatMap(SessionPolicy.PlayVia.init(rawValue:)) else {
                // JS reads `via` AFTER the terminal check, so a relinquished
                // session answers an unknown via like any other input; the
                // typed port cannot be handed one, and its relinquished answer
                // does not read the input, so any play stands in for it.
                if phase == .relinquished { return encode(transition(phase, .userPlay(via: .tap), hold)) }
                return .threw("RangeError")
            }
            typed = .userPlay(via: via)
        case .sessionResult:
            typed = .sessionResult(ok: isTrue(input["ok"]), token: input["token"].stringValue)
        case .pause: typed = .pause
        case .beat: typed = .beat
        case .narration: typed = .narration
        case .background: typed = .background
        case .holdExpired:
            typed = .holdExpired(running: isTrue(input["running"]))
        case .interruptionBegan:
            typed = .interruptionBegan(reason: SessionPolicy.interruptionReason(input["reason"].stringValue),
                                       running: isTrue(input["running"]),
                                       activatedInProcess: isTrue(input["activatedInProcess"]))
        case .interruptionEnded:
            typed = .interruptionEnded(shouldResume: isTrue(input["shouldResume"]), wasPlaying: isTrue(input["wasPlaying"]))
        case .mediaServicesReset: typed = .mediaServicesReset
        case .relinquish: typed = .relinquish
        case .close: typed = .close
        case .finalEnd: typed = .finalEnd
        case .dataDeletion: typed = .dataDeletion
        }
        return encode(transition(phase, typed, hold))
    }

    /// `{phase, actions, row, reason}`; an absent row or reason is null.
    static func encode(_ t: SessionPolicy.Transition) -> CallOutcome {
        .returned(.object([
            "phase": .string(t.phase.rawValue),
            "actions": strings(t.actions.map(\.rawValue)),
            "row": t.row.map { JSValue.string($0.rawValue) } ?? .null,
            "reason": t.reason.map { JSValue.string($0) } ?? .null
        ]))
    }

    static func strings(_ values: [String]) -> JSValue {
        .array(values.map { JSValue.string($0) })
    }
}

/// The `session-invariant` family: `audibleStartViolations` against
/// `SessionPolicy.audibleStartViolations`.
public enum SessionInvariantFamily {
    public typealias Checker = (SessionPolicy.Phase, [String]) -> [SessionPolicy.Violation]

    public static let runner = SessionInvariantFamily.makeRunner(checker: {
        SessionPolicy.audibleStartViolations(sessionAtEntry: $0, turn: $1)
    })

    /// Over any checker, for the mutation tests (see `SessionFamily.makeRunner(transition:)`).
    public static func makeRunner(checker: @escaping Checker) -> PureFamilyRunner {
        PureFamilyRunner(
            family: "session-invariant",
            module: SessionFamily.module,
            reads: ["AUDIBLE_COMMANDS": SessionFamily.strings(SessionPolicy.audibleCommands)],
            calls: [
                "audibleStartViolations": { args in
                    // Phase first (RangeError), then the turn's shape (TypeError), as the JS checks.
                    guard let phase = ArgReading.arg(args, 0).stringValue.flatMap(SessionPolicy.Phase.init(rawValue:)) else {
                        return .threw("RangeError")
                    }
                    guard case let .array(items) = ArgReading.arg(args, 1) else { return .threw("TypeError") }
                    var turn: [String] = []
                    for item in items {
                        guard case let .string(cmd) = item else { return .threw("TypeError") }
                        turn.append(cmd)
                    }
                    return .returned(.array(checker(phase, turn).map {
                        JSValue.object(["at": .number(Double($0.at)), "cmd": .string($0.cmd)])
                    }))
                }
            ])
    }
}

/// The `engine-mode` family: `decideEngineMode` and `engineModeTrace`
/// against `EngineMode.decide` and `EngineMode.trace`.
///
/// The stored values are read the way the JS reads them, which is also the
/// way NE-17 reads the engine-private UserDefaults keys: a strike count that
/// is not a positive whole number is 0, a pin that is not a non-empty string
/// is none, an override outside the closed set is `auto`.
public enum EngineModeFamily {
    public static let runner = PureFamilyRunner(
        family: "engine-mode",
        module: SessionFamily.module,
        reads: [
            "STRIKE_LIMIT": .number(Double(EngineMode.strikeLimit)),
            "ENGINE_MODE_EVENTS": SessionFamily.strings(EngineMode.EventKind.allCases.map(\.rawValue)),
            "MODE_OVERRIDES": SessionFamily.strings(EngineMode.Override.allCases.map(\.rawValue))
        ],
        calls: [
            "decideEngineMode": { args in
                let i = ArgReading.arg(args, 0)
                let decision = EngineMode.decide(EngineMode.Inputs(
                    buildDefault: i["buildDefault"].stringValue.flatMap(EngineMode.BuildDefault.init(rawValue:)),
                    modeOverride: EngineMode.Override.stored(i["override"].stringValue),
                    sentinelWasSet: i["sentinelWasSet"] == .bool(true),
                    strikes: try EngineModeFamily.strikes(i["strikes"]),
                    stickyLegacyBuild: i["stickyLegacyBuild"].stringValue,
                    currentBuild: i["currentBuild"].stringValue ?? "",
                    built: i["built"] == .bool(true)))
                return .returned(.object([
                    "mode": .string(decision.mode.rawValue),
                    "reason": .string(decision.reason.rawValue),
                    "strikes": .number(Double(decision.strikes)),
                    "stickyLegacyBuild": decision.stickyLegacyBuild.map { JSValue.string($0) } ?? .null,
                    "writeSentinel": .bool(decision.writeSentinel)
                ]))
            },
            "engineModeTrace": { args in
                let stored = ArgReading.arg(args, 0)
                let initial = EngineMode.Stored(
                    modeOverride: EngineMode.Override.stored(stored["override"].stringValue),
                    strikes: try EngineModeFamily.strikes(stored["strikes"]),
                    sentinel: stored["sentinel"] == .bool(true),
                    stickyLegacyBuild: stored["stickyLegacyBuild"].stringValue)
                guard case let .array(raw) = ArgReading.arg(args, 1) else { return .threw("TypeError") }
                var events: [EngineMode.Event] = []
                for e in raw {
                    guard let kind = e["kind"].stringValue.flatMap(EngineMode.EventKind.init(rawValue:)) else {
                        return .threw("RangeError")
                    }
                    switch kind {
                    case .launch:
                        events.append(.launch(buildDefault: e["buildDefault"].stringValue.flatMap(EngineMode.BuildDefault.init(rawValue:)),
                                              currentBuild: e["currentBuild"].stringValue ?? "",
                                              built: e["built"] == .bool(true)))
                    case .healthy: events.append(.healthy)
                    case .pageHealth: events.append(.pageHealth)
                    case .setOverride:
                        guard let mode = e["mode"].stringValue.flatMap(EngineMode.Override.init(rawValue:)) else {
                            return .threw("RangeError")
                        }
                        events.append(.setOverride(mode))
                    }
                }
                return .returned(.array(EngineMode.trace(from: initial, events: events).map { (step: EngineMode.Step) -> JSValue in
                    .object([
                        "kind": .string(step.kind.rawValue),
                        "mode": step.mode.map { JSValue.string($0.rawValue) } ?? .null,
                        "reason": step.reason.map { JSValue.string($0.rawValue) } ?? .null,
                        "override": .string(step.stored.modeOverride.rawValue),
                        "strikes": .number(Double(step.stored.strikes)),
                        "sentinel": .bool(step.stored.sentinel),
                        "stickyLegacyBuild": step.stored.stickyLegacyBuild.map { JSValue.string($0) } ?? .null
                    ])
                }))
            }
        ])

    /// `Number.isInteger(strikes) && strikes > 0 ? strikes : 0`. A whole
    /// number too large for an Int has no Swift spelling (it fails the case).
    static func strikes(_ value: JSValue) throws -> Int {
        guard case let .number(n) = value, n.isFinite, n.rounded(.towardZero) == n, n > 0 else { return 0 }
        guard let whole = Int(exactly: n) else { throw ArgReading.notRepresentable("a strike count", value) }
        return whole
    }
}

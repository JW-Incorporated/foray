import Foundation
import ForayEngineCore

/// The `diag-tokens` family against `Vocabulary` (ForayEngineCore/Diag):
/// the seven closed sets as the generator wrote them (NE-04), and
/// `Vocabulary.admit` against player/engine-vocabulary.js `admitToken`
/// (card NE-10s, which owns the port the family's ids were tagged with).
///
/// The reads are the ENUMS, not `Vocabulary.sets`: a Swift emitter spells a
/// token through `Vocabulary.StopCause.graceExpired`, so the enum's cases, in
/// declaration order, are what has to match the JS array.
///
/// Translation only: `admitToken(set, token)` reads `typeof set === "string"`
/// and `typeof token === "string"`, so anything that is not a string is nil
/// here, and the port decides what nil means (a RangeError for the set, a
/// refusal for the token).
public enum DiagTokensFamily {
    public static let module = "player/engine-vocabulary.js"

    public static let runner = PureFamilyRunner(
        family: "diag-tokens",
        module: DiagTokensFamily.module,
        reads: [
            "VOCABULARY_SETS": DiagTokensFamily.strings(Vocabulary.setNames),
            "STAGES": DiagTokensFamily.strings(Vocabulary.Stage.allCases.map(\.rawValue)),
            "SESSION_ERRORS": DiagTokensFamily.strings(Vocabulary.SessionError.allCases.map(\.rawValue)),
            "INTERRUPTION_REASONS": DiagTokensFamily.strings(Vocabulary.InterruptionReason.allCases.map(\.rawValue)),
            "STOP_CAUSES": DiagTokensFamily.strings(Vocabulary.StopCause.allCases.map(\.rawValue)),
            "SOURCES": DiagTokensFamily.strings(Vocabulary.Source.allCases.map(\.rawValue)),
            "MODE_REASONS": DiagTokensFamily.strings(Vocabulary.ModeReason.allCases.map(\.rawValue)),
            "FAULT_KINDS": DiagTokensFamily.strings(Vocabulary.FaultKind.allCases.map(\.rawValue))
        ],
        calls: [
            "admitToken": { args in
                let set = args.count > 0 ? args[0].stringValue : nil
                let token = args.count > 1 ? args[1].stringValue : nil
                do {
                    let admitted = try Vocabulary.admit(token, into: set)
                    return .returned(admitted.map { JSValue.string($0) } ?? .null)
                } catch is Vocabulary.UnknownSet {
                    return .threw("RangeError")
                }
            }
        ])

    static func strings(_ values: [String]) -> JSValue {
        .array(values.map { JSValue.string($0) })
    }
}

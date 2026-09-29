import Foundation
import ForayEngineCore

/// The `seek-policy` family against `SeekPolicy` (ForayEngineCore/Policy),
/// card NE-28s, from the cases `player/seek-policy.js` recorded (NE-28j):
/// ADR-0007's ladder, ADR-0008's pad and the ladder AT LOAD
/// (`segmentLoadGate`, with the synthetic DAI table).
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION. Each mapping is the line
/// of JS that reads the field:
///
///   `seekPrecision(item, ctx = {})`      a missing ctx is `{}`; null THROWS
///   `isLocalFile = false`, `allowAdPad`  truthiness
///   `item?.dai_suspected`                truthiness; a null item is static
///   `source = FOREIGN`                   absent -> "foreign"; only the string
///                                        "own" is OWN, so a non-string maps
///                                        to nil (never equal)
///   `typeof x === "number"`              durations and the pad: nil for any
///                                        non-number; NaN and the infinities
///                                        pass through as themselves
///   `segmentLoadGate(item, {...} = {})`  `item?.needs_drift_check` truthiness;
///                                        `item.ad_pad_sec ?? undefined`
public enum SeekPolicyFamily {
    public static let module = "player/seek-policy.js"

    public static let runner = PureFamilyRunner(
        family: "seek-policy",
        module: SeekPolicyFamily.module,
        reads: [
            "DRIFT_TOLERANCE_SEC": .number(SeekPolicy.driftToleranceSec),
            "AD_PAD_CEILING_SEC": .number(SeekPolicy.adPadCeilingSec),
            "OWN": .string(SeekPolicy.own),
            "FOREIGN": .string(SeekPolicy.foreign),
            "EXACT": .string(SeekPolicy.Precision.exact.rawValue),
            "APPROXIMATE": .string(SeekPolicy.Precision.approximate.rawValue),
            "PADDED": .string(SeekPolicy.Precision.padded.rawValue)
        ],
        calls: [
            "seekPrecision": { args in
                guard let verdict = SeekPolicyFamily.verdict(args) else { return .threw("TypeError") }
                return .returned(SeekPolicyFamily.encode(verdict))
            },
            "canSeekExactly": { args in
                guard let verdict = SeekPolicyFamily.verdict(args) else { return .threw("TypeError") }
                return .returned(.bool(SeekPolicy.canSeekExactly(verdict)))
            },
            "canPlaySegment": { args in
                guard let verdict = SeekPolicyFamily.verdict(args) else { return .threw("TypeError") }
                return .returned(.bool(SeekPolicy.canPlaySegment(verdict)))
            },
            "locateStep": { _ in
                let step = SeekPolicy.locateStep()
                return .returned(.object(["implemented": .bool(step.implemented), "reason": .string(step.reason)]))
            },
            "segmentLoadGate": SeekPolicyFamily.segmentLoadGate
        ])

    /// `seekPrecision(item, ctx = {})`, or nil for "destructuring null threw".
    static func verdict(_ args: [JSValue]) -> SeekPolicy.Verdict? {
        let item = ArgReading.arg(args, 0)
        guard let ctx = ArgReading.objectParam(ArgReading.arg(args, 1), hasDefault: true) else { return nil }
        let source: String?
        switch ctx["source"] {
        case .undefined: source = SeekPolicy.foreign
        case let .string(text): source = text
        default: source = nil
        }
        return SeekPolicy.seekPrecision(daiSuspected: item["dai_suspected"].isTruthy,
                                        isLocalFile: ctx["isLocalFile"].isTruthy,
                                        source: source,
                                        observedDuration: ctx["observedDuration"].numberValue,
                                        recordedDuration: ctx["recordedDuration"].numberValue,
                                        adPadSec: ctx["adPadSec"].numberValue,
                                        allowAdPad: ctx["allowAdPad"].isTruthy)
    }

    /// `{precision, reason}`, plus `padSec` when padded.
    static func encode(_ verdict: SeekPolicy.Verdict) -> JSValue {
        var fields: [String: JSValue] = ["precision": .string(verdict.precision.rawValue), "reason": .string(verdict.reason)]
        if let pad = verdict.padSec { fields["padSec"] = .number(pad) }
        return .object(fields)
    }

    /// `segmentLoadGate(item, { observedDuration, isLocalFile = false, allowAdPad = false } = {})`.
    static func segmentLoadGate(_ args: [JSValue]) throws -> CallOutcome {
        let item = ArgReading.arg(args, 0)
        guard let opts = ArgReading.objectParam(ArgReading.arg(args, 1), hasDefault: true) else { return .threw("TypeError") }
        let gate = SeekPolicy.segmentLoadGate(needsDriftCheck: item["needs_drift_check"].isTruthy,
                                              daiSuspected: item["dai_suspected"].isTruthy,
                                              referenceDurationSec: item["reference_duration_sec"].numberValue,
                                              adPadSec: item["ad_pad_sec"].numberValue,
                                              observedDuration: opts["observedDuration"].numberValue,
                                              isLocalFile: opts["isLocalFile"].isTruthy,
                                              allowAdPad: opts["allowAdPad"].isTruthy)
        var fields: [String: JSValue] = ["ok": .bool(gate.ok)]
        if let reason = gate.reason { fields["reason"] = .string(reason) }
        if let note = gate.note { fields["note"] = .string(note) }
        return .returned(.object(fields))
    }
}

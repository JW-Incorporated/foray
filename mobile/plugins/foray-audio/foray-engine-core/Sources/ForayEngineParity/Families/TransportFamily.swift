import Foundation
import ForayEngineCore

/// The `transport` family against `TransportPolicy` (ForayEngineCore/Policy),
/// from the cases `player/transport-policy.js` recorded (NE-08).
///
/// Most of these functions take ONE destructured object with no default
/// (`resolveToggle({want, ...})`), so a missing or null argument throws a
/// TypeError before the rule runs; `ArgReading.objectParam` says so. Beyond
/// that, each field is read the way its line of JS reads it (truthiness,
/// `=== "ended"`, `typeof n === "number"`, or arithmetic, which coerces), and
/// a value the typed port cannot carry fails the case (see `ArgReading`).
public enum TransportFamily {
    public static let module = "player/transport-policy.js"

    public static let runner = PureFamilyRunner(
        family: "transport",
        module: TransportFamily.module,
        reads: [
            "RESTART_WINDOW_SEC": .number(TransportPolicy.restartWindowSec),
            "SEEK_INSIDE_END_SEC": .number(TransportPolicy.seekInsideEndSec),
            "SEEK_END_GUARD_SEC": .number(TransportPolicy.seekEndGuardSec)
        ],
        calls: [
            "endedPlayAction": TransportFamily.endedPlayAction,
            "resolveToggle": TransportFamily.resolveToggle,
            "previousAction": TransportFamily.previousAction,
            "episodePreviousRestarts": TransportFamily.episodePreviousRestarts,
            "clampEpisodeTarget": TransportFamily.clampEpisodeTarget,
            "skipTarget": TransportFamily.skipTarget,
            "nudgeAction": TransportFamily.nudgeAction,
            "seekAction": TransportFamily.seekAction,
            "sourceOffsetFor": TransportFamily.sourceOffsetFor,
            "scrubTarget": TransportFamily.scrubTarget,
            "remoteStopAction": TransportFamily.remoteStopAction
        ])

    /// The one object parameter, or nil for "throws a TypeError".
    static func param(_ args: [JSValue]) -> JSValue? {
        ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: false)
    }

    /// A queue item as `sourceOffsetFor` / `itemRuntimeSec` read it: `!item`
    /// is no item; each number by `typeof` (isNum / Number.isFinite, no
    /// coercion); `item.kind === TTS`; `!item.audio_url` by truthiness.
    static func item(_ value: JSValue) -> TransportPolicy.Item? {
        guard value.isTruthy else { return nil }
        return TransportPolicy.Item(
            startSec: value["start_sec"].numberValue,
            endSec: value["end_sec"].numberValue,
            authoredEndSec: value["authored_end_sec"].numberValue,
            durationSec: value["duration_sec"].numberValue,
            kind: value["kind"].stringValue,
            hasAudioUrl: value["audio_url"].isTruthy)
    }

    static func token<T: RawRepresentable>(_ value: T?) -> CallOutcome where T.RawValue == String {
        .returned(value.map { JSValue.string($0.rawValue) } ?? JSValue.null)
    }

    /// `endedPlayAction({ foray, stateType })`.
    static func endedPlayAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return token(TransportPolicy.endedPlayAction(foray: s["foray"].isTruthy,
                                                     stateType: ArgReading.string(s["stateType"])))
    }

    /// `resolveToggle({ want, restored, foray, stateType, running, hasCurrent, queueLength })`.
    /// `want === running` is a STRICT comparison, so both must be real booleans.
    static func resolveToggle(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let want = try ArgReading.strictBool(s["want"], "resolveToggle's want")
        let running = try ArgReading.strictBool(s["running"], "resolveToggle's running")
        return token(TransportPolicy.resolveToggle(
            want: want,
            restored: s["restored"].isTruthy,
            foray: s["foray"].isTruthy,
            stateType: ArgReading.string(s["stateType"]),
            running: running,
            hasCurrent: s["hasCurrent"].isTruthy,
            queueLength: s["queueLength"].numberValue)) // `=== 0`: only a number can be 0
    }

    /// `previousAction({ index, positionSec, segmentStartSec })`:
    /// `positionSec == null` (loose, so undefined too) is the jump in flight;
    /// otherwise `index > 0` and `positionSec - segmentStartSec` are
    /// ARITHMETIC, so they coerce (a null start is 0, a missing one NaN).
    static func previousAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let position = s["positionSec"]
        return token(TransportPolicy.previousAction(index: s["index"].toNumber,
                                                    positionSec: position.isNullish ? nil : position.toNumber,
                                                    segmentStartSec: s["segmentStartSec"].toNumber))
    }

    /// `episodePreviousRestarts({ positionSec })`: `positionSec >= 4` against
    /// a number coerces (null is 0, undefined NaN, a string its ToNumber).
    static func episodePreviousRestarts(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return .returned(.bool(TransportPolicy.episodePreviousRestarts(positionSec: s["positionSec"].toNumber)))
    }

    /// `clampEpisodeTarget(seconds, dur)`: `Number(seconds)`, then `dur ? ...`.
    static func clampEpisodeTarget(_ args: [JSValue]) throws -> CallOutcome {
        let duration = try ArgReading.truthyNumber(ArgReading.arg(args, 1), "clampEpisodeTarget's dur")
        let target = TransportPolicy.clampEpisodeTarget(ArgReading.arg(args, 0).toNumber, duration: duration)
        return .returned(ArgReading.numberOrNull(target))
    }

    /// `skipTarget({ foray, positionSec, offsetSec, durationSec = null })`.
    /// `positionSec + offset` would CONCATENATE a string, so the position must
    /// be a number; `Number(offsetSec || 0)` reads the offset by truthiness.
    /// The duration is read by truthiness on an episode (`dur ? ...`) and by
    /// `> 0` in a Foray; every falsy value fails both, so one reading serves.
    static func skipTarget(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        guard let position = s["positionSec"].numberValue else {
            throw ArgReading.notRepresentable("skipTarget's positionSec", s["positionSec"])
        }
        let offset = try ArgReading.truthyNumber(s["offsetSec"], "skipTarget's offsetSec")
        let duration = try ArgReading.truthyNumber(s["durationSec"], "skipTarget's durationSec")
        let target = TransportPolicy.skipTarget(foray: s["foray"].isTruthy, positionSec: position,
                                                offsetSec: offset, durationSec: duration)
        return .returned(ArgReading.numberOrNull(target))
    }

    /// `nudgeAction({ offsetSec, landsInCurrentItem, narrationPlayhead, onLastItem })`:
    /// the three flags by truthiness; `offsetSec < 0` coerces.
    static func nudgeAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return token(TransportPolicy.nudgeAction(offsetSec: s["offsetSec"].toNumber,
                                                 landsInCurrentItem: s["landsInCurrentItem"].isTruthy,
                                                 narrationPlayhead: s["narrationPlayhead"].isTruthy,
                                                 onLastItem: s["onLastItem"].isTruthy))
    }

    /// `seekAction({ restored, stateType })`.
    static func seekAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return token(TransportPolicy.seekAction(restored: s["restored"].isTruthy,
                                                stateType: ArgReading.string(s["stateType"])))
    }

    /// `sourceOffsetFor(item, into)`: `Number.isFinite(into)` does not coerce.
    static func sourceOffsetFor(_ args: [JSValue]) throws -> CallOutcome {
        let offset = TransportPolicy.sourceOffset(for: item(ArgReading.arg(args, 0)),
                                                  into: ArgReading.arg(args, 1).numberValue)
        return .returned(ArgReading.numberOrNull(offset))
    }

    /// `scrubTarget({ at, item, currentIndex, stateType })`: `!at` is nowhere;
    /// `at.index` is passed through, so it must be a number;
    /// `at.index !== currentIndex` is strict, so a non-number index is nil.
    static func scrubTarget(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let at = s["at"]
        guard at.isTruthy else { return .returned(.null) }
        guard let index = at["index"].numberValue else {
            throw ArgReading.notRepresentable("scrubTarget's at.index", at["index"])
        }
        let scrub = TransportPolicy.scrubTarget(atIndex: index, into: at["into"].numberValue, item: item(s["item"]),
                                                currentIndex: s["currentIndex"].numberValue,
                                                stateType: ArgReading.string(s["stateType"]))
        return .returned(.object([
            "index": .number(scrub.index),
            "reload": .bool(scrub.reload),
            "offset": ArgReading.numberOrNull(scrub.offset)
        ]))
    }

    /// `remoteStopAction(details)`: `details?.close === true`.
    static func remoteStopAction(_ args: [JSValue]) throws -> CallOutcome {
        let details = ArgReading.arg(args, 0)
        var close: Bool?
        if !details.isNullish, case let .bool(flag) = details["close"] { close = flag }
        return token(TransportPolicy.remoteStopAction(close: close))
    }
}

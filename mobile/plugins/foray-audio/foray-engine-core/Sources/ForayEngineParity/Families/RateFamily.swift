import Foundation
import ForayEngineCore

/// The `rate` family against `PlaybackRate` (ForayEngineCore/Policy): the
/// ladder, the snap, the upward cycle and the synthesiser's rate, from the
/// cases `player/playback-rate.js` recorded (NE-07j, NE-09).
///
/// TRANSLATION ONLY, as in SeamGapFamily. Every JS function here tests its
/// argument with `typeof v === "number"` (or `typeof m === "number" && m > 0`)
/// before anything else, so the one mapping is: a number is itself, and every
/// other value (null, undefined, "1.5", {}, []) is `nil`, which the port
/// answers exactly as the JS answers a non-number. `utteranceRate` takes a
/// plain Double, as ForayTtsPlugin's does, so a non-number is NaN there: "not
/// a positive number" either way, and the port's guard is what answers it.
/// The READS come from the port, not from EngineConstants directly, so a port
/// that stopped reading the generated ladder would fail a case.
public enum RateFamily {
    public static let module = "player/playback-rate.js"

    public static let runner = PureFamilyRunner(
        family: "rate",
        module: RateFamily.module,
        reads: [
            "RATES": .array(PlaybackRate.rates.map { JSValue.number($0) }),
            "DEFAULT_RATE": .number(PlaybackRate.defaultRate),
            "MIN_RATE": .number(PlaybackRate.minRate),
            "MAX_RATE": .number(PlaybackRate.maxRate)
        ],
        calls: [
            "isRate": { args in .returned(.bool(PlaybackRate.isRate(RateFamily.number(args.first)))) },
            "normalizeRate": { args in .returned(.number(PlaybackRate.normalize(RateFamily.number(args.first)))) },
            "nextRate": { args in .returned(.number(PlaybackRate.next(RateFamily.number(args.first)))) },
            "utteranceRate": { args in
                let multiplier = RateFamily.number(args.first) ?? .nan
                return .returned(.number(PlaybackRate.utteranceRate(playbackMultiplier: multiplier)))
            }
        ])

    /// `typeof v === "number" ? v : <not a number>`.
    static func number(_ value: JSValue?) -> Double? {
        (value ?? .undefined).numberValue
    }
}

import Foundation

/// Can a timestamp be trusted, and may a Foray segment load on the copy in
/// hand? The Swift port of `player/seek-policy.js` (card NE-28s; the fixtures
/// are NE-28j's `seek-policy` family, `seek-precision.json` and
/// `load-gate.json`). The JS header is the reference for every reason:
/// corner case #2 (dynamic ad insertion), the own/foreign split from #22,
/// ADR-0007's ladder and ADR-0008's pad.
///
///   1. local downloaded file                -> EXACT, the timeline is frozen
///   2. not DAI                              -> EXACT via start_sec
///   3. DAI, |observed - reference| <= 30 s  -> EXACT, the ad load matches
///   4. DAI, drifted                         -> the locate step (not built)
///   5. unresolvable                         -> APPROXIMATE: the segment is
///                                              SKIPPED, never played at the
///                                              wrong place
///
/// with ADR-0008's pad (off unless opted in) between 3 and 5: a pad within
/// the 120 s ceiling that bounds this copy's ad load plays PADDED (the stop
/// extends; the start never moves).
///
/// The rendering half (`formatTimestamp`, `describeTimestamp`) is the page's:
/// the native engine never prints a timestamp.
///
/// Every parameter is typed. `nil` for a duration or a pad stands for every
/// value JavaScript's `typeof x === "number"` rejects; NaN and the infinities
/// ARE numbers there, so they come in as themselves and take the branch JS
/// takes with them.
public enum SeekPolicy {
    /// `OWN` / `FOREIGN`: where a timestamp came from.
    public static let own: String = EngineConstants.SeekPolicy.own
    public static let foreign: String = EngineConstants.SeekPolicy.foreign

    /// `DRIFT_TOLERANCE_SEC` (authored 30): how far the copy in hand may drift
    /// from the reference before the ad load is said to have changed. Never
    /// widened for the pad (ADR-0008).
    public static let driftToleranceSec: Double = EngineConstants.SeekPolicy.driftToleranceSec
    /// `AD_PAD_CEILING_SEC` (authored 120): the ceiling on ADR-0008's pad.
    public static let adPadCeilingSec: Double = EngineConstants.SeekPolicy.adPadCeilingSec

    /// `EXACT` / `APPROXIMATE` / `PADDED`.
    public enum Precision: String, CaseIterable, Sendable {
        case exact
        case approximate
        case padded
    }

    /// What `seekPrecision` returns: `{precision, reason}`, plus `padSec` when
    /// the answer is PADDED.
    public struct Verdict: Equatable, Sendable {
        public let precision: Precision
        public let reason: String
        public let padSec: Double?

        public init(precision: Precision, reason: String, padSec: Double? = nil) {
            self.precision = precision
            self.reason = reason
            self.padSec = padSec
        }
    }

    /// `locateStep()`: ADR-0007 rung 4 / ADR-0008's locate step, a named,
    /// tested absence. Every caller that reaches it lands on rung 5.
    public struct LocateStep: Equatable, Sendable {
        public let implemented: Bool
        public let reason: String
    }

    public static func locateStep() -> LocateStep {
        LocateStep(implemented: false,
                   reason: "anchor resolution (ADR-0007 rung 4 / ADR-0008's locate step) is not implemented — segment skipped rather than played at a stale offset")
    }

    /// `seekPrecision(item, ctx)`.
    ///
    /// - Parameters:
    ///   - daiSuspected: `item?.dai_suspected`, by truthiness.
    ///   - isLocalFile: `ctx.isLocalFile`, by truthiness (default false).
    ///   - source: `ctx.source` when it is a string (default `FOREIGN`); only
    ///     an exact `"own"` is the listener's own marker.
    ///   - observedDuration / recordedDuration: the copy in hand's duration and
    ///     the reference's, nil when not a number.
    ///   - adPadSec: ADR-0008's pad, nil when not a number.
    ///   - allowAdPad: the opt-in, by truthiness (default false: the ADR's
    ///     open question 2 is unanswered).
    public static func seekPrecision(daiSuspected: Bool, isLocalFile: Bool = false, source: String? = foreign,
                                     observedDuration: Double? = nil, recordedDuration: Double? = nil,
                                     adPadSec: Double? = nil, allowAdPad: Bool = false) -> Verdict {
        if isLocalFile { return Verdict(precision: .exact, reason: "local file") }
        if !daiSuspected { return Verdict(precision: .exact, reason: "static enclosure") }

        if source == own {
            if let observed = observedDuration, let recorded = recordedDuration,
               Swift.abs(observed - recorded) > driftToleranceSec {
                return Verdict(precision: .approximate,
                               reason: "ad load changed (\(whole(Swift.abs(observed - recorded)))s duration drift)")
            }
            return Verdict(precision: .exact, reason: "listener's own marker on their own copy")
        }

        // Rung 3: the ad load in the copy in hand matches the reference.
        if let observed = observedDuration, observed.isFinite, let recorded = recordedDuration, recorded.isFinite {
            let drift = Swift.abs(observed - recorded)
            if drift <= driftToleranceSec {
                return Verdict(precision: .exact,
                               reason: "ad load matches the reference copy (\(whole(drift))s duration drift)")
            }
        }

        // ADR-0008's pad: the ceiling is on the PAD, and the pad must bound
        // this copy's ad load. It extends the STOP only.
        if allowAdPad, let pad = adPadSec, pad.isFinite, pad > 0 {
            if pad > adPadCeilingSec {
                return Verdict(precision: .approximate,
                               reason: "LOCATE-REQUIRED: \(whole(pad))s pad exceeds the \(whole(adPadCeilingSec))s ceiling (ADR-0008)")
            }
            if let observed = observedDuration, observed.isFinite, let recorded = recordedDuration, recorded.isFinite {
                let load = Swift.abs(observed - recorded)
                if load > pad {
                    return Verdict(precision: .approximate,
                                   reason: "this copy carries \(whole(load))s of ad load, beyond the \(whole(pad))s the pad bounds (ADR-0008)")
                }
            }
            return Verdict(precision: .padded,
                           reason: "PADDABLE: \(whole(pad))s pad within the \(whole(adPadCeilingSec))s ceiling (ADR-0008)",
                           padSec: pad)
        }

        return Verdict(precision: .approximate, reason: "dynamic ad insertion; \(locateStep().reason)")
    }

    /// `canSeekExactly(item, ctx)`: only EXACT is a hard seek.
    public static func canSeekExactly(_ verdict: Verdict) -> Bool {
        verdict.precision == .exact
    }

    /// `canPlaySegment(item, ctx)`: exact plays, padded plays with an extended
    /// stop, approximate is skipped.
    public static func canPlaySegment(_ verdict: Verdict) -> Bool {
        verdict.precision != .approximate
    }

    /// What `segmentLoadGate` answers: `{ok: true}`, `{ok: true, note}` or
    /// `{ok: false, reason}`.
    public struct LoadGate: Equatable, Sendable {
        public let ok: Bool
        public let reason: String?
        public let note: String?

        public static let allowed = LoadGate(ok: true, reason: nil, note: nil)
        public static func refused(_ reason: String) -> LoadGate { LoadGate(ok: false, reason: reason, note: nil) }
        public static func noted(_ note: String) -> LoadGate { LoadGate(ok: true, reason: nil, note: note) }
    }

    /// `segmentLoadGate(item, {observedDuration, isLocalFile, allowAdPad})`:
    /// the ladder AT LOAD, once the copy in hand reports its duration. The
    /// native engine loads built Foray items itself and asks the same question
    /// the manager's `_segmentGate` asks.
    ///
    /// Only an item the builder flagged (`needs_drift_check`) is checked; the
    /// rest were settled at build. A flagged item whose copy reports no finite
    /// duration cannot be compared, so it does not load. Otherwise the answer
    /// is the ladder's, with the source always FOREIGN (a segment boundary was
    /// authored against somebody else's copy).
    ///
    /// - Parameters:
    ///   - needsDriftCheck / daiSuspected: the built item's flags, by truthiness.
    ///   - referenceDurationSec: `item.reference_duration_sec`, nil when not a number.
    ///   - adPadSec: `item.ad_pad_sec`, nil when not a number.
    ///   - observedDuration: the copy in hand's duration, nil when not a number.
    public static func segmentLoadGate(needsDriftCheck: Bool, daiSuspected: Bool, referenceDurationSec: Double?,
                                       adPadSec: Double?, observedDuration: Double?,
                                       isLocalFile: Bool = false, allowAdPad: Bool = false) -> LoadGate {
        if !needsDriftCheck { return .allowed }
        guard let observed = observedDuration, observed.isFinite else {
            return .refused("the copy in hand reports no duration, so the ad load cannot be compared to the reference")
        }
        let verdict = seekPrecision(daiSuspected: daiSuspected, isLocalFile: isLocalFile, source: foreign,
                                    observedDuration: observed, recordedDuration: referenceDurationSec,
                                    adPadSec: adPadSec, allowAdPad: allowAdPad)
        if verdict.precision == .approximate { return .refused(verdict.reason) }
        return .noted("\(verdict.precision.rawValue) — \(verdict.reason)")
    }

    /// `${Math.round(x)}`: JavaScript's rounding (ties up), printed as
    /// JavaScript prints a number.
    static func whole(_ value: Double) -> String {
        JSWriter.numberToString(JSMath.round(value))
    }
}

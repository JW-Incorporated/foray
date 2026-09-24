import Foundation

/// The playback-speed ladder and the synthesiser's rate: the Swift port of
/// `player/playback-rate.js`, which is the reference (NE-09). The `rate`
/// parity family (player/parity/fixtures/rate) is the contract between them,
/// and playback-rate.js's header is where the ladder's reasons live (copied
/// from the major podcast apps; one stop below 1x; 2x is the top because a
/// Foray pays per seam, #224).
///
/// Every number here is READ from the generated `EngineConstants.PlaybackRate`
/// (NE-04), never retyped: a port holding its own 2.0 is the silent fork the
/// generator exists to prevent (plan §8 R6).
///
/// `nil` in a parameter stands for every value JavaScript's
/// `typeof v === "number"` rejects (absent, null, a string): the engine gets
/// its rate from the bridge as JSON, and "not a number at all" is one of the
/// inputs the JS rules answer on purpose.
public enum PlaybackRate {
    /// `RATES`, ascending.
    public static let rates: [Double] = EngineConstants.PlaybackRate.rates
    /// `DEFAULT_RATE`: 1x, and the answer to every unusable input.
    public static let defaultRate: Double = EngineConstants.PlaybackRate.defaultRate
    /// `MIN_RATE` and `MAX_RATE`: the ends of the ladder.
    public static let minRate: Double = EngineConstants.PlaybackRate.minRate
    public static let maxRate: Double = EngineConstants.PlaybackRate.maxRate

    /// `isRate(v)`: exactly one of the stops. Strict, as in JS: a value that
    /// is not a finite number is never a rate.
    public static func isRate(_ value: Double?) -> Bool {
        guard let value, value.isFinite else { return false }
        return rates.contains(value)
    }

    /// `normalizeRate(v)`: any value onto the ladder. SNAPS rather than
    /// rejects: a finite positive number lands on the NEAREST stop, a number
    /// past either end CLAMPS to that end, and only a value that is not a
    /// usable number at all (nil, NaN, an infinity, 0, negative) falls back to
    /// 1x. A tie between two stops keeps the LOWER one, because the JS loop
    /// only replaces its best on a strictly smaller distance.
    public static func normalize(_ value: Double?) -> Double {
        guard let value, value.isFinite, value > 0 else { return defaultRate }
        if value <= minRate { return minRate }
        if value >= maxRate { return maxRate }
        var best = rates[0]
        for stop in rates {
            if Swift.abs(stop - value) < Swift.abs(best - value) { best = stop }
        }
        return best
    }

    /// `nextRate(v)`: the next stop up, wrapping from the top to the slowest.
    /// Normalises FIRST: the bug the JS header records is `indexOf` answering
    /// -1 for an off-ladder value, which pinned the control to one stop.
    public static func next(_ value: Double?) -> Double {
        let current = normalize(value)
        let at = rates.firstIndex(of: current) ?? 0
        return rates[(at + 1) % rates.count]
    }

    /// What a `setRate` does with the value it was handed: the rate it
    /// applies, and whether that differs from what was asked for.
    public struct Snap: Equatable {
        public let applied: Double
        /// True when the request was not exactly a stop, i.e. the manager's
        /// `if (!isRate(rate))` branch.
        public let snapped: Bool

        public init(applied: Double, snapped: Bool) {
            self.applied = applied
            self.snapped = snapped
        }
    }

    /// The decision inside `PlayerQueueManager.setRate`: `normalizeRate`, and
    /// `!isRate` for "did we have to change what you asked for?".
    ///
    /// SNAPPING IS NEVER SILENT. The manager writes
    /// `rate.snapped requested=<JSON> applied=<r>` whenever `snapped` is true
    /// (product principle 2: observed, never declared). That row, and the
    /// request's JSON spelling in it, belong to the engine's diagnostics and
    /// are pinned by the manager-episode family (NE-14j records "a snapped
    /// value SAYS so"; NE-14s emits it from this answer). Both halves of the
    /// decision are pinned here by the `rate` family's isRate and
    /// normalizeRate cases.
    public static func snap(_ requested: Double?) -> Snap {
        Snap(applied: normalize(requested), snapped: !isRate(requested))
    }

    // MARK: the synthesiser's rate

    /// `UTTERANCE_MIN_RATE`, `UTTERANCE_DEFAULT_RATE`, `UTTERANCE_MAX_RATE`:
    /// AVFoundation's `AVSpeechUtteranceMinimum/Default/MaximumSpeechRate`.
    /// The core is Foundation-only, so it cannot read the framework's
    /// constants; ForayAudioPluginTests pins these three against AVFAudio.
    public static let utteranceMinRate: Double = EngineConstants.PlaybackRate.utteranceMinRate
    public static let utteranceDefaultRate: Double = EngineConstants.PlaybackRate.utteranceDefaultRate
    public static let utteranceMaxRate: Double = EngineConstants.PlaybackRate.utteranceMaxRate

    /// `utteranceRate(multiplier)`: a playback multiplier to an
    /// `AVSpeechUtterance.rate`, on `ForayTtsPlugin.utteranceRate(playbackMultiplier:)`'s
    /// calibrated curve, whose doc comment carries the reasoning (one device
    /// reading, HUMAN-ACTIONS.md #29; exponential perceived speed; H3 would
    /// settle it). COPIED, number for number and in the same arithmetic order,
    /// so the engine narrates at the speed the shipping plugin does. The
    /// `rate` family's utterance-rate cases hold this port to the JS copy, and
    /// ForayTtsPluginTests holds the plugin to the same cases: one fixture
    /// file, two Swift implementations, no room to drift.
    ///
    /// Not a positive number (0, negative, NaN) -> the slowest rate: a log has
    /// no value there, and `min`/`max` would pass a NaN straight through.
    /// +Infinity survives the guard and clamps to the fastest.
    public static func utteranceRate(playbackMultiplier multiplier: Double) -> Double {
        guard multiplier > 0 else { return utteranceMinRate }
        let anchorRate = utteranceDefaultRate * EngineConstants.PlaybackRate.utteranceCalibrationRequested
        let anchorSpan = anchorRate - utteranceDefaultRate
        let scaled = utteranceDefaultRate
            + anchorSpan * log(multiplier) / log(EngineConstants.PlaybackRate.utteranceCalibrationPerceived)
        return JSMath.min(JSMath.max(scaled, utteranceMinRate), utteranceMaxRate)
    }
}

import Foundation

// ── THE DECK'S GUARDS, AND THE STANDBY DECK'S TWO QUESTIONS (NE-30s) ────────
//
// The first half is the `deck-readings` fixtures NE-30j recorded from
// player/deck-policy.js: what the deck does with a value it is HANDED (a
// seek target, a duck) and what it REPORTS (the duration, the rate) before
// anything acts on it. html-audio-backend.js asks these; AVDeck is handed the
// same values over the bridge and must refuse and clamp them the same way.
//
// The second half is the warm handover's decisions the engine's seams depend
// on (`warmOffset`, `prefetchDecision`, `warmPromotion`). They live in the
// core because the parity driver's standby deck asks them exactly as
// reference-engine.js's WarmingBackend does, and the native DeckPair (NE-32)
// asks the same functions; the `deck-pair` fixtures that pin them case by
// case stay owed to NE-32, which registers them.
extension DeckPolicy {

    // MARK: readings (deck-readings)

    /// `deckSeekTarget(seconds)`: where a seek goes, or nil when the value is
    /// junk and the seek is ignored (not a number, not finite, or negative).
    /// `nil` stands for every value `typeof x === "number"` rejects.
    public static func deckSeekTarget(_ seconds: Double?) -> Double? {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return nil }
        return seconds
    }

    /// `deckVolume(v)`: `Math.min(1, Math.max(0, Number(v) || 0))`. The
    /// argument is `Number(v)` already; NaN (junk) is silence, never a throw.
    public static func deckVolume(_ number: Double) -> Double {
        let value = number.isNaN ? 0 : number
        return JSMath.min(1, JSMath.max(0, value))
    }

    /// `deckDuration(d)`: a finite number, else nil (never NaN, which every
    /// consumer would have to special-case).
    public static func deckDuration(_ duration: Double?) -> Double? {
        guard let duration, duration.isFinite else { return nil }
        return duration
    }

    /// `deckReportedRate({elementRate, pendingRate})`: the element's own rate
    /// when it is a usable one (a finite number above 0), else the rate we
    /// asked for. A rate the engine refused is a rate the lock screen must
    /// not claim.
    public static func deckReportedRate(elementRate: Double?, pendingRate: Double?) -> Double? {
        if let elementRate, elementRate.isFinite, elementRate > 0 { return elementRate }
        return pendingRate
    }

    // MARK: the standby deck (deck-pair; the family is NE-32's)

    /// `warmOffset(startOffset)`: the in-point a warm load is parked at: a
    /// positive finite offset, else 0.
    public static func warmOffset(_ startOffset: Double?) -> Double {
        guard let startOffset, startOffset.isFinite, startOffset > 0 else { return 0 }
        return startOffset
    }

    /// A load held warm on the standby deck.
    public struct Warm: Equatable, Sendable {
        public var itemId: String
        public var url: String
        public var offsetSec: Double
        public var ready: Bool
        public var failed: Bool

        public init(itemId: String, url: String, offsetSec: Double, ready: Bool, failed: Bool) {
            self.itemId = itemId
            self.url = url
            self.offsetSec = offsetSec
            self.ready = ready
            self.failed = failed
        }
    }

    /// `prefetchDecision(...)`'s answers.
    public enum PrefetchDecision: String, CaseIterable, Sendable {
        /// No standby deck, parked, released or stood down.
        case unavailable
        /// Nothing to fetch.
        case noUrl = "no-url"
        /// The next item is in the source the player already holds: the
        /// same-source seek covers that seam, and a refetch could come back
        /// differently stitched.
        case sameEpisode = "same-episode"
        /// The standby deck already holds exactly this (url, offset).
        case already
        /// Warm it.
        case start
    }

    /// `prefetchDecision({available, url, currentUrl, warm, offsetSec})`.
    public static func prefetchDecision(available: Bool, url: String?, currentUrl: String?, warm: Warm?,
                                        offsetSec: Double) -> PrefetchDecision {
        if !available { return .unavailable }
        guard let url, !url.isEmpty else { return .noUrl }
        if url == currentUrl { return .sameEpisode }
        if let warm, warm.url == url, warm.offsetSec == offsetSec, !warm.failed { return .already }
        return .start
    }

    /// `warmPromotion(...)`'s answers: promote, or why not.
    public enum Promotion: String, CaseIterable, Sendable {
        case promote
        case noWarm = "none"
        case notReady = "not-ready"
        case failed
        case differentItem = "different-item"
        case wrongOffset = "wrong-offset"
        case bufferGone = "buffer-gone"
        case drifted
    }

    /// `warmPromotion({warm, url, offsetSec, canPlay, atSec})`: may the warm
    /// deck BECOME the player for the load in front of it? Readiness is
    /// re-asserted at the boundary, never trusted.
    public static func warmPromotion(warm: Warm?, url: String?, offsetSec: Double, canPlay: Bool,
                                     atSec: Double?) -> Promotion {
        guard let warm else { return .noWarm }
        if warm.failed { return .failed }
        if !warm.ready { return .notReady }
        if warm.url != url { return .differentItem }
        if warm.offsetSec != offsetSec { return .wrongOffset }
        if !canPlay { return .bufferGone }
        if Swift.abs((atSec ?? 0) - offsetSec) > settleNearSec { return .drifted }
        return .promote
    }
}

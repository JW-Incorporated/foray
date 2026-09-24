import Foundation

/// The client layer's transport rules: the Swift port of
/// `player/transport-policy.js` (NE-08 lifted them out of client.js closures
/// with no behaviour change, so they could be handed to this port). JS is the
/// reference; the `transport` parity family is the contract, and
/// transport-policy.js's comments are where each rule's reason lives (the
/// audit of 2026-09-22 for start-over, the out-point disarm, the narration
/// scrub; the Android Stop for remote stop).
///
/// QUIRKS ARE PORTED, NOT TIDIED. NE-08 recorded the old inline code as it
/// was, including answers a fresh design would not give (`previousAction` on
/// a narration item is the manager's previous, because `into` is NaN), and a
/// port that "fixes" one here would be a rule change that skipped the JS. A
/// change goes JS first, then a re-record, then this file.
///
/// Every token is a closed `enum` whose raw values are the JS strings (the
/// fixtures compare them, and PolicyPortTests checks them against the
/// generated `EngineConstants.Transport`); every number is read from the
/// generated constants.
public enum TransportPolicy {
    /// `RESTART_WINDOW_SEC`: below this far into an item, previous means the one before.
    public static let restartWindowSec: Double = EngineConstants.Transport.restartWindowSec
    /// `SEEK_INSIDE_END_SEC`: how far inside an item's end a Foray-clock seek lands.
    public static let seekInsideEndSec: Double = EngineConstants.Transport.seekInsideEndSec
    /// `SEEK_END_GUARD_SEC`: an episode seek stops this far short of the end.
    public static let seekEndGuardSec: Double = EngineConstants.Transport.seekEndGuardSec

    /// `TOGGLE`: what a play/pause press does.
    public enum Toggle: String, CaseIterable {
        case playRestored = "play-restored"
        case startOver = "start-over"
        /// `TOGGLE.NONE`. Not named `none`, which Swift would read as
        /// `Optional.none` wherever a `Toggle?` is compared.
        case noChange = "none"
        case load
        case resume
        case pause
    }

    /// `PREVIOUS`: what "previous" does inside a Foray.
    public enum Previous: String, CaseIterable {
        case itemBefore = "item-before"
        case manager = "skip-to-previous"
    }

    /// `SEEK`: where an episode seek goes.
    public enum Seek: String, CaseIterable {
        case pend
        case seek
    }

    /// `REMOTE_STOP`: what a stop from outside the page does.
    public enum RemoteStop: String, CaseIterable {
        case close
        case pause
    }

    /// A queue item as these rules read it. `nil` in a number is every value
    /// `typeof n === "number"` rejects; the rules check finiteness themselves,
    /// as the JS does.
    public struct Item: Equatable {
        public let startSec: Double?
        public let endSec: Double?
        public let authoredEndSec: Double?
        public let durationSec: Double?
        public let kind: String?
        /// `item.audio_url` is truthy: a rendered narration has a file.
        public let hasAudioUrl: Bool

        public init(startSec: Double? = nil, endSec: Double? = nil, authoredEndSec: Double? = nil,
                    durationSec: Double? = nil, kind: String? = nil, hasAudioUrl: Bool = false) {
            self.startSec = startSec
            self.endSec = endSec
            self.authoredEndSec = authoredEndSec
            self.durationSec = durationSec
            self.kind = kind
            self.hasAudioUrl = hasAudioUrl
        }

        /// `itemRuntimeSec(item)` (player/foray-queue.js): how long the item
        /// plays. A slice's authored end (else its end) minus its start; else
        /// a positive `duration_sec`; else 0.
        public var runtimeSec: Double {
            let end = TransportPolicy.isNum(authoredEndSec) ? authoredEndSec : endSec
            if let start = startSec, let end, TransportPolicy.isNum(start), TransportPolicy.isNum(end), end > start {
                return end - start
            }
            if let duration = durationSec, TransportPolicy.isNum(duration), duration > 0 { return duration }
            return 0
        }
    }

    /// foray-queue.js / transport-policy.js `isNum`: a finite number.
    static func isNum(_ value: Double?) -> Bool {
        guard let value else { return false }
        return value.isFinite
    }

    /// JavaScript truthiness of a number: not 0 and not NaN (nil is falsy).
    static func truthy(_ value: Double?) -> Bool {
        guard let value else { return false }
        return value != 0 && !value.isNaN
    }

    // MARK: play/pause

    /// `endedPlayAction({foray, stateType})`: a FINISHED Foray starts over;
    /// nil when the ordinary resume applies.
    public static func endedPlayAction(foray: Bool, stateType: String?) -> Toggle? {
        foray && stateType == "ended" ? .startOver : nil
    }

    /// `resolveToggle(...)`: the decision inside every play/pause press. The
    /// ORDER is the rule: a restored bar wins; a finished Foray starts over; a
    /// press asking for what the transport already is does nothing (`running`
    /// is belief OR element, #689); then play loads an empty queue that has
    /// something showing, or resumes; and pause pauses.
    ///
    /// `queueLength` is compared with `=== 0`, so nil (not a number) is not 0.
    public static func resolveToggle(want: Bool, restored: Bool, foray: Bool, stateType: String?,
                                     running: Bool, hasCurrent: Bool, queueLength: Double?) -> Toggle {
        if want && restored { return .playRestored }
        if want, let ended = endedPlayAction(foray: foray, stateType: stateType) { return ended }
        if want == running { return .noChange }
        if !want { return .pause }
        if hasCurrent && queueLength == 0 { return .load }
        return .resume
    }

    // MARK: previous

    /// `previousAction({index, item, currentTime})`: restart this item while
    /// we are inside it, go to the one before in the first
    /// `restartWindowSec`, measured from the item's OWN start.
    ///
    /// `item?.startSec` here is the value JS SUBTRACTS (`x - item.start_sec`),
    /// so nil means NaN: a narration item has no start, `into` is NaN, and
    /// the answer is the manager's previous (recorded as it is, not tidied).
    /// No item at all is `into = 0`. A missing clock is 0 (`?? 0`).
    public static func previousAction(index: Double, item: Item?, currentTime: Double?) -> Previous {
        let into: Double = item.map { (currentTime ?? 0) - ($0.startSec ?? .nan) } ?? 0
        return index > 0 && into < restartWindowSec ? .itemBefore : .manager
    }

    // MARK: skip and seek

    /// `clampEpisodeTarget(seconds, dur)`: a target the episode can hold:
    /// never below 0, never past `dur - seekEndGuardSec`; nil for a target
    /// that is not a finite number. `seconds` is the value after JS's
    /// `Number(seconds)`. A falsy duration (nil, 0, NaN) is "unknown": the
    /// target is only floored.
    public static func clampEpisodeTarget(_ seconds: Double, duration: Double?) -> Double? {
        guard seconds.isFinite else { return nil }
        let floor = JSMath.max(0, seconds)
        guard let duration, truthy(duration) else { return floor }
        return JSMath.min(floor, JSMath.max(0, duration - seekEndGuardSec))
    }

    /// `skipTarget({foray, positionSec, offsetSec, durationSec})`: where a
    /// ↺15 / 30↻ nudge lands. In a Foray the step is on the Foray's clock and
    /// only floored at 0 (the clock clamps the far end); on an episode it is
    /// `clampEpisodeTarget`. `Number(offsetSec || 0)`: a falsy offset (nil,
    /// 0, NaN) is no step.
    public static func skipTarget(foray: Bool, positionSec: Double, offsetSec: Double?,
                                  durationSec: Double?) -> Double? {
        let offset = truthy(offsetSec) ? offsetSec! : 0
        if foray { return JSMath.max(0, positionSec + offset) }
        return clampEpisodeTarget(positionSec + offset, duration: durationSec)
    }

    /// `seekAction({restored, stateType})`: with nothing loaded to seek in (a
    /// restored bar, `idle`, `ended`) the target is written down as the
    /// pending start; paused, loading and playing are ordinary seeks.
    public static func seekAction(restored: Bool, stateType: String?) -> Seek {
        restored || stateType == "idle" || stateType == "ended" ? .pend : .seek
    }

    // MARK: the Foray clock -> a source file's clock

    /// `sourceOffsetFor(item, into)`: where in the element's own clock a point
    /// `into` seconds into `item` lives; nil when there is nothing to seek.
    /// The seek always lands at least `seekInsideEndSec` inside the item's
    /// end (an out-point hit exactly reads as a scrub past it and disarms the
    /// boundary); a slice adds its start; a SPOKEN narration (a `tts` item
    /// with no file) cannot start mid-sentence, so nil; a rendered one's file
    /// is the item, so `into` itself.
    public static func sourceOffset(for item: Item?, into: Double?) -> Double? {
        guard let item, let into, into.isFinite else { return nil }
        let length = item.runtimeSec
        let inside = length.isFinite && length > 0
            ? JSMath.min(JSMath.max(0, into), JSMath.max(0, length - seekInsideEndSec))
            : JSMath.max(0, into)
        if let start = item.startSec, start.isFinite { return start + inside }
        if item.kind == EngineConstants.QueueState.tts && !item.hasAudioUrl { return nil }
        return inside
    }

    /// `scrubTarget(...)`'s answer.
    public struct Scrub: Equatable {
        public let index: Double
        /// The target needs its own load: another clip, or a Foray with
        /// nothing loaded to seek in (`ended`, `idle`).
        public let reload: Bool
        public let offset: Double?
    }

    /// `scrubTarget({at, item, currentIndex, stateType})`: a scrub once the
    /// Foray clock has said where it lands (`at`, from `segmentAtElapsed`);
    /// nil when it found nowhere. `at.index !== currentIndex`: a
    /// `currentIndex` that is not a number (nil) is never the same index.
    public static func scrubTarget(atIndex: Double, into: Double?, item: Item?,
                                   currentIndex: Double?, stateType: String?) -> Scrub {
        let sameIndex = currentIndex.map { $0 == atIndex } ?? false
        let reload = !sameIndex || stateType == "ended" || stateType == "idle"
        return Scrub(index: atIndex, reload: reload, offset: sourceOffset(for: item, into: into))
    }

    // MARK: remote stop

    /// `remoteStopAction(details)`: a stop from outside the page PAUSES,
    /// unless it is the Android notification's own Stop (`details.close ===
    /// true`), which closes the player. `close` is that field when it is a
    /// boolean, else nil: only a real `true` closes, so a car's or a
    /// Bluetooth stack's stop can never blank the display mid-drive.
    public static func remoteStopAction(close: Bool?) -> RemoteStop {
        close == true ? .close : .pause
    }
}

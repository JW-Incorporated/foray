import Foundation

/// The client layer's transport rules: the Swift port of
/// `player/transport-policy.js` (NE-08 lifted them out of client.js closures
/// with no behaviour change, so they could be handed to this port). JS is the
/// reference; the `transport` parity family is the contract, and
/// transport-policy.js's comments are where each rule's reason lives (the
/// audit of 2026-09-22 for start-over, the out-point disarm, the narration
/// scrub; the Android Stop for remote stop; audit round 2 for the Foray
/// clock under previous, the nudge's end guard, a nudge inside a spoken line
/// and an episode's previous).
///
/// QUIRKS ARE PORTED, NOT TIDIED. NE-08 recorded the old inline code as it
/// was, including answers a fresh design would not give (`skipTarget`'s
/// `Number(offset || 0)`), and a port that "fixes" one here would be a rule
/// change that skipped the JS. A change goes JS first, then a re-record, then
/// this file: audit round 2 (player-4, player-5, player-11, p-car-5) took that
/// route, and reached this port when engine/m1 was merged into NE-09.
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

    /// `NUDGE`: what a ↺15 / 30↻ nudge inside a Foray does.
    public enum Nudge: String, CaseIterable {
        case seek
        case restartLine = "restart-line"
        case skipLine = "skip-line"
        /// `NUDGE.NONE`: forward from the closing spoken line. Not named
        /// `none`, for the reason `Toggle.noChange` is not.
        case nothing = "none"
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

    /// `previousAction({index, positionSec, segmentStartSec})`: restart this
    /// item while we are inside it, go to the one before in the first
    /// `restartWindowSec`, measured from the segment's own start ON THE
    /// FORAY'S CLOCK (audit round 2, player-4: on the element's clock `into`
    /// was NaN for every narration line, so previous there never went back
    /// past the narrator).
    ///
    /// A nil `positionSec` is a jump still in flight and reads as "deep
    /// inside" (Infinity), which restarts: the safe answer. A NaN start (JS
    /// subtracting `undefined`) makes `into` NaN, and `NaN < 4` is false, so
    /// the manager's previous, as in JS.
    public static func previousAction(index: Double, positionSec: Double?, segmentStartSec: Double) -> Previous {
        let into: Double = positionSec.map { $0 - segmentStartSec } ?? .infinity
        return index > 0 && into < restartWindowSec ? .itemBefore : .manager
    }

    /// `episodePreviousRestarts({positionSec})`: on an ordinary episode,
    /// previous RESTARTS from `restartWindowSec` in (audit round 2, p-car-5:
    /// the meaning every podcast player gives ◀◀), the same window a Foray
    /// clip is measured against, so there is one number; inside it the page
    /// may go to the row before. JS's `>=` coerces, so NaN (undefined) is false.
    public static func episodePreviousRestarts(positionSec: Double) -> Bool {
        positionSec >= restartWindowSec
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
    /// ↺15 / 30↻ nudge lands. In a Foray the step is on the Foray's clock,
    /// floored at 0 and, given the Foray's total (`durationSec > 0`), stopped
    /// `seekEndGuardSec` short of it (audit round 2, player-5: a Foray-clock
    /// target at the total lands inside the last clip's out-point and ENDS the
    /// Foray, which a button labelled thirty seconds must not do; the scrubber
    /// never passes a total, so "take me to the end" still ends it). On an
    /// episode it is `clampEpisodeTarget`. `Number(offsetSec || 0)`: a falsy
    /// offset (nil, 0, NaN) is no step.
    public static func skipTarget(foray: Bool, positionSec: Double, offsetSec: Double?,
                                  durationSec: Double?) -> Double? {
        let offset = truthy(offsetSec) ? offsetSec! : 0
        if foray {
            let floor = JSMath.max(0, positionSec + offset)
            guard let total = durationSec, total > 0 else { return floor }
            return JSMath.min(floor, JSMath.max(0, total - seekEndGuardSec))
        }
        return clampEpisodeTarget(positionSec + offset, duration: durationSec)
    }

    /// `nudgeAction({offsetSec, landsInCurrentItem, narrationPlayhead,
    /// onLastItem})`: what a Foray nudge does once `skipTarget` has said where
    /// it lands. A spoken line has no offset to seek to (audit round 2,
    /// player-11: the seek did nothing, silently, while the clock ran on), so
    /// a nudge that stays inside one says plainly what it does: back re-speaks
    /// the line, forward skips it, and forward from the LAST line does nothing
    /// (the Foray's next returns early there). A nudge that crosses out of the
    /// line, or lands in a clip, is an ordinary seek.
    public static func nudgeAction(offsetSec: Double, landsInCurrentItem: Bool, narrationPlayhead: Bool,
                                   onLastItem: Bool) -> Nudge {
        guard landsInCurrentItem && narrationPlayhead else { return .seek }
        if offsetSec < 0 { return .restartLine }
        return onLastItem ? .nothing : .skipLine
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

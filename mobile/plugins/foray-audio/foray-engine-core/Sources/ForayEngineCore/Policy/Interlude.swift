import Foundation

/// A queue item as the interlude rule sees it: its kind, the three fields the
/// Foray strip keys a capsule by, and its bounds in the source.
///
/// Every field is optional because the JS reads each one with `?.` and a
/// `typeof` test: nil stands for "absent, or not the type the JS checks for".
public struct InterludeItem: Equatable {
    /// `item.kind` (`"episode"`, `"tts"`, `"jingle"`, ...), when a string.
    public let kind: String?
    /// `item.type` (`"narration"` is the other narrator shape), when a string.
    public let type: String?
    public let sourceItemId: String?
    public let itemId: String?
    public let audioUrl: String?
    public let startSec: Double?
    public let endSec: Double?

    public init(kind: String? = nil, type: String? = nil, sourceItemId: String? = nil, itemId: String? = nil,
                audioUrl: String? = nil, startSec: Double? = nil, endSec: Double? = nil) {
        self.kind = kind
        self.type = type
        self.sourceItemId = sourceItemId
        self.itemId = itemId
        self.audioUrl = audioUrl
        self.startSec = startSec
        self.endSec = endSec
    }

    var seamItem: SeamItem { SeamItem(startSec: startSec, endSec: endSec) }
}

/// The interlude jingle's RULE and the native silence node's cap: the Swift
/// port of the pure half of `player/interlude.js` (card NE-28s; the fixtures
/// are NE-28j's `interlude` family). The element wrapper (`createInterludePlayer`)
/// is the web's; the native jingle adapter is NE-31s's `InterludePlayer`, and
/// it asks THIS for whether a seam gets the jingle and how long silence may run.
///
/// The reasons for each clause live in interlude.js's header, which is the
/// reference: segment -> segment and narration -> segment on an auto-advance
/// only, never after an authored JINGLE item, never between two cuts of the
/// same episode (audit round 2, p-foray-1), and the seam beat is the floor.
public enum Interlude {
    /// `INTERLUDE_DURATION_SEC`: the placeholder asset's measured length.
    public static let durationSec: Double = EngineConstants.Interlude.interludeDurationSec
    /// `INTERLUDE_CEILING_SEC`: the longest a seam is held for the jingle, and
    /// the silence node's hard cap measured from the out-point (authored 4.5).
    public static let ceilingSec: Double = EngineConstants.Interlude.interludeCeilingSec
    /// `INTERLUDE_RATE`: always 1x, whatever the listener's rate (authored).
    public static let rate: Double = EngineConstants.Interlude.interludeRate
    /// `INTERLUDE_ASSET_URL`: the asset every host fetches (see the JS header
    /// for why it is an absolute https URL).
    public static let assetUrl: String = EngineConstants.Interlude.interludeAssetUrl

    /// `JINGLE` in `player/foray-queue.js`: an authored jingle item's kind.
    public static let jingleKind = "jingle"

    /// The strip's capsule key (`segment-strip.js` `sourceKeyOf`). A narration
    /// item is the narrator, never an episode; otherwise the first NON-BLANK
    /// string of `source_item_id`, `item_id`, `audio_url`, else "" (never
    /// `item.id`, which is a position, not an episode).
    public enum SourceKey: Equatable {
        case narrator
        case episode(String)
    }

    /// `isNarration(item)`: `kind === "tts" || type === "narration"`.
    public static func isNarration(_ item: InterludeItem?) -> Bool {
        item?.kind == "tts" || item?.type == "narration"
    }

    /// `sourceKeyOf(item)`. `nonEmpty` is `typeof s === "string" &&
    /// s.trim().length > 0`, where `trim` strips ECMAScript white space and
    /// line terminators.
    public static func sourceKey(_ item: InterludeItem?) -> SourceKey {
        if isNarration(item) { return .narrator }
        for key in [item?.sourceItemId, item?.itemId, item?.audioUrl] {
            if let key, !isJSBlank(key) { return .episode(key) }
        }
        return .episode("")
    }

    /// `sameSourceEpisode(from, to)`: only a POSITIVE match counts. Two
    /// narrators are not one episode (the narrator key is not a string in JS),
    /// and two unidentified items are not evidence of one.
    public static func sameSourceEpisode(_ from: InterludeItem?, _ to: InterludeItem?) -> Bool {
        guard case let .episode(a) = sourceKey(from), !a.isEmpty,
              case let .episode(b) = sourceKey(to) else { return false }
        return a == b
    }

    /// `interludeEligible({from, to, cause})`. `cause` nil stands for a value
    /// that is not a string (it can never equal `"auto"`); the default is an
    /// auto-advance, as in JS.
    public static func eligible(from: InterludeItem?, to: InterludeItem?, cause: String? = SeamGap.autoAdvance) -> Bool {
        if cause != SeamGap.autoAdvance { return false }
        guard let from, let to else { return false }
        if !SeamGap.isSegment(to.seamItem) { return false }
        if from.kind == jingleKind { return false }
        if sameSourceEpisode(from, to) { return false }
        return true
    }

    /// `silenceNodeSec({sinceOutPointSec, running, sessionActive})`: how many
    /// more seconds the native silence node may render, measured from the
    /// out-point. Never beyond `ceilingSec` from the out-point; never when the
    /// engine is not running or the session is not active (silence is an
    /// audible start as far as the session is concerned). A time that is not
    /// a finite, non-negative number is no silence at all.
    public static func silenceNodeSec(sinceOutPointSec: Double?, running: Bool, sessionActive: Bool) -> Double {
        guard running, sessionActive else { return 0 }
        guard let since = sinceOutPointSec, since.isFinite, since >= 0 else { return 0 }
        return JSMath.max(0, ceilingSec - since)
    }

    /// `s.trim().length === 0`: ECMAScript's `trim` strips WhiteSpace and
    /// LineTerminator, which is Unicode's Space_Separator plus TAB, VT, FF,
    /// BOM, LF, CR, LS and PS.
    static func isJSBlank(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A,
                 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                return true
            default:
                return false
            }
        }
    }
}

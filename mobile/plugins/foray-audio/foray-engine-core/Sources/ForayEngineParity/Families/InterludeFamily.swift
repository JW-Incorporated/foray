import Foundation
import ForayEngineCore

/// The `interlude` family against `Interlude` (ForayEngineCore/Policy), card
/// NE-28s, from the cases `player/interlude.js` recorded (NE-28j).
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION (as in SeamGapFamily). The
/// JS reads each field this way, and each mapping below is that line of JS:
///
///   `({from, to, cause = AUTO_ADVANCE} = {})`  no argument is `{}`; null THROWS
///   `!from || !to`                             a falsy side is no item at all
///   `cause !== AUTO_ADVANCE`                   a non-string cause never equals it
///   `item?.kind`, `item?.type`                 only a string can equal "tts" etc.
///   `nonEmpty(item?.source_item_id)`, ...      only a string is a key
///   `isSegment(to)`                            only a number is a bound
///   `running !== true`                         strict: only a real true runs
///   `typeof sinceOutPointSec !== "number"`     anything else is no silence
public enum InterludeFamily {
    public static let module = "player/interlude.js"

    public static let runner = PureFamilyRunner(
        family: "interlude",
        module: InterludeFamily.module,
        reads: [
            "INTERLUDE_DURATION_SEC": .number(Interlude.durationSec),
            "INTERLUDE_CEILING_SEC": .number(Interlude.ceilingSec),
            "INTERLUDE_RATE": .number(Interlude.rate),
            "INTERLUDE_ASSET_URL": .string(Interlude.assetUrl)
        ],
        calls: [
            "interludeEligible": InterludeFamily.interludeEligible,
            "sameSourceEpisode": InterludeFamily.sameSourceEpisode,
            "silenceNodeSec": InterludeFamily.silenceNodeSec
        ])

    /// `interludeEligible({ from, to, cause = AUTO_ADVANCE } = {})`.
    static func interludeEligible(_ args: [JSValue]) throws -> CallOutcome {
        guard let seam = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: true) else { return .threw("TypeError") }
        let cause: String?
        switch seam["cause"] {
        case .undefined: cause = SeamGap.autoAdvance
        case let .string(text): cause = text
        default: cause = nil
        }
        let from = seam["from"].isTruthy ? item(seam["from"]) : nil
        let to = seam["to"].isTruthy ? item(seam["to"]) : nil
        return .returned(.bool(Interlude.eligible(from: from, to: to, cause: cause)))
    }

    /// `sameSourceEpisode(from, to)`: both read with `?.`, so null and
    /// undefined are simply no key.
    static func sameSourceEpisode(_ args: [JSValue]) throws -> CallOutcome {
        let from = ArgReading.arg(args, 0)
        let to = ArgReading.arg(args, 1)
        return .returned(.bool(Interlude.sameSourceEpisode(from.isNullish ? nil : item(from),
                                                           to.isNullish ? nil : item(to))))
    }

    /// `silenceNodeSec({ sinceOutPointSec, running = false, sessionActive = false } = {})`.
    static func silenceNodeSec(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: true) else { return .threw("TypeError") }
        let sec = Interlude.silenceNodeSec(sinceOutPointSec: s["sinceOutPointSec"].numberValue,
                                           running: s["running"] == .bool(true),
                                           sessionActive: s["sessionActive"] == .bool(true))
        return .returned(.number(sec))
    }

    /// A queue item as the rule reads it. Any non-object reads as all-undefined
    /// fields, which `JSValue`'s subscript already gives.
    static func item(_ value: JSValue) -> InterludeItem {
        InterludeItem(kind: value["kind"].stringValue, type: value["type"].stringValue,
                      sourceItemId: value["source_item_id"].stringValue, itemId: value["item_id"].stringValue,
                      audioUrl: value["audio_url"].stringValue,
                      startSec: value["start_sec"].numberValue, endSec: value["end_sec"].numberValue)
    }
}

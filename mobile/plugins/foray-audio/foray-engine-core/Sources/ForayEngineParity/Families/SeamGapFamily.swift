import Foundation
import ForayEngineCore

/// The `seam-gap` family against `SeamGap` (ForayEngineCore/Policy): NE-05's
/// proof that the whole Swift harness runs a real rule, end to end, from the
/// fixtures `player/seam-gap.js` recorded.
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION. The JS function takes one
/// untyped object; the Swift port takes typed arguments. This runner reads
/// the object exactly the way seam-gap.js's destructuring reads it, and every
/// mapping below is that line of JS:
///
///   `{...} = {}`            no argument at all behaves as `{}`; `null` THROWS
///                           (destructuring null is a TypeError in JS)
///   `bridged = false`       absent -> false, otherwise JS truthiness
///   `cause = AUTO_ADVANCE`  absent -> "auto"; a non-string can never equal
///                           "auto", so it maps to a value that cannot either
///   `gapSec = SEAM_GAP_SEC` absent -> the default; a non-number (null, "2")
///                           maps to NaN, because the JS check
///                           `typeof gapSec === "number" && Number.isFinite(..)`
///                           takes the same branch for both
///   `!from || !to`          a falsy side is no item at all
///
/// If a mapping here ever has to DECIDE something the JS does not, the port
/// is wrong, not the runner.
public enum SeamGapFamily {
    public static let module = "player/seam-gap.js"

    public static let runner = PureFamilyRunner(
        family: "seam-gap",
        module: SeamGapFamily.module,
        reads: [
            "SEAM_GAP_SEC": .number(SeamGap.defaultGapSec),
            "AUTO_ADVANCE": .string(SeamGap.autoAdvance),
            "USER_ACTION": .string(SeamGap.userAction)
        ],
        calls: [
            "seamGapSec": { args in
                let seam = args.first ?? .undefined
                if seam == .null { return .threw("TypeError") }
                let cause: String
                switch seam["cause"] {
                case .undefined: cause = SeamGap.autoAdvance
                case let .string(text): cause = text
                default: cause = SeamGapFamily.nonStringCause
                }
                let gap: Double
                switch seam["gapSec"] {
                case .undefined: gap = SeamGap.defaultGapSec
                case let .number(value): gap = value
                default: gap = .nan
                }
                let sec = SeamGap.gapSec(from: SeamGapFamily.item(seam["from"]), to: SeamGapFamily.item(seam["to"]),
                                         bridged: seam["bridged"].isTruthy, cause: cause, gapSec: gap)
                return .returned(.number(sec))
            },
            "isSegment": { args in
                .returned(.bool(SeamGap.isSegment(SeamGapFamily.item(args.first ?? .undefined, keepFalsy: true))))
            }
        ])

    /// Never equal to "auto" (nor to any string a fixture could spell, since
    /// JSON strings cannot hold U+0000 unescaped and none do).
    static let nonStringCause = "\u{0}non-string cause"

    /// A queue item as the rule reads it: `item?.start_sec`, `item?.end_sec`,
    /// where only a NUMBER is a number (`typeof n === "number"`).
    ///
    /// `keepFalsy`: `seamGapSec` rejects a falsy side before looking at it
    /// (`!from`), so a falsy value there is NO item. `isSegment(item)` has no
    /// such guard, it reads `item?.start_sec` directly, and that is `undefined`
    /// for every value that is not an object, so the result is the same either
    /// way; the flag only keeps the two readings honest about which line of JS
    /// they are.
    static func item(_ value: JSValue, keepFalsy: Bool = false) -> SeamItem? {
        if !keepFalsy && !value.isTruthy { return nil }
        return SeamItem(startSec: value["start_sec"].numberValue, endSec: value["end_sec"].numberValue)
    }
}

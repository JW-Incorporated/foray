import Foundation

/// The slice of the SOURCE audio a queue item occupies: the Swift port of
/// `itemBounds` in `player/queue-state.js`.
///
/// ONE definition of "bounded", on purpose. In JS the reducer, the manager,
/// the Foray builder and `seam-gap.js` all import `itemBounds` rather than
/// re-deriving it, because three definitions of a segment is exactly the drift
/// that function was written to end. The Swift side keeps the same shape: the
/// seam rule below uses this, and the reducer's parity work (NE-07s, whose
/// `queue-state/item-bounds-*` cases pin the same function) uses it too.
public struct ItemBounds: Equatable {
    public let startSec: Double
    public let endSec: Double

    /// `itemBounds({startSec, endSec})`: nil unless the end is a finite,
    /// non-negative number strictly after the start. A missing, negative or
    /// non-finite start floors to 0. `nil` stands for every value JavaScript's
    /// `typeof n === "number"` check rejects (absent, null, a string).
    public static func make(startSec: Double?, endSec: Double?) -> ItemBounds? {
        let start = finiteNonNegative(startSec) ?? 0
        guard let end = finiteNonNegative(endSec), end > start else { return nil }
        return ItemBounds(startSec: start, endSec: end)
    }

    static func finiteNonNegative(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value
    }
}

/// A queue item as the seam rule sees it: only its bounds in the source.
public struct SeamItem: Equatable {
    public let startSec: Double?
    public let endSec: Double?

    public init(startSec: Double?, endSec: Double?) {
        self.startSec = startSec
        self.endSec = endSec
    }
}

/// The seam beat: how much silence goes between two queue items. The Swift
/// port of `player/seam-gap.js`, which is the reference; the `seam-gap` parity
/// family (player/parity/fixtures/seam-gap) is the contract between them, and
/// the header of seam-gap.js is where the rule's reasons live (docs/curation/
/// segment-length-rules.md §0 and §6b: >= 2.0 s at an unbridged seam).
///
/// NE-05 ports it as the parity runner's proof family, so the whole Swift
/// harness is exercised by a real rule from day one. The engine's use of it
/// (the beat between segments on the native decks) is NE-28s/NE-30s.
public enum SeamGap {
    /// `SEAM_GAP_SEC`. Pinned by the AUTHORED case `seam-gap/rule-is-2.0s`:
    /// a port that hard-codes another number fails a parity case, not only
    /// NE-04's generated-constants check.
    public static let defaultGapSec: Double = 2.0

    /// `AUTO_ADVANCE` and `USER_ACTION`: why the player moved on. Only an
    /// auto-advance gets a beat.
    public static let autoAdvance = "auto"
    public static let userAction = "user"

    /// `isSegment(item)`: the item occupies a real forward slice of a source.
    /// No item at all is not a segment.
    public static func isSegment(_ item: SeamItem?) -> Bool {
        ItemBounds.make(startSec: item?.startSec, endSec: item?.endSec) != nil
    }

    /// `seamGapSec({from, to, bridged, cause, gapSec})`, in seconds; 0 when
    /// this transition is not a seam. The four "no beat" cases, in the JS
    /// order: a move the listener drove (any cause but `auto`), a bridged
    /// transition, a missing side, and anything that is not segment to
    /// segment. A length that is not a finite positive number collapses to
    /// no beat rather than to NaN.
    public static func gapSec(from: SeamItem?, to: SeamItem?, bridged: Bool = false,
                              cause: String = autoAdvance, gapSec: Double = defaultGapSec) -> Double {
        if cause != autoAdvance { return 0 }
        if bridged { return 0 }
        guard let from, let to else { return 0 }
        if !isSegment(from) || !isSegment(to) { return 0 }
        return gapSec.isFinite && gapSec > 0 ? gapSec : 0
    }
}

package ai.jwlabs.foura.engine;

/**
 * The seam beat: how much silence goes between two queue items. The JVM twin of
 * {@code SeamGap} in ForayEngineCore (Policy/SeamGap.swift), card A-40, and like it the port of
 * {@code player/seam-gap.js}, which is the reference. The {@code seam-gap} parity family is the
 * contract; seam-gap.js's header is where the rule's reasons live (0.5 s at an unbridged seam, the
 * founder's ruling of 2026-09-24 in docs/DECISIONS.md).
 */
public final class SeamGap {
    private SeamGap() {}

    /**
     * {@code SEAM_GAP_SEC}. Pinned by the AUTHORED case {@code seam-gap/rule-is-0.5s}, so a port
     * that hard-codes another number fails a parity case.
     */
    public static final double DEFAULT_GAP_SEC = 0.5;

    /** {@code AUTO_ADVANCE} and {@code USER_ACTION}: why the player moved on. Only an auto-advance gets a beat. */
    public static final String AUTO_ADVANCE = "auto";

    public static final String USER_ACTION = "user";

    /** A queue item as the seam rule sees it: only its bounds in the source (null: not a number). */
    public record SeamItem(Double startSec, Double endSec) {}

    /** {@code isSegment(item)}: the item occupies a real forward slice of a source. No item is not a segment. */
    public static boolean isSegment(SeamItem item) {
        return ItemBounds.make(item == null ? null : item.startSec(), item == null ? null : item.endSec()) != null;
    }

    /**
     * {@code seamGapSec({from, to, bridged, cause, gapSec})}, in seconds; 0 when this transition
     * is not a seam. The four "no beat" cases, in the JS order: a move the listener drove (any
     * cause but {@code auto}), a bridged transition, a missing side, and anything that is not
     * segment to segment. A length that is not a finite positive number is no beat, never NaN.
     */
    public static double gapSec(SeamItem from, SeamItem to, boolean bridged, String cause, double gapSec) {
        if (!AUTO_ADVANCE.equals(cause)) return 0;
        if (bridged) return 0;
        if (from == null || to == null) return 0;
        if (!isSegment(from) || !isSegment(to)) return 0;
        return Double.isFinite(gapSec) && gapSec > 0 ? gapSec : 0;
    }

    /** {@link #gapSec} with the JS defaults: not bridged, an auto-advance, {@code SEAM_GAP_SEC}. */
    public static double gapSec(SeamItem from, SeamItem to) {
        return gapSec(from, to, false, AUTO_ADVANCE, DEFAULT_GAP_SEC);
    }
}

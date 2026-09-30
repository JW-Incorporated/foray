package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The Foray clock: how long each item of a built queue is, where each one starts, and where a
 * playhead lands on the listener's clock. The JVM twin of {@code ForayClock} in ForayEngineCore
 * (Policy/ForayClock.swift), card A-40, and like it the port of {@code itemRuntimeSec} /
 * {@code narrationDuration} / {@code forayRuntimeSec} / {@code runtimeIsEstimated}
 * (player/foray-queue.js) and {@code segmentStarts} / {@code segmentAtElapsed} /
 * {@code forayElapsed} / {@code progressSegments} (player/foray-resolve.js). JS is the
 * reference; the {@code foray-clock} parity family is the contract.
 *
 * <p>ONE DEFINITION OF "HOW LONG IS THIS ITEM" ({@link #itemRuntimeSec}): every other function
 * here measures an item through it. A jingle counts its measured 3.0 s (OQ-6).
 *
 * <p>A null entry in an items list stands for an entry that is not a plain object; the JS reads
 * every field of such an entry as {@code undefined}, which is an item with no fields here. A null
 * list is no list ({@code items ?? []}).
 */
public final class ForayClock {
    private ForayClock() {}

    public static final double JINGLE_DURATION_SEC = EngineConstants.ForayQueue.JINGLE_DURATION_SEC;
    public static final double NARRATION_CHARS_PER_SEC = EngineConstants.ForayQueue.NARRATION_CHARS_PER_SEC;
    public static final double NARRATION_FALLBACK_SEC = EngineConstants.ForayQueue.NARRATION_FALLBACK_SEC;
    public static final String DURATION_MEASURED = EngineConstants.ForayQueue.DURATION_MEASURED;
    public static final String DURATION_ESTIMATED = EngineConstants.ForayQueue.DURATION_ESTIMATED;
    public static final String DURATION_FALLBACK = EngineConstants.ForayQueue.DURATION_FALLBACK;
    public static final String JINGLE = EngineConstants.ForayQueue.JINGLE;

    /** {@code narrationDuration(item)}'s answer. */
    public record NarrationDuration(double sec, String source) {}

    /**
     * {@code narrationDuration(item)}: a positive finite {@code duration_sec} keeps its provenance
     * (or is {@code measured}); else a non-blank script projected at
     * {@link #NARRATION_CHARS_PER_SEC}, rounded to the millisecond; else the fallback.
     */
    public static NarrationDuration narrationDuration(ForayItem item) {
        Double sec = finite(item == null ? null : item.durationSec());
        if (sec != null && sec > 0) {
            String source = item.durationSource() != null && MediaMapping.nonEmptyTrimmed(item.durationSource()) != null
                    ? item.durationSource() : null;
            return new NarrationDuration(sec, source != null ? source : DURATION_MEASURED);
        }
        String script = item == null || item.script() == null ? "" : MediaMapping.jsTrim(item.script());
        // String.prototype.length counts UTF-16 units, as a Java String's length does.
        double length = script.length();
        if (length > 0) {
            return new NarrationDuration(JSMath.round(length / NARRATION_CHARS_PER_SEC * 1000) / 1000, DURATION_ESTIMATED);
        }
        return new NarrationDuration(NARRATION_FALLBACK_SEC, DURATION_FALLBACK);
    }

    /**
     * {@code itemRuntimeSec(item)}: a segment's authored length (the pad is tolerance, not
     * content, ADR-0008), else a positive finite {@code duration_sec}, else 0.
     */
    public static double itemRuntimeSec(ForayItem item) {
        if (item == null) return 0;
        Double authored = finite(item.authoredEndSec());
        Double end = authored != null ? authored : item.endSec();
        Double start = finite(item.startSec());
        Double finiteEnd = finite(end);
        if (start != null && finiteEnd != null && finiteEnd > start) return finiteEnd - start;
        Double sec = finite(item.durationSec());
        if (sec != null && sec > 0) return sec;
        return 0;
    }

    /** {@code forayRuntimeSec(items)}: the listener's clock, narration included. */
    public static double forayRuntimeSec(List<ForayItem> items) {
        double total = 0;
        if (items != null) for (ForayItem item : items) total += itemRuntimeSec(item);
        return total;
    }

    /**
     * {@code runtimeIsEstimated(items)}: is any item's duration anything but a measurement? Tape
     * (no {@code duration_source}) is measured. Not a list: false.
     */
    public static boolean runtimeIsEstimated(List<ForayItem> items) {
        if (items == null) return false;
        for (ForayItem item : items) {
            String source = item == null ? null : item.durationSource();
            if (source == null || MediaMapping.nonEmptyTrimmed(source) == null) continue;
            if (!source.equals(DURATION_MEASURED)) return true;
        }
        return false;
    }

    /** {@code segmentStarts(items)}: the cumulative start of every item, in Foray seconds. */
    public static List<Double> segmentStarts(List<ForayItem> items) {
        List<Double> starts = new ArrayList<>();
        double acc = 0;
        if (items != null) {
            for (ForayItem item : items) {
                starts.add(acc);
                acc += itemRuntimeSec(item);
            }
        }
        return starts;
    }

    /** Which item a Foray-clock reading falls in, and how far into it. */
    public record Position(int index, double into, double start) {}

    /**
     * {@code segmentAtElapsed(items, elapsed)}: clamped at both ends (a scrub to the total, or a
     * rounding error past it, lands on the last item). No items: null.
     */
    public static Position segmentAtElapsed(List<ForayItem> items, Double elapsed) {
        if (items == null || items.isEmpty()) return null;
        Double value = finite(elapsed);
        double target = value != null && value > 0 ? value : 0;
        List<Double> starts = segmentStarts(items);
        for (int i = 0; i < items.size(); i++) {
            if (target < starts.get(i) + itemRuntimeSec(items.get(i))) {
                return new Position(i, target - starts.get(i), starts.get(i));
            }
        }
        int last = items.size() - 1;
        return new Position(last, itemRuntimeSec(items.get(last)), starts.get(last));
    }

    /**
     * {@code forayElapsed(items, index, playheadSec)}: the Foray clock from a queue index and the
     * playhead inside the SOURCE. A segment's in-point is subtracted; a narration item has none.
     * The offset is clamped into {@code [0, the item's length]}. {@code index} is the JS value
     * when it is a number (null otherwise); anything but a non-negative integer is 0.
     */
    public static double forayElapsed(List<ForayItem> items, Double index, Double playheadSec) {
        if (items == null || items.isEmpty() || index == null || !JSMath.isInteger(index) || !(index >= 0)) return 0;
        int i = (int) Math.min(index, items.size() - 1);
        List<Double> starts = segmentStarts(items);
        ForayItem item = items.get(i);
        Double base = finite(item == null ? null : item.startSec());
        double into = 0;
        Double playhead = finite(playheadSec);
        if (playhead != null) {
            into = JSMath.min(JSMath.max(0, playhead - (base == null ? 0 : base)), itemRuntimeSec(item));
        }
        return starts.get(i) + into;
    }

    /** One row of the stored-progress view of a running order (#40). */
    public record ProgressSegment(String id, double startSec, double durationSec) {}

    /**
     * An authored entry of a resolved Foray as {@code progressSegments} reads it: {@code playable}
     * is truthiness, {@code queueIndex} the value when it is a number, {@code segmentId} the id
     * when it is a string.
     */
    public record ProgressEntry(boolean playable, Double queueIndex, String segmentId) {}

    /**
     * {@code progressSegments(resolved)}: one row per playable item, in play order, its id joined
     * back from the entries by {@code queueIndex} (a later entry for the same index wins). A
     * narration bridge still gets a row with its real length.
     */
    public static List<ProgressSegment> progressSegments(List<ForayItem> items, List<ProgressEntry> entries) {
        List<ForayItem> list = items == null ? new ArrayList<>() : items;
        List<Double> starts = segmentStarts(list);
        Map<Integer, String> idByQueueIndex = new HashMap<>();
        if (entries != null) {
            for (ProgressEntry entry : entries) {
                if (entry == null || !entry.playable() || entry.queueIndex() == null || !JSMath.isInteger(entry.queueIndex())) {
                    continue;
                }
                double q = entry.queueIndex();
                if (q < Integer.MIN_VALUE || q > Integer.MAX_VALUE) continue;
                idByQueueIndex.put((int) q, entry.segmentId());
            }
        }
        List<ProgressSegment> out = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            out.add(new ProgressSegment(idByQueueIndex.get(i), starts.get(i), itemRuntimeSec(list.get(i))));
        }
        return out;
    }

    /** {@code isNum}: a finite number, or null. */
    static Double finite(Double value) {
        return value != null && Double.isFinite(value) ? value : null;
    }
}

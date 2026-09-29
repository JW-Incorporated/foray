package ai.jwlabs.foura.engine;

/**
 * The slice of the SOURCE audio a queue item occupies: the port of {@code itemBounds} in
 * {@code player/queue-state.js}, and the JVM twin of {@code ItemBounds} in ForayEngineCore
 * (Policy/SeamGap.swift).
 *
 * <p>ONE definition of "bounded", on purpose: the reducer, the manager, the Foray builder
 * and the seam rule all use this rather than re-deriving it. The only way to build one is
 * {@link #make}, so a bounds value can never be backwards, empty or non-finite. Equality
 * is "same start, same end", which is queue-state.js's {@code sameBounds}.
 */
public final class ItemBounds {
    private final double startSec;
    private final double endSec;

    private ItemBounds(double startSec, double endSec) {
        this.startSec = startSec;
        this.endSec = endSec;
    }

    public double startSec() {
        return startSec;
    }

    public double endSec() {
        return endSec;
    }

    /**
     * {@code itemBounds({startSec, endSec})}: null unless the end is a finite, non-negative
     * number strictly after the start. A missing, negative or non-finite start floors to 0.
     * A null argument stands for every value {@code typeof n === "number"} rejects.
     */
    public static ItemBounds make(Double startSec, Double endSec) {
        Double start = finiteNonNegative(startSec);
        double from = start == null ? 0 : start;
        Double end = finiteNonNegative(endSec);
        if (end == null || !(end > from)) return null;
        return new ItemBounds(from, end);
    }

    static Double finiteNonNegative(Double value) {
        if (value == null || Double.isNaN(value) || Double.isInfinite(value) || !(value >= 0)) return null;
        return value;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof ItemBounds b && b.startSec == startSec && b.endSec == endSec;
    }

    @Override
    public int hashCode() {
        // + 0.0 folds -0 into 0, which == already treats as equal.
        return 31 * Double.hashCode(startSec + 0.0) + Double.hashCode(endSec + 0.0);
    }

    @Override
    public String toString() {
        return "ItemBounds[" + startSec + ", " + endSec + "]";
    }
}

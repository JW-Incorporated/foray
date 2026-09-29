package ai.jwlabs.foura.engine;

/**
 * JavaScript's {@code Math.round}, {@code Math.max} and {@code Math.min}, for the policy
 * ports whose JS reference calls them: the JVM twin of {@code JSMath} in ForayEngineCore
 * (JSMath.swift, NE-09).
 *
 * <p>Java's own {@code Math.max} and {@code Math.min} already agree with JavaScript on NaN
 * and on the sign of zero ({@code Math.max(0, -0)} is {@code +0}, {@code Math.min(0, -0)}
 * is {@code -0}); they are spelled out here anyway, so a port that reads "Math.max" in
 * the JS writes {@code JSMath.max} and a reviewer checks it line against line, as on the
 * Swift side. {@code Math.round} is where Java does differ: it returns a {@code long}
 * (saturating past 2^63) and loses the sign of a zero result, where JavaScript's
 * {@code Math.round(-0.4)} is {@code -0}.
 */
public final class JSMath {
    private JSMath() {}

    /** {@code Math.max(a, b)}. */
    public static double max(double a, double b) {
        if (Double.isNaN(a) || Double.isNaN(b)) return Double.NaN;
        if (a == 0 && b == 0) return (isNegativeZero(a) && isNegativeZero(b)) ? -0.0 : 0.0;
        return a > b ? a : b;
    }

    /** {@code Math.min(a, b)}. */
    public static double min(double a, double b) {
        if (Double.isNaN(a) || Double.isNaN(b)) return Double.NaN;
        if (a == 0 && b == 0) return (isNegativeZero(a) || isNegativeZero(b)) ? -0.0 : 0.0;
        return a < b ? a : b;
    }

    /**
     * {@code Math.round(x)}: the nearest integer, a tie going towards +Infinity. Built on
     * {@code floor} and the exact difference {@code x - floor(x)} rather than
     * {@code floor(x + 0.5)}, whose addition rounds: 0.49999999999999994 + 0.5 is exactly
     * 1.0 in binary, and JavaScript answers 0.
     */
    public static double round(double x) {
        if (Double.isNaN(x) || Double.isInfinite(x) || x == 0) return x;
        double down = Math.floor(x);
        double result = (x - down >= 0.5) ? down + 1 : down;
        // -0.5 <= x < 0 rounds to -0 in JavaScript, not to +0.
        return (result == 0 && x < 0) ? -0.0 : result;
    }

    /** {@code Number.isInteger(x)}. */
    public static boolean isInteger(double x) {
        return !Double.isNaN(x) && !Double.isInfinite(x) && Math.floor(x) == x;
    }

    static boolean isNegativeZero(double x) {
        return x == 0 && Double.doubleToRawLongBits(x) != 0L;
    }
}

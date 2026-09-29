package ai.jwlabs.foura.engine;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;

/**
 * How JavaScript prints a number: the JVM twin of {@code JSWriter.jsonNumber} and
 * {@code JSWriter.numberToString} in ForayEngineCore
 * (mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Persist/JSWriter.swift).
 *
 * <p>Every number inside a shared row is printed the way {@code JSON.stringify}
 * prints it, so that a row the engine writes is byte-identical to the one the page
 * would have written. The {@code number-format} parity family
 * (player/parity/fixtures/number-format/) pins each threshold on both sides; it is
 * the first family the JVM parity runner (A-22) executes rather than owes. The row
 * writer itself arrives with the {@code rows} family (A-23).
 *
 * <p>THE DIGITS ARE COMPUTED, NOT BORROWED FROM {@code Double.toString}. The Swift
 * port takes its digits from Swift's own {@code description}, which is the shortest
 * round-tripping string. Java's is not quite: since JDK 19 {@code Double.toString}
 * is shortest too, but its specification keeps at least TWO digits where one would
 * round-trip, and then picks the closer, so {@code Double.MIN_VALUE} prints
 * {@code 4.9E-324} where JavaScript prints {@code 5e-324} (the family's
 * {@code number-format/min-value} case). So the digits come from ECMA-262 Number::toString
 * step 5 directly: the fewest digits {@code k} whose decimal rounds back to the
 * value, and among those the one closest to it (ties to the even digit), found by
 * trying the value's exact decimal expansion rounded down and up at each precision.
 * Only {@code java.math} is used, which Android has had since API 1 (this module's
 * main code keeps to the API 24 library surface; see build.gradle).
 */
public final class JSWriter {
    private JSWriter() {}

    /** {@code JSON.stringify(value)} for a number: its {@link #numberToString} when finite, else {@code null}. */
    public static String jsonNumber(double value) {
        return Double.isNaN(value) || Double.isInfinite(value) ? "null" : numberToString(value);
    }

    /**
     * ECMAScript Number::toString(value), i.e. {@code String(value)}.
     *
     * <pre>
     *   k digits, value = 0.d1..dk x 10^n
     *   k &lt;= n &lt;= 21    integer, padded with zeros    (100, 1e20 -&gt; 100000000000000000000)
     *   0 &lt; n &lt;= 21     point inside the digits       (1234.5678)
     *   -6 &lt; n &lt;= 0     "0." then zeros               (0.000001, the smallest plain one)
     *   otherwise       exponent form, e+ / e-        (1e+21, 5e-7)
     * </pre>
     *
     * {@code -0} prints {@code 0} (step 2).
     */
    public static String numberToString(double value) {
        if (Double.isNaN(value)) return "NaN";
        if (Double.isInfinite(value)) return value < 0 ? "-Infinity" : "Infinity";
        if (value == 0) return "0";
        String sign = value < 0 ? "-" : "";
        double magnitude = Math.abs(value);
        BigDecimal shortest = shortestDecimal(magnitude).stripTrailingZeros();
        String d = shortest.unscaledValue().toString();
        int k = d.length();
        int n = k - shortest.scale();

        StringBuilder out = new StringBuilder(sign);
        if (k <= n && n <= 21) {
            out.append(d);
            zeros(out, n - k);
        } else if (0 < n && n <= 21) {
            out.append(d, 0, n).append('.').append(d, n, k);
        } else if (-6 < n && n <= 0) {
            out.append("0.");
            zeros(out, -n);
            out.append(d);
        } else {
            int e = n - 1;
            out.append(d.charAt(0));
            if (k > 1) out.append('.').append(d, 1, k);
            out.append('e').append(e < 0 ? '-' : '+').append(Math.abs(e));
        }
        return out.toString();
    }

    /**
     * The decimal ECMA-262 asks for: the fewest significant digits that parse back
     * to {@code magnitude}, and among those the closest to its exact value.
     *
     * <p>At each precision only two candidates need trying, the exact value rounded
     * down and rounded up. If any decimal of that length round-trips, the rounding
     * interval (which contains the exact value) reaches it, so it also reaches the
     * rounded-down or rounded-up neighbour on the same side; and the closest
     * round-tripping one is always one of those two. Seventeen digits always
     * round-trip a double, so the loop always returns.
     */
    private static BigDecimal shortestDecimal(double magnitude) {
        BigDecimal exact = new BigDecimal(magnitude);
        for (int p = 1; p < 17; p++) {
            BigDecimal down = exact.round(new MathContext(p, RoundingMode.FLOOR));
            BigDecimal up = exact.round(new MathContext(p, RoundingMode.CEILING));
            boolean downOk = roundTrips(down, magnitude);
            boolean upOk = roundTrips(up, magnitude);
            if (downOk && upOk) {
                int c = exact.subtract(down).compareTo(up.subtract(exact));
                if (c < 0) return down;
                if (c > 0) return up;
                return down.unscaledValue().testBit(0) ? up : down;
            }
            if (downOk) return down;
            if (upOk) return up;
        }
        return exact.round(new MathContext(17, RoundingMode.HALF_EVEN));
    }

    private static boolean roundTrips(BigDecimal candidate, double magnitude) {
        return Double.parseDouble(candidate.toString()) == magnitude;
    }

    private static void zeros(StringBuilder out, int count) {
        for (int i = 0; i < count; i++) out.append('0');
    }
}

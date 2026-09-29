package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Values beyond the number-format family, where the digit search is easiest to get
 * wrong: binade boundaries (powers of two, whose rounding interval is lopsided), a
 * value just under 1e21, subnormals, and a 17-digit one. Every expected string is
 * what node's {@code String(x)} printed for the same literal (2026-09-29), and the
 * number-format fixtures are the authority for everything they cover.
 */
public class JSWriterTest {
    private static void js(String expected, double value) {
        assertEquals("String(" + value + ")", expected, JSWriter.numberToString(value));
    }

    @Test
    public void digitsAreTheShortestThatRoundTripAndTheLayoutIsEcmas() {
        js("1e+23", 1e23);
        js("2.2250738585072014e-308", 2.2250738585072014e-308);
        js("1.23e-18", 1.23e-18);
        js("0.7999999999999999", 0.1 + 0.7);
        js("0.3333333333333333", 1.0 / 3);
        js("9223372036854776000", 9223372036854775807.0);
        js("1.5e-323", 1.5e-323);
        js("5.992310449541053e+307", 5.992310449541053e307);
        js("4.35", 4.35);
        js("0.000001234", 0.000001234);
        js("999999999999999900000", 999999999999999900000.0);
        js("9.5367431640625e-7", 9.5367431640625e-7);
        js("123456789012345.67", 123456789012345.67);
        js("-2.5e-7", -2.5e-7);
        js("1e-7", 1e-7);
        js("100", 100);
        js("25.5", 25.5);
        js("1152921504606847000", Math.pow(2, 60));
        js("9.313225746154785e-10", Math.pow(2, -30));
        js("1.2676506002282294e+30", Math.pow(2, 100));
        js("9.332636185032189e-302", Math.pow(2, -1000));
    }

    @Test
    public void specialValuesPrintAsJavaScriptDoesAndJsonNullsThem() {
        js("NaN", Double.NaN);
        js("Infinity", Double.POSITIVE_INFINITY);
        js("-Infinity", Double.NEGATIVE_INFINITY);
        js("0", -0.0);
        js("5e-324", Double.MIN_VALUE);
        assertEquals("null", JSWriter.jsonNumber(Double.NaN));
        assertEquals("null", JSWriter.jsonNumber(Double.NEGATIVE_INFINITY));
        assertEquals("0", JSWriter.jsonNumber(-0.0));
        assertEquals("1.7976931348623157e+308", JSWriter.jsonNumber(Double.MAX_VALUE));
    }
}

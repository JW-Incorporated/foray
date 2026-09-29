package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.util.Arrays;
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

    /* ---- A-23: the row writer, the reader and the dates (the Swift JSWriterTests, ported) ---- */

    /**
     * QuoteJSONString: the short escapes, lower-case {@code u00xx} for the other controls,
     * and everything else as itself ({@code /}, U+007F, U+2028, non-ASCII, a surrogate
     * PAIR). A LONE surrogate is escaped, as ES2019's well-formed JSON.stringify escapes it
     * (checked in Node with U+D800, "x", U+DC00; a Swift String cannot hold one).
     */
    @Test
    public void stringsEscapeExactlyAsJsonStringifyEscapesThem() {
        String input = "" + (char) 0 + (char) 7 + '\b' + '\t' + '\n' + (char) 0x0B + '\f' + '\r' + (char) 0x1F + ' ' + (char) 0x7F
                + (char) 0x2028 + (char) 0x2029 + '"' + '\\' + '/' + (char) 0xE9 + (char) 0xD83C + (char) 0xDFA7;
        String bs = "\\";
        String expected = "\"" + bs + "u0000" + bs + "u0007" + bs + "b" + bs + "t" + bs + "n" + bs + "u000b" + bs + "f" + bs + "r"
                + bs + "u001f " + (char) 0x7F + (char) 0x2028 + (char) 0x2029 + bs + "\"" + bs + bs + "/" + (char) 0xE9
                + (char) 0xD83C + (char) 0xDFA7 + "\"";
        assertEquals(expected, JSWriter.quote(input));
        String lone = "" + (char) 0xD800 + 'x' + (char) 0xDC00;
        assertEquals("\"" + bs + "ud800x" + bs + "udc00\"", JSWriter.quote(lone));
        // JSON.parse keeps a lone surrogate escape as that code unit, and it writes back the same.
        assertEquals(lone, JsonNode.parse("\"" + bs + "ud800x" + bs + "udc00\"").stringValue());
    }

    /** A row's key order is its builder's insertion order, whatever it is. */
    @Test
    public void objectsKeepInsertionOrder() {
        JsonNode node = new JsonNode.Obj(Arrays.asList(
                JsonNode.member("z", JsonNode.num(1)),
                JsonNode.member("a", new JsonNode.Arr(Arrays.asList(JsonNode.NULL, JsonNode.TRUE, JsonNode.str("x")))),
                JsonNode.member("m", new JsonNode.Obj(Arrays.asList()))));
        assertEquals("{\"z\":1,\"a\":[null,true,\"x\"],\"m\":{}}", JSWriter.stringify(node));
    }

    /**
     * JSON.parse keeps a repeated key at its FIRST position with its LAST value (Node:
     * {@code JSON.parse('{"b":1,"a":2,"b":3}')} is {@code {"b":3,"a":2}}), and a parsed row
     * writes back byte for byte.
     */
    @Test
    public void parseKeepsOrderFoldsRepeatedKeysAndRoundTrips() {
        assertEquals("{\"b\":3,\"a\":2}", JSWriter.stringify(JsonNode.parse("{\"b\":1,\"a\":2,\"b\":3}")));
        String bs = "\\";
        String row = "{\"foray_id\":\"f/" + (char) 0xE9 + ":1\",\"title\":\"Ain't " + bs + "\"it" + bs + "\" a " + bs + bs
                + " / </script>" + bs + "u0001" + bs + "t" + bs + "n " + (char) 0xE9 + " " + (char) 0x2014 + " " + (char) 0xD83C
                + (char) 0xDFA7 + "  end\",\"elapsed_sec\":0.30000000000000004,\"index\":-1,\"segment_id\":null,\"ok\":true,"
                + "\"list\":[1e+21,5e-7]}";
        assertEquals(row, JSWriter.stringify(JsonNode.parse(row)));
        JsonNode parsed = JsonNode.parse(" \t\n[ 1 , -0.5e2 ,\"" + bs + "ud83c" + bs + "udfa7\" ] ");
        assertEquals(new JsonNode.Arr(Arrays.asList(JsonNode.num(1), JsonNode.num(-50), JsonNode.str("" + (char) 0xD83C + (char) 0xDFA7))),
                parsed);
    }

    /** Everything JSON.parse refuses, refused; and its overflow and underflow. */
    @Test
    public void parseRefusesWhatJsonParseRefuses() {
        String bs = "\\";
        String[] bad = {"", "{", "[1,]", "{\"a\":1,}", "{'a':1}", "01", "-", "1.", ".5", "1e", "NaN", "Infinity",
            "\"a" + (char) 1 + "\"", "\"" + bs + "x\"", "\"" + bs + "u12\"", "tru", "nul", "1 2", "{\"a\" 1}", (char) 0xA0 + "1"};
        for (String text : bad) {
            try {
                JsonNode.parse(text);
                fail("JSON.parse(" + text + ") throws");
            } catch (JsonNode.ParseError expected) {
                // as JSON.parse
            }
            assertNull(JsonNode.tryParse(text));
        }
        assertEquals(JsonNode.num(Double.POSITIVE_INFINITY), JsonNode.parse("1e400"));
        assertEquals(JsonNode.num(Double.NEGATIVE_INFINITY), JsonNode.parse("-1e400"));
        assertEquals(0.0, JsonNode.parse("1e-400").numberValue(), 0.0);
    }

    /** {@code new Date(ms).toISOString()}, from Node: six-digit years, the ends of the range, TimeClip, a leap day. */
    @Test
    public void isoStringMatchesToIsoString() {
        Object[][] table = {
            {0.0, "1970-01-01T00:00:00.000Z"}, {-1.0, "1969-12-31T23:59:59.999Z"},
            {8.64e15, "+275760-09-13T00:00:00.000Z"}, {-8.64e15, "-271821-04-20T00:00:00.000Z"},
            {253_402_300_800_000.0, "+010000-01-01T00:00:00.000Z"}, {-62_167_219_200_000.0, "0000-01-01T00:00:00.000Z"},
            {-62_167_219_200_001.0, "-000001-12-31T23:59:59.999Z"}, {1_790_000_000_123.9, "2026-09-21T14:13:20.123Z"},
            {-0.5, "1970-01-01T00:00:00.000Z"}, {951_782_400_000.0, "2000-02-29T00:00:00.000Z"},
            {1_790_000_000_999.99, "2026-09-21T14:13:20.999Z"}, {1_790_000_000_123.0, "2026-09-21T14:13:20.123Z"},
        };
        for (Object[] row : table) assertEquals(String.valueOf(row[0]), row[1], JSWriter.isoString((Double) row[0]));
        for (double ms : new double[] {8.64e15 + 1, -8.64e15 - 1, Double.NaN, Double.POSITIVE_INFINITY}) {
            assertNull("toISOString throws a RangeError for " + ms, JSWriter.isoString(ms));
        }
    }

    /** {@code Date.parse} over the ISO format, from Node, and null where the port declines or JS gives NaN. */
    @Test
    public void dateParseReadsTheStampsRowsCarry() {
        Object[][] table = {
            {"2026-09-21", 1_789_948_800_000.0}, {"2026-09-21T14:13:20.123+02:00", 1_789_992_800_123.0},
            {"2026-09", 1_788_220_800_000.0}, {"2026", 1_767_225_600_000.0},
            {"+002026-09-21T14:13:20.123Z", 1_790_000_000_123.0}, {"2026-09-21T14:13Z", 1_789_999_980_000.0},
            {"2026-09-21T14:13:20Z", 1_790_000_000_000.0}, {"2026-02-30T00:00:00Z", 1_772_409_600_000.0},
            {"2026-09-21T24:00:00Z", 1_790_035_200_000.0}, {"2026-09-21T14:13:20.1234Z", 1_790_000_000_123.0},
            {"2026-09-21T14:13:20.1Z", 1_790_000_000_100.0}, {"2026-09-21T14:13:20.123+0200", 1_789_992_800_123.0},
            {"2026-09-21t14:13:20Z", 1_790_000_000_000.0}, {"2026-09-21T14:13:20.123z", 1_790_000_000_123.0},
            {"-000001-12-31T23:59:59.999Z", -62_167_219_200_001.0}, {"+275760-09-13T00:00:00.000Z", 8.64e15},
        };
        for (Object[] row : table) assertEquals((String) row[0], row[1], JSDate.parse((String) row[0]));
        String[] refused = {"-000000-01-01T00:00:00Z", "2026-02-32T00:00:00Z", "2026-00-10", "2026-13-01",
            "2026-09-21T24:30:00Z", "2026-09-21T23:60:00Z", "2026-09-21T14:13:20.Z", "2026-09-21T14:13:20.123+24:00",
            " 2026-09-21T14:13:20.123Z", "+275760-09-13T00:00:00.001Z", "2026-09-21T14:13:20.123", "2026-9-21", "not a date", ""};
        for (String text : refused) assertNull(text, JSDate.parse(text));
        // Every stamp the writer prints reads back as its instant.
        for (double ms : new double[] {0, -1, 1_790_000_000_123.0, 8.64e15, -8.64e15, 253_402_300_800_000.0}) {
            assertEquals(String.valueOf(ms), (Double) ms, JSDate.parse(JSWriter.isoString(ms)));
        }
    }
}

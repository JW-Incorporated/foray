package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.Rows;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * How a {@link FamilyRunner} reads a case's arguments the way the JS function's parameter
 * list reads them (A-23): the JVM twin of the Swift harness's {@code ArgReading} and
 * {@code JSCoercion} (ForayEngineParity/Families/ArgReading.swift, JSCoercion.swift).
 * Every helper names the line of JavaScript it stands for.
 *
 * <p>WHEN A VALUE CANNOT BE TRANSLATED, THE CASE FAILS. A typed JVM port has no parameter
 * for "the string '0', which is truthy but coerces to 0"; where JavaScript would do
 * something with such a value that a {@code Double} cannot carry, these helpers throw
 * {@code E_BAD_CASE} ("not representable") instead of picking an answer. A runner that
 * quietly guessed would be deciding the rule, which is the port's job.
 */
final class JsArgs {
    private JsArgs() {}

    /** The i-th argument; a missing one is {@code undefined}, as in JavaScript. */
    static Json arg(List<Json> args, int index) {
        return index < args.size() ? args.get(index) : Json.UNDEFINED;
    }

    /** {@code value[key]}: a member, or {@code undefined} for a missing key and for any non-object (a primitive's member). */
    static Json at(Json value, String key) {
        Json member = value.get(key);
        return member == null ? Json.UNDEFINED : member;
    }

    static boolean isUndefined(Json value) {
        return value instanceof Json.Undefined;
    }

    static boolean isNull(Json value) {
        return value instanceof Json.Null;
    }

    /** {@code value == null}: null or undefined. */
    static boolean isNullish(Json value) {
        return isUndefined(value) || isNull(value);
    }

    /** JavaScript truthiness. */
    static boolean truthy(Json value) {
        return switch (value) {
            case Json.Undefined u -> false;
            case Json.Null n -> false;
            case Json.Bool b -> b.value();
            case Json.Num n -> !(n.value() == 0 || Double.isNaN(n.value()));
            case Json.Str s -> !s.value().isEmpty();
            case Json.Arr a -> true;
            case Json.Obj o -> true;
        };
    }

    /** {@code typeof v === "number" ? v : <not a number>}. */
    static Double number(Json value) {
        return value.asNumber();
    }

    /** {@code typeof v === "string" ? v : <not a string>}. */
    static String string(Json value) {
        return value.asString();
    }

    /** {@code v === true}. */
    static boolean isTrue(Json value) {
        return value instanceof Json.Bool b && b.value();
    }

    /**
     * A destructured object parameter. {@code ({a, b} = {})} gives a missing argument
     * {@code {}}; {@code ({a, b})} has no default. Destructuring null or undefined THROWS a
     * TypeError before the body runs, so null here means "answer Threw(TypeError)". A
     * primitive destructures to all-undefined fields, which {@link #at} already gives.
     */
    static Json objectParam(Json value, boolean hasDefault) {
        if (isUndefined(value) && hasDefault) return new Json.Obj(Map.of());
        return isNullish(value) ? null : value;
    }

    static HarnessError notRepresentable(String what, Json value) {
        return new HarnessError("E_BAD_CASE", what + " is " + Json.show(Codec.encode(value)) + ", which the typed JVM port has no parameter for");
    }

    /** A value the JS reads as "a number, or null/undefined for none". */
    static Double optionalNumber(Json value, String what) {
        if (isNullish(value)) return null;
        Double n = value.asNumber();
        if (n == null) throw notRepresentable(what, value);
        return n;
    }

    /**
     * A value the JS reads by TRUTHINESS first and then as a number ({@code Number(x || 0)},
     * {@code dur ? dur - 1 : ...}). The port takes a Double and treats null, 0 and NaN as
     * falsy, so a falsy value is null, a number is itself, and a truthy non-number is its
     * ToNumber, unless that is 0 or NaN (truthy in JS, falsy in the port: not representable).
     */
    static Double truthyNumber(Json value, String what) {
        if (!truthy(value)) return null;
        Double n = value.asNumber();
        if (n != null) return n;
        double coerced = toNumber(value);
        if (coerced == 0 || Double.isNaN(coerced)) throw notRepresentable(what, value);
        return coerced;
    }

    /** A value compared with {@code === true} / {@code === false} or with another value strictly: only a real boolean is one. */
    static boolean strictBool(Json value, String what) {
        if (!(value instanceof Json.Bool b)) throw notRepresentable(what, value);
        return b.value();
    }

    /** A Double result: a number, or null. */
    static Json numberOrNull(Double value) {
        return value == null ? Json.NULL : Json.num(value);
    }

    /** A String result: a string, or null. */
    static Json stringOrNull(String value) {
        return value == null ? Json.NULL : Json.str(value);
    }

    /** An object from alternating keys and values, in that order: {@code obj("type", Json.str("idle"))}. */
    static Json obj(Object... keyValues) {
        Map<String, Json> fields = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) fields.put((String) keyValues[i], (Json) keyValues[i + 1]);
        return new Json.Obj(fields);
    }

    /** An array of strings. */
    static Json strings(List<String> values) {
        List<Json> out = new ArrayList<>();
        for (String v : values) out.add(Json.str(v));
        return new Json.Arr(out);
    }

    /** An array of numbers. */
    static Json numbers(List<Double> values) {
        List<Json> out = new ArrayList<>();
        for (Double v : values) out.add(Json.num(v));
        return new Json.Arr(out);
    }

    /** ECMA-262 ToNumber: {@code Number(v)}, and what arithmetic does to an operand. */
    static double toNumber(Json value) {
        return switch (value) {
            case Json.Undefined u -> Double.NaN;
            case Json.Null n -> 0;
            case Json.Bool b -> b.value() ? 1 : 0;
            case Json.Num n -> n.value();
            case Json.Str s -> stringToNumber(s.value());
            case Json.Arr a -> {
                // ToPrimitive(array) is `array.join(",")`: [] is "", [x] is String(x), and
                // two or more elements always hold a comma, which is NaN.
                if (a.items().isEmpty()) yield 0;
                if (a.items().size() > 1) yield Double.NaN;
                Json only = a.items().get(0);
                yield switch (only) {
                    case Json.Undefined u -> 0;
                    case Json.Null n -> 0;
                    case Json.Bool b -> stringToNumber(b.value() ? "true" : "false");
                    case Json.Obj o -> Double.NaN;
                    default -> toNumber(only);
                };
            }
            case Json.Obj o -> Double.NaN; // "[object Object]"
        };
    }

    /**
     * ECMA-262 StringToNumber: trim white space and line terminators; "" is 0; a decimal
     * literal (optionally signed, optionally {@code Infinity}); an unsigned 0x / 0o / 0b
     * integer; anything else is NaN. {@code Double.parseDouble} alone is NOT this: it
     * accepts "NaN", "1d" and hex floats.
     */
    static double stringToNumber(String text) {
        int start = 0;
        int end = text.length();
        while (start < end && Rows.isJSWhitespace(text.charAt(start))) start++;
        while (end > start && Rows.isJSWhitespace(text.charAt(end - 1))) end--;
        String t = text.substring(start, end);
        if (t.isEmpty()) return 0;
        if (t.length() >= 2 && t.charAt(0) == '0') {
            int radix = switch (t.charAt(1)) {
                case 'x', 'X' -> 16;
                case 'o', 'O' -> 8;
                case 'b', 'B' -> 2;
                default -> 0;
            };
            if (radix != 0) {
                if (t.length() == 2) return Double.NaN;
                double value = 0;
                for (int i = 2; i < t.length(); i++) {
                    int digit = Character.digit(t.charAt(i), radix);
                    if (digit < 0 || t.charAt(i) > 'f') return Double.NaN;
                    value = value * radix + digit;
                }
                return value;
            }
        }
        double sign = 1;
        String body = t;
        if (body.charAt(0) == '+' || body.charAt(0) == '-') {
            if (body.charAt(0) == '-') sign = -1;
            body = body.substring(1);
        }
        if (body.equals("Infinity")) return sign * Double.POSITIVE_INFINITY;
        // StrUnsignedDecimalLiteral: digits [. digits] [e [sign] digits], or . digits [...]
        if (!body.matches("([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?")) return Double.NaN;
        return sign * Double.parseDouble(body);
    }
}

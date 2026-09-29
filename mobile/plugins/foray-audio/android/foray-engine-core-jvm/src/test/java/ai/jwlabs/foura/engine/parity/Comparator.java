package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.JSWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * The JVM parity comparator: a line-for-line port of player/parity/compare.js, which
 * is the reference, as ForayEngineParity/Comparator.swift is the Swift one.
 *
 * <p>WHY A PORT AND NOT {@code equals}. Two comparators that disagree make parity a
 * coin toss: a case green in {@code record.mjs --check} and red here says nothing
 * about the RULE. So the rules are compare.js's (exact by default, key order never
 * matters, array order always does, {@code n.*} op tokens stripped outside
 * {@code prepare}, a tolerance never forgives a {@code $num} tag), and the
 * {@code compare} fixture family runs compare.js's own decision table through this
 * port, so a drift between the two turns that family red.
 */
public final class Comparator {
    private Comparator() {}

    /** compare.js NATIVE_TOKEN_PREFIX. */
    public static final String NATIVE_TOKEN_PREFIX = "n.";

    /** compare.js NATIVE_TOKEN_FAMILIES: the families whose op logs KEEP {@code n.*} tokens. */
    public static final List<String> NATIVE_TOKEN_FAMILIES = List.of("prepare");

    /** One difference; {@code expected}/{@code actual} null means absent (compare.js's undefined). */
    public record Difference(String path, Json expected, Json actual, String why) {
        @Override
        public String toString() {
            return path + ": expected " + Json.show(expected) + ", got " + Json.show(actual) + " (" + why + ")";
        }
    }

    /**
     * compare.js {@code compare(expected, actual, {family, tolerance})}. Both sides are
     * ENCODED (tags, not live NaN). Empty = equal.
     */
    public static List<Difference> compare(Json expected, Json actual, String family, Double tolerance) {
        boolean keepNative = family != null && NATIVE_TOKEN_FAMILIES.contains(family);
        // `typeof opts.tolerance === "number" && opts.tolerance >= 0 ? ... : 0`: NaN fails `>= 0` there and here.
        double tol = tolerance != null && tolerance >= 0 ? tolerance : 0;
        List<Difference> diffs = new ArrayList<>();
        walk(expected, actual, "$", null, keepNative, tol, diffs);
        return diffs;
    }

    private static void walk(Json e, Json a, String at, String key, boolean keepNative, double tol, List<Difference> diffs) {
        if (e instanceof Json.Num en && a instanceof Json.Num an) {
            double x = en.value();
            double y = an.value();
            if (x == y) return;
            if (tol > 0 && Math.abs(x - y) <= tol) return;
            diffs.add(new Difference(at, e, a, tol > 0 ? "differs by more than " + JSWriter.numberToString(tol) : "not equal"));
            return;
        }
        if (isSpecialNum(e) || isSpecialNum(a)) {
            // NaN equals only a NaN tag and -0 only a -0 tag; no tolerance, because 0
            // within any tolerance of -0 is the sign bug a -0 case exists to catch.
            if (isSpecialNum(e) && isSpecialNum(a) && strictEquals(e.get("$num"), a.get("$num"))) return;
            diffs.add(new Difference(at, e, a, "special number differs"));
            return;
        }
        if (e instanceof Json.Arr || a instanceof Json.Arr) {
            if (!(e instanceof Json.Arr ea) || !(a instanceof Json.Arr aa)) {
                diffs.add(new Difference(at, e, a, "one side is not an array"));
                return;
            }
            List<Json> el = ea.items();
            List<Json> al = aa.items();
            if ("ops".equals(key) && !keepNative) {
                el = stripNative(el);
                al = stripNative(al);
            }
            if (el.size() != al.size()) {
                diffs.add(new Difference(at, new Json.Arr(el), new Json.Arr(al), "length " + el.size() + " != " + al.size()));
                return;
            }
            for (int i = 0; i < el.size(); i++) walk(el.get(i), al.get(i), at + "[" + i + "]", null, keepNative, tol, diffs);
            return;
        }
        if (e instanceof Json.Obj || a instanceof Json.Obj) {
            if (!(e instanceof Json.Obj eo) || !(a instanceof Json.Obj ao)) {
                diffs.add(new Difference(at, e, a, "one side is not an object"));
                return;
            }
            Map<String, Json> ef = eo.fields();
            Map<String, Json> af = ao.fields();
            // `[...keys].sort()`: UTF-16 code-unit order, which is String.compareTo's.
            TreeSet<String> keys = new TreeSet<>(ef.keySet());
            keys.addAll(af.keySet());
            for (String k : keys) {
                String path = at + "." + k;
                if (!ef.containsKey(k)) diffs.add(new Difference(path, null, af.get(k), "unexpected key"));
                else if (!af.containsKey(k)) diffs.add(new Difference(path, ef.get(k), null, "missing key"));
                else walk(ef.get(k), af.get(k), path, k, keepNative, tol, diffs);
            }
            return;
        }
        if (!strictEquals(e, a)) diffs.add(new Difference(at, e, a, "not equal"));
    }

    /** compare.js isSpecialNum: an object whose ONLY key is {@code $num}. */
    static boolean isSpecialNum(Json value) {
        return value instanceof Json.Obj o && o.fields().size() == 1 && o.fields().containsKey("$num");
    }

    private static List<Json> stripNative(List<Json> ops) {
        List<Json> out = new ArrayList<>();
        for (Json op : ops) {
            String token = op.asString();
            if (token == null || !token.startsWith(NATIVE_TOKEN_PREFIX)) out.add(op);
        }
        return out;
    }

    /**
     * JavaScript {@code ===} between two JSON values: primitives by value (a string by
     * UTF-16 code units, which is String.equals), and an array or object is never
     * {@code ===} a freshly parsed one.
     */
    static boolean strictEquals(Json lhs, Json rhs) {
        if (lhs instanceof Json.Null && rhs instanceof Json.Null) return true;
        if (lhs instanceof Json.Undefined && rhs instanceof Json.Undefined) return true;
        if (lhs instanceof Json.Bool l && rhs instanceof Json.Bool r) return l.value() == r.value();
        if (lhs instanceof Json.Num l && rhs instanceof Json.Num r) return l.value() == r.value();
        if (lhs instanceof Json.Str l && rhs instanceof Json.Str r) return l.value().equals(r.value());
        return false;
    }

    /** compare.js formatDiffs: one line per difference, capped. */
    public static String format(List<Difference> diffs, int max) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < Math.min(max, diffs.size()); i++) {
            if (i > 0) out.append('\n');
            out.append("  ").append(diffs.get(i));
        }
        if (diffs.size() > max) out.append("\n  ... and ").append(diffs.size() - max).append(" more");
        return out.toString();
    }
}

package ai.jwlabs.foura.engine.parity;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The parity codec, ported from player/parity/codec.js (the reference) as the Swift
 * harness ports it (ForayEngineParity/Codec.swift).
 *
 * <p>A fixture is plain JSON, and plain JSON cannot say NaN, Infinity, -0 or
 * undefined, so those travel as the closed {@code $num} / {@code $undefined} tags.
 * {@link #expandInputs} turns a case's inputs into live values (tags decoded, the
 * {@code $seg} / {@code $ep} / {@code $tts} / {@code $foray} macros expanded), and
 * {@link #encode} turns what a port returned back into fixture JSON, so what is
 * compared is exactly what the JS recorder wrote to disk.
 */
public final class Codec {
    private Codec() {}

    /** The tagged encodings of values JSON cannot carry. Closed (codec.js SPECIAL_NUMBERS). */
    public static final List<String> SPECIAL_NUMBERS = List.of("NaN", "Infinity", "-Infinity", "-0");

    /** The input macros. Closed (codec.js MACROS). */
    public static final List<String> MACROS = List.of("$seg", "$ep", "$tts", "$foray");

    /** What expansion needs from outside the case: the repo root, for {@code $foray}. */
    public static final class Context {
        private final Path repoRoot;
        private Map<String, Json> forays;

        public Context(Path repoRoot) {
            this.repoRoot = repoRoot;
        }

        /** The repo root, or null for a run that has none (A-40: the page's Foray builds are read from it). */
        public Path repoRoot() {
            return repoRoot;
        }

        /** codec.js committedForay: data/forays.json, read once per context. */
        Json committedForay(String id) {
            if (forays == null) {
                if (repoRoot == null) throw new HarnessError("E_BAD_MACRO", "$foray needs the repo root, and this run has none");
                Path file = repoRoot.resolve("data").resolve("forays.json");
                Json doc;
                try {
                    doc = Json.parse(Files.readString(file, StandardCharsets.UTF_8));
                } catch (IOException e) {
                    throw new HarnessError("E_BAD_MACRO", "cannot read " + file + ": " + e.getMessage());
                }
                Map<String, Json> byId = new HashMap<>();
                Json list = doc.get("forays");
                if (list != null && list.asList() != null) {
                    for (Json foray : list.asList()) {
                        Json fid = foray.get("id");
                        if (fid != null && fid.asString() != null) byId.put(fid.asString(), foray);
                    }
                }
                forays = byId;
            }
            Json foray = forays.get(id);
            if (foray == null) throw new HarnessError("E_BAD_MACRO", "$foray names \"" + id + "\", which is not in data/forays.json");
            // Values are immutable here, so the JS structuredClone is free.
            return foray;
        }
    }

    /* ---------- encode: what a port returned -> fixture JSON ---------- */

    /** codec.js encode: special numbers and undefined to their tags, object keys sorted, undefined members dropped. */
    public static Json encode(Json value) {
        return switch (value) {
            case Json.Undefined u -> tag("$undefined", Json.TRUE);
            case Json.Null n -> n;
            case Json.Bool b -> b;
            case Json.Str s -> s;
            case Json.Num n -> encodeNumber(n);
            case Json.Arr a -> {
                List<Json> out = new ArrayList<>();
                for (Json item : a.items()) out.add(encode(item));
                yield new Json.Arr(out);
            }
            case Json.Obj o -> {
                // Sorted by UTF-16 code unit, which is String.compareTo's order and
                // `Object.keys(value).sort()`'s.
                Map<String, Json> out = new LinkedHashMap<>();
                for (Map.Entry<String, Json> e : new TreeMap<>(o.fields()).entrySet()) {
                    if (e.getValue() instanceof Json.Undefined) continue;
                    out.put(e.getKey(), encode(e.getValue()));
                }
                yield new Json.Obj(out);
            }
        };
    }

    private static Json encodeNumber(Json.Num n) {
        double d = n.value();
        if (Double.isNaN(d)) return tag("$num", Json.str("NaN"));
        if (d == Double.POSITIVE_INFINITY) return tag("$num", Json.str("Infinity"));
        if (d == Double.NEGATIVE_INFINITY) return tag("$num", Json.str("-Infinity"));
        if (d == 0 && Double.doubleToRawLongBits(d) != 0L) return tag("$num", Json.str("-0"));
        return n;
    }

    private static Json tag(String key, Json value) {
        Map<String, Json> m = new LinkedHashMap<>();
        m.put(key, value);
        return new Json.Obj(m);
    }

    /* ---------- decode: a case's inputs -> live values ---------- */

    /** codec.js decodeSpecial: the special tags only. */
    public static Json decodeSpecial(Json value) {
        if (value instanceof Json.Arr a) {
            List<Json> out = new ArrayList<>();
            for (Json item : a.items()) out.add(decodeSpecial(item));
            return new Json.Arr(out);
        }
        if (!(value instanceof Json.Obj o)) return value;
        Map<String, Json> f = o.fields();
        if (f.size() == 1 && f.containsKey("$num")) return special(f.get("$num"));
        if (f.size() == 1 && f.containsKey("$undefined")) return Json.UNDEFINED;
        Map<String, Json> out = new LinkedHashMap<>();
        for (Map.Entry<String, Json> e : f.entrySet()) out.put(e.getKey(), decodeSpecial(e.getValue()));
        return new Json.Obj(out);
    }

    private static Json special(Json tag) {
        String t = tag.asString();
        if (t == null || !SPECIAL_NUMBERS.contains(t)) {
            throw new HarnessError("E_BAD_SPECIAL", "unknown $num tag " + Json.show(tag));
        }
        return switch (t) {
            case "NaN" -> Json.num(Double.NaN);
            case "Infinity" -> Json.num(Double.POSITIVE_INFINITY);
            case "-Infinity" -> Json.num(Double.NEGATIVE_INFINITY);
            default -> Json.num(-0.0);
        };
    }

    /** codec.js expandInputs: macros and special tags in a case's inputs, to live values. */
    public static Json expandInputs(Json value, Context ctx) {
        if (value instanceof Json.Arr a) {
            List<Json> out = new ArrayList<>();
            for (Json item : a.items()) out.add(expandInputs(item, ctx));
            return new Json.Arr(out);
        }
        if (!(value instanceof Json.Obj o)) return value;
        Map<String, Json> f = o.fields();
        if (f.size() == 1) {
            String k = f.keySet().iterator().next();
            if (k.startsWith("$")) {
                if (k.equals("$num") || k.equals("$undefined")) return decodeSpecial(value);
                if (MACROS.contains(k)) return expandMacro(k, f.get(k), ctx);
                throw new HarnessError("E_BAD_MACRO", "unknown tag " + k);
            }
        }
        Map<String, Json> out = new LinkedHashMap<>();
        for (Map.Entry<String, Json> e : f.entrySet()) {
            if (e.getKey().startsWith("$")) {
                throw new HarnessError("E_BAD_MACRO", "a tag (" + e.getKey() + ") must be the only key of its object");
            }
            out.put(e.getKey(), expandInputs(e.getValue(), ctx));
        }
        return new Json.Obj(out);
    }

    private static Json expandMacro(String name, Json arg, Context ctx) {
        switch (name) {
            case "$seg" -> {
                // The shape every player suite calls seg(): defaults match seam-gap.test.js's seg(id, 100, 210).
                List<Json> t = tuple(name, arg, 1, 4);
                Map<String, Json> m = new LinkedHashMap<>();
                m.put("id", t.get(0));
                m.put("kind", Json.str("episode"));
                m.put("start_sec", t.size() > 1 ? decodeSpecial(t.get(1)) : Json.num(100));
                m.put("end_sec", t.size() > 2 ? decodeSpecial(t.get(2)) : Json.num(210));
                m.putAll(extra(name, t.size() > 3 ? t.get(3) : null, ctx));
                return new Json.Obj(m);
            }
            case "$ep", "$tts" -> {
                List<Json> t = tuple(name, arg, 1, 2);
                Map<String, Json> m = new LinkedHashMap<>();
                m.put("id", t.get(0));
                m.put("kind", Json.str(name.equals("$ep") ? "episode" : "tts"));
                m.putAll(extra(name, t.size() > 1 ? t.get(1) : null, ctx));
                return new Json.Obj(m);
            }
            case "$foray" -> {
                if (arg instanceof Json.Str s) return ctx.committedForay(s.value());
                if (arg instanceof Json.Obj o && o.fields().get("id") instanceof Json.Str
                        && o.fields().get("items") instanceof Json.Arr) {
                    Map<String, Json> m = new LinkedHashMap<>();
                    m.put("title", Json.str(""));
                    m.putAll(expandInputs(arg, ctx).asMap());
                    return new Json.Obj(m);
                }
                throw new HarnessError("E_BAD_MACRO", "$foray takes a committed Foray id or {id, title?, items[]}");
            }
            default -> throw new HarnessError("E_BAD_MACRO", "unknown macro " + name);
        }
    }

    private static List<Json> tuple(String name, Json arg, int min, int max) {
        List<Json> items = arg.asList();
        if (items == null || items.size() < min || items.size() > max) {
            throw new HarnessError("E_BAD_MACRO", name + " takes an array of " + min + "-" + max + " elements, got " + Json.show(arg));
        }
        return items;
    }

    private static Map<String, Json> extra(String name, Json more, Context ctx) {
        if (more == null) return new LinkedHashMap<>();
        if (!(more instanceof Json.Obj)) {
            throw new HarnessError("E_BAD_MACRO", name + "'s last element must be an object of extra fields");
        }
        return expandInputs(more, ctx).asMap();
    }
}

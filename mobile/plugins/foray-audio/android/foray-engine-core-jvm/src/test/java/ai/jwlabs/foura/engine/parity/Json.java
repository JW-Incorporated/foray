package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.JSWriter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A JSON value, and a JavaScript value the port produced: the JVM twin of the Swift
 * harness's {@code JSONValue} (ForayEngineParity/JSONValue.swift).
 *
 * <p>ONE MODEL FOR BOTH SIDES OF THE CODEC. A fixture holds plain JSON; a live value
 * (what a case's {@code args} expand to, and what a port returns) can also be
 * {@code undefined}, NaN, an infinity or {@code -0}. Those are {@link Undefined} and
 * a {@link Num} holding the special double, and {@link Codec#encode} turns them back
 * into the {@code $num} / {@code $undefined} tags a fixture spells them with. Sealed,
 * so every {@code switch} over a value is checked for exhaustiveness by javac.
 *
 * <p>A hand-written parser, because the JVM core has no dependencies at all
 * (shell-invariants.test.mjs pins {@code testImplementation} to JUnit alone), and
 * because every number must arrive as the IEEE double JavaScript's {@code JSON.parse}
 * makes of it: an integer literal is a double here as it is there.
 */
public sealed interface Json permits Json.Null, Json.Undefined, Json.Bool, Json.Num, Json.Str, Json.Arr, Json.Obj {
    record Null() implements Json {}

    record Undefined() implements Json {}

    record Bool(boolean value) implements Json {}

    record Num(double value) implements Json {}

    record Str(String value) implements Json {}

    /** Unmodifiable. */
    record Arr(List<Json> items) implements Json {
        public Arr {
            items = Collections.unmodifiableList(new ArrayList<>(items));
        }
    }

    /** Unmodifiable, and in insertion (source) order; comparison never depends on it. */
    record Obj(Map<String, Json> fields) implements Json {
        public Obj {
            fields = Collections.unmodifiableMap(new LinkedHashMap<>(fields));
        }
    }

    Json NULL = new Null();
    Json UNDEFINED = new Undefined();
    Json TRUE = new Bool(true);
    Json FALSE = new Bool(false);

    static Json num(double value) {
        return new Num(value);
    }

    static Json str(String value) {
        return new Str(value);
    }

    /** A member of an object, or null when this is not an object or has no such key. */
    default Json get(String key) {
        return this instanceof Obj o ? o.fields().get(key) : null;
    }

    /** The string, or null when this is not a string. */
    default String asString() {
        return this instanceof Str s ? s.value() : null;
    }

    /** The number, or null when this is not a number. */
    default Double asNumber() {
        return this instanceof Num n ? n.value() : null;
    }

    /** The items, or null when this is not an array. */
    default List<Json> asList() {
        return this instanceof Arr a ? a.items() : null;
    }

    /** The fields, or null when this is not an object. */
    default Map<String, Json> asMap() {
        return this instanceof Obj o ? o.fields() : null;
    }

    /** Compact JSON for a failure message. Special numbers print as their tag's spelling. */
    static String show(Json value) {
        if (value == null) return "undefined";
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }

    private static void write(Json value, StringBuilder out) {
        switch (value) {
            case Null ignored -> out.append("null");
            case Undefined ignored -> out.append("undefined");
            case Bool b -> out.append(b.value());
            case Num n -> out.append(JSWriter.numberToString(n.value()));
            case Str s -> quote(s.value(), out);
            case Arr a -> {
                out.append('[');
                for (int i = 0; i < a.items().size(); i++) {
                    if (i > 0) out.append(',');
                    write(a.items().get(i), out);
                }
                out.append(']');
            }
            case Obj o -> {
                out.append('{');
                boolean first = true;
                for (Map.Entry<String, Json> e : o.fields().entrySet()) {
                    if (!first) out.append(',');
                    first = false;
                    quote(e.getKey(), out);
                    out.append(':');
                    write(e.getValue(), out);
                }
                out.append('}');
            }
        }
    }

    /** JSON string quoting (JSON.stringify's QuoteJSONString, lower-case hex). */
    static void quote(String text, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\t' -> out.append("\\t");
                case '\n' -> out.append("\\n");
                case '\f' -> out.append("\\f");
                case '\r' -> out.append("\\r");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    /** Parse one JSON document. Throws {@link HarnessError} {@code E_BAD_CASE} on malformed input. */
    static Json parse(String text) {
        Parser p = new Parser(text);
        p.skipSpace();
        Json value = p.value();
        p.skipSpace();
        if (p.at < text.length()) throw p.error("trailing characters");
        return value;
    }

    /** A recursive-descent reader over RFC 8259 JSON. */
    final class Parser {
        private final String s;
        private int at;

        Parser(String s) {
            this.s = s;
        }

        HarnessError error(String why) {
            return new HarnessError("E_BAD_CASE", "malformed JSON at offset " + at + ": " + why);
        }

        void skipSpace() {
            while (at < s.length()) {
                char c = s.charAt(at);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at++;
                else break;
            }
        }

        Json value() {
            if (at >= s.length()) throw error("unexpected end");
            char c = s.charAt(at);
            switch (c) {
                case '{':
                    return object();
                case '[':
                    return array();
                case '"':
                    return new Str(string());
                case 't':
                    literal("true");
                    return TRUE;
                case 'f':
                    literal("false");
                    return FALSE;
                case 'n':
                    literal("null");
                    return NULL;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return number();
                    throw error("unexpected '" + c + "'");
            }
        }

        private void literal(String word) {
            if (!s.startsWith(word, at)) throw error("expected " + word);
            at += word.length();
        }

        private Json object() {
            at++;
            Map<String, Json> fields = new LinkedHashMap<>();
            skipSpace();
            if (peek() == '}') {
                at++;
                return new Obj(fields);
            }
            while (true) {
                skipSpace();
                if (peek() != '"') throw error("expected a key");
                String key = string();
                skipSpace();
                if (peek() != ':') throw error("expected ':'");
                at++;
                skipSpace();
                fields.put(key, value());
                skipSpace();
                char c = peek();
                at++;
                if (c == '}') return new Obj(fields);
                if (c != ',') throw error("expected ',' or '}'");
            }
        }

        private Json array() {
            at++;
            List<Json> items = new ArrayList<>();
            skipSpace();
            if (peek() == ']') {
                at++;
                return new Arr(items);
            }
            while (true) {
                skipSpace();
                items.add(value());
                skipSpace();
                char c = peek();
                at++;
                if (c == ']') return new Arr(items);
                if (c != ',') throw error("expected ',' or ']'");
            }
        }

        private char peek() {
            if (at >= s.length()) throw error("unexpected end");
            return s.charAt(at);
        }

        private String string() {
            at++;
            StringBuilder out = new StringBuilder();
            while (true) {
                char c = peek();
                at++;
                if (c == '"') return out.toString();
                if (c < 0x20) throw error("control character in a string");
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char e = peek();
                at++;
                switch (e) {
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    case '/' -> out.append('/');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'u' -> {
                        if (at + 4 > s.length()) throw error("short \\u escape");
                        try {
                            out.append((char) Integer.parseInt(s.substring(at, at + 4), 16));
                        } catch (NumberFormatException bad) {
                            throw error("bad \\u escape");
                        }
                        at += 4;
                    }
                    default -> throw error("bad escape \\" + e);
                }
            }
        }

        private Json number() {
            int start = at;
            if (peek() == '-') at++;
            while (at < s.length() && "0123456789+-.eE".indexOf(s.charAt(at)) >= 0) at++;
            String token = s.substring(start, at);
            if (!token.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) throw error("bad number " + token);
            return new Num(Double.parseDouble(token));
        }
    }
}

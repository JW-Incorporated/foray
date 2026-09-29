package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A JSON value whose objects keep their members IN ORDER: what a row builder produces,
 * what {@link JSWriter#stringify} prints and what {@link #parse} reads back. The JVM twin
 * of {@code JSONNode} in ForayEngineCore (Persist/JSWriter.swift, NE-10s).
 *
 * <p>Ordered because a shared row's bytes are its builder's insertion order
 * ({@code seconds, duration, updated_at, source}), and a map would lose it.
 *
 * <p>STRINGS ARE UTF-16, AS JAVASCRIPT'S ARE. A Swift String cannot hold a lone
 * surrogate, so the Swift port reads an escaped lone surrogate as U+FFFD; a Java
 * String can, so this one keeps it exactly as {@code JSON.parse} does, and
 * {@link JSWriter#quote} writes it back as {@code JSON.stringify} does.
 */
public sealed interface JsonNode permits JsonNode.Null, JsonNode.Bool, JsonNode.Num, JsonNode.Str, JsonNode.Arr, JsonNode.Obj {
    record Null() implements JsonNode {}

    record Bool(boolean value) implements JsonNode {}

    /** Printed by ECMAScript Number::toString; NaN and the infinities print as {@code null}. */
    record Num(double value) implements JsonNode {}

    record Str(String value) implements JsonNode {}

    /** Unmodifiable. */
    record Arr(List<JsonNode> items) implements JsonNode {
        public Arr {
            items = Collections.unmodifiableList(new ArrayList<>(items));
        }
    }

    /**
     * Members in insertion order, unmodifiable. A builder never repeats a key (a JS
     * object cannot hold one twice); {@link #parse} folds a repeated key the way
     * {@code JSON.parse} does.
     */
    record Obj(List<Member> members) implements JsonNode {
        public Obj {
            members = Collections.unmodifiableList(new ArrayList<>(members));
        }
    }

    record Member(String key, JsonNode value) {}

    JsonNode NULL = new Null();
    JsonNode TRUE = new Bool(true);
    JsonNode FALSE = new Bool(false);

    static JsonNode num(double value) {
        return new Num(value);
    }

    static JsonNode str(String value) {
        return new Str(value);
    }

    static JsonNode bool(boolean value) {
        return value ? TRUE : FALSE;
    }

    static Member member(String key, JsonNode value) {
        return new Member(key, value);
    }

    /** {@code value[key]} on an object: the member's value, or null for a missing key and for any non-object. */
    default JsonNode get(String key) {
        if (!(this instanceof Obj o)) return null;
        JsonNode found = null;
        for (Member m : o.members()) if (m.key().equals(key)) found = m.value();
        return found;
    }

    /** JavaScript truthiness, {@code if (value)}. Absent ({@code undefined}) is the caller's null, which is falsy too. */
    default boolean isTruthy() {
        return switch (this) {
            case Null n -> false;
            case Bool b -> b.value();
            case Num n -> !(n.value() == 0 || Double.isNaN(n.value()));
            case Str s -> !s.value().isEmpty();
            case Arr a -> true;
            case Obj o -> true;
        };
    }

    default String stringValue() {
        return this instanceof Str s ? s.value() : null;
    }

    /** The number, when this is one ({@code typeof value === "number"}). */
    default Double numberValue() {
        return this instanceof Num n ? n.value() : null;
    }

    default List<JsonNode> arrayValue() {
        return this instanceof Arr a ? a.items() : null;
    }

    default List<Member> members() {
        return this instanceof Obj o ? o.members() : null;
    }

    /** A {@code JSON.parse} SyntaxError: where, and why. */
    final class ParseError extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        public final int offset;

        ParseError(int offset, String reason) {
            super("JSON.parse: " + reason + " at code unit " + offset);
            this.offset = offset;
        }
    }

    /**
     * {@code JSON.parse(text)}, keeping object members in their order. Throws
     * {@link ParseError} wherever {@code JSON.parse} throws a SyntaxError: a trailing
     * comma, a single quote, a leading zero, {@code NaN}, an unescaped control character,
     * trailing text. A key given twice keeps its FIRST position and its LAST value, which
     * is what {@code JSON.parse} builds.
     */
    static JsonNode parse(String text) {
        Reader reader = new Reader(text);
        reader.skipSpace();
        JsonNode value = reader.value(0);
        reader.skipSpace();
        if (!reader.atEnd()) throw reader.fail("unexpected text after the value");
        return value;
    }

    /** {@link #parse}, or null where it throws: Swift's {@code try? JSONNode.parse(raw)}. */
    static JsonNode tryParse(String text) {
        if (text == null) return null;
        try {
            return parse(text);
        } catch (ParseError e) {
            return null;
        }
    }

    /** A recursive-descent reader over JSON's grammar, strictly. */
    final class Reader {
        /** Deeper than any row, shallow enough that a hostile row cannot blow the stack. */
        static final int MAX_DEPTH = 512;

        private final String s;
        private int at;

        Reader(String s) {
            this.s = s;
        }

        boolean atEnd() {
            return at >= s.length();
        }

        private int current() {
            return at < s.length() ? s.charAt(at) : -1;
        }

        ParseError fail(String reason) {
            return new ParseError(at, reason);
        }

        /** JSON's whitespace is these four and nothing else (not U+00A0, not U+FEFF). */
        void skipSpace() {
            while (at < s.length()) {
                char c = s.charAt(at);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at++;
                else break;
            }
        }

        private void expect(String word) {
            for (int i = 0; i < word.length(); i++) {
                if (current() != word.charAt(i)) throw fail("expected " + word);
                at++;
            }
        }

        JsonNode value(int depth) {
            if (depth >= MAX_DEPTH) throw fail("nested too deeply");
            int c = current();
            if (c < 0) throw fail("unexpected end of input");
            switch (c) {
                case '{':
                    return object(depth);
                case '[':
                    return array(depth);
                case '"':
                    return new Str(string());
                case 't':
                    expect("true");
                    return TRUE;
                case 'f':
                    expect("false");
                    return FALSE;
                case 'n':
                    expect("null");
                    return NULL;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return new Num(number());
                    throw fail("unexpected character");
            }
        }

        private JsonNode object(int depth) {
            at++; // {
            List<Member> members = new ArrayList<>();
            skipSpace();
            if (current() == '}') {
                at++;
                return new Obj(members);
            }
            while (true) {
                skipSpace();
                if (current() != '"') throw fail("expected a key");
                String key = string();
                skipSpace();
                if (current() != ':') throw fail("expected :");
                at++;
                skipSpace();
                JsonNode member = value(depth + 1);
                int existing = -1;
                for (int i = 0; i < members.size(); i++) {
                    if (members.get(i).key().equals(key)) {
                        existing = i;
                        break;
                    }
                }
                if (existing >= 0) members.set(existing, new Member(key, member));
                else members.add(new Member(key, member));
                skipSpace();
                if (current() == ',') {
                    at++;
                    continue;
                }
                if (current() == '}') {
                    at++;
                    return new Obj(members);
                }
                throw fail("expected , or }");
            }
        }

        private JsonNode array(int depth) {
            at++; // [
            List<JsonNode> items = new ArrayList<>();
            skipSpace();
            if (current() == ']') {
                at++;
                return new Arr(items);
            }
            while (true) {
                skipSpace();
                items.add(value(depth + 1));
                skipSpace();
                if (current() == ',') {
                    at++;
                    continue;
                }
                if (current() == ']') {
                    at++;
                    return new Arr(items);
                }
                throw fail("expected , or ]");
            }
        }

        private String string() {
            at++; // opening quote
            StringBuilder out = new StringBuilder();
            while (true) {
                int c = current();
                if (c < 0) throw fail("unterminated string");
                at++;
                if (c == '"') return out.toString();
                if (c == '\\') {
                    int e = current();
                    if (e < 0) throw fail("unterminated escape");
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
                        // A code unit, as JSON.parse keeps it: a surrogate pair written as two
                        // escapes is two units that pair up, and a lone one stays lone.
                        case 'u' -> out.append((char) hex4());
                        default -> throw fail("bad escape");
                    }
                } else {
                    if (c < 0x20) throw fail("unescaped control character");
                    out.append((char) c);
                }
            }
        }

        private int hex4() {
            if (at + 4 > s.length()) throw fail("short \\u escape");
            int value = 0;
            for (int i = 0; i < 4; i++) {
                int digit = Character.digit(s.charAt(at + i), 16);
                // Character.digit also accepts full-width and other scripts' digits; JSON does not.
                if (digit < 0 || s.charAt(at + i) > 'f') throw fail("bad \\u escape");
                value = value * 16 + digit;
            }
            at += 4;
            return value;
        }

        private int digitRun() {
            int count = 0;
            while (current() >= '0' && current() <= '9') {
                at++;
                count++;
            }
            return count;
        }

        /**
         * JSON's number grammar, strictly: {@code -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?}.
         * {@code Double.parseDouble} rounds correctly, as JSON.parse does, and reads a
         * magnitude out of range as an infinity or a zero, as JSON.parse does.
         */
        private double number() {
            int start = at;
            if (current() == '-') at++;
            if (current() == '0') {
                at++;
            } else if (digitRun() == 0) {
                throw fail("expected a digit");
            }
            if (current() == '.') {
                at++;
                if (digitRun() == 0) throw fail("expected a digit after .");
            }
            if (current() == 'e' || current() == 'E') {
                at++;
                if (current() == '+' || current() == '-') at++;
                if (digitRun() == 0) throw fail("expected an exponent");
            }
            return Double.parseDouble(s.substring(start, at));
        }
    }
}

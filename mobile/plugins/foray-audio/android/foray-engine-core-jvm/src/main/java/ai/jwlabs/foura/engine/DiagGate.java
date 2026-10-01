package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * What an engine diagnostics row may CONTAIN: the JVM port of {@code DiagGate}
 * (ForayEngineCore, Diag/DiagGate.swift, NE-19; docs/native-engine-plan.md §4.5, §10), card
 * A-60. Every row the Android engine hands the page ({@code engineRead("diagnostics")}, the rows
 * a Copy prints and a founder pastes into a public GitHub issue) passes through {@link #admit} on
 * its way into the DiagRow ring ({@code EngineLog}), exactly as every iOS row passes through the
 * Swift gate into {@code DiagRing}.
 *
 * <p>THE RULES, and the leak each one closes (the Swift header has the long form):
 * <ol>
 *   <li>A field whose value belongs to a closed vocabulary is admitted ONLY through
 *       {@link Vocabulary#SETS}, exactly (a {@code cause}, a {@code source}, a seam's
 *       {@code stages}, a {@code mode} row's {@code reason}, an interruption's {@code reason}, a
 *       session {@code error}, a {@code narration} row's fallback {@code cause}). A misspelt
 *       token is dropped, never "fixed".
 *   <li>Every other string must be a TOKEN: ASCII letters, digits and {@code ._:-}, at most 64
 *       characters. That excludes every URL, sentence, e-mail and device name with a space in it.
 *   <li>A {@code route} or {@code port} is a PORT TYPE: letters and digits only.
 *   <li>A key that names a URL or a name ({@code audio_url}, {@code routeName}) is dropped
 *       whatever its value.
 *   <li>The ONLY free text is the three Now Playing strings of a {@code nowplaying} row, trimmed
 *       and capped at 40.
 * </ol>
 *
 * <p>NOTHING IS DROPPED SILENTLY: a refused field is named in the row's {@code dropped} list. A
 * row whose KIND is not a token is refused whole (null).
 *
 * <p>THE SUB-KIND. A field called {@code kind} is the row's sub-kind ({@code deck kind=attach}),
 * but {@code kind} is also the DiagRow header's, so the gate writes it as {@code event}:
 * {@code {"kind":"deck","event":"attach",...}}. Before A-60 the Android ring dropped the sub-kind
 * as a header shadow, so a Copy printed {@code deck src=engine token=1 ...} with no word saying
 * which deck row it was, and no NE-38e verdict could read it.
 */
public final class DiagGate {
    private DiagGate() {}

    /** The row kind whose {@code title}, {@code artist} and {@code album} may be free text. */
    public static final String NOW_PLAYING_KIND = "nowplaying";
    public static final Set<String> NOW_PLAYING_TEXT_FIELDS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList("title", "artist", "album")));
    /** diagnostic-log.js {@code NOWPLAYING_FIELD_MAX}. */
    public static final int NOW_PLAYING_TEXT_MAX = 40;
    public static final int TOKEN_MAX = 64;
    public static final int PORT_TYPE_MAX = 40;
    /** Where an entry's own {@code kind} field goes. */
    public static final String SUB_KIND_FIELD = "event";
    /** The list of refused field names every lossy row carries. */
    public static final String DROPPED_FIELD = "dropped";
    /** A DiagRow's header ({@code DiagRow.headerKeys}): a field may not shadow one. */
    public static final Set<String> HEADER_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList("seq", "at", "mono", "kind")));
    /** Nested objects deeper than this are dropped. */
    static final int MAX_DEPTH = 3;

    /** The entry as the ring may store it, or null when its kind is not a token. */
    public static EngineCommand.DiagEntry admit(EngineCommand.DiagEntry entry) {
        if (entry == null || !isToken(entry.kind())) return null;
        JsonNode eventNode = entry.field("kind");
        String event = eventNode instanceof JsonNode.Str s ? s.value() : null;
        List<JsonNode.Member> kept = new ArrayList<>();
        List<String> dropped = new ArrayList<>();
        for (JsonNode.Member member : entry.fields()) {
            String key = member.key().equals("kind") ? SUB_KIND_FIELD : member.key();
            if (!isToken(key)) {
                dropped.add("invalid-key");
                continue;
            }
            if (HEADER_KEYS.contains(key) || key.equals(DROPPED_FIELD) || isForbiddenKey(key) || has(kept, key)) {
                dropped.add(key);
                continue;
            }
            Admitted admitted = admitValue(member.value(), new Scope(entry.kind(), event, key), 0);
            if (admitted.value != null) kept.add(JsonNode.member(key, admitted.value));
            if (admitted.value == null || admitted.lossy) dropped.add(key);
        }
        if (!dropped.isEmpty()) {
            List<JsonNode> names = new ArrayList<>();
            for (String d : dropped) names.add(JsonNode.str(d));
            kept.add(JsonNode.member(DROPPED_FIELD, new JsonNode.Arr(names)));
        }
        return new EngineCommand.DiagEntry(entry.kind(), kept);
    }

    /** Rule 2: 1..64 of {@code [0-9A-Za-z._:-]}. */
    public static boolean isToken(String text) {
        if (text == null || text.isEmpty() || text.length() > TOKEN_MAX) return false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '_'
                    || c == ':' || c == '-';
            if (!ok) return false;
        }
        return true;
    }

    /** Rule 3: a port type, letters and digits only, at most 40. */
    public static boolean isPortType(String text) {
        if (text == null || text.isEmpty() || text.length() > PORT_TYPE_MAX) return false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
            if (!ok) return false;
        }
        return true;
    }

    /** Rule 4. */
    static boolean isForbiddenKey(String key) {
        String lower = key.toLowerCase(Locale.ROOT);
        return lower.contains("url") || lower.contains("name");
    }

    /** Rule 1: the closed set a field is admitted through, if any. */
    public static String vocabularySet(String kind, String event, String key) {
        // A `narration` row's `cause` is the fallback's (A-64, mirrors NE-39n: `narration
        // kind=fallback cause=offline`), not a stop cause. Before the generic `cause` below, or
        // every fallback cause (none is a stop cause) is dropped at the ring and the paste never
        // says why a line fell back.
        if ("narration".equals(kind) && "cause".equals(key)) return "narrationFallbackCause";
        switch (key) {
            case "cause":
                return "stopCause";
            case "source":
                return "source";
            case "stages":
                return "stage";
            default:
                break;
        }
        if ("mode".equals(kind) && "reason".equals(key)) return "modeReason";
        if ("session".equals(kind) && "error".equals(key)) return "sessionError";
        if ("session".equals(kind) && "reason".equals(key) && "interruption".equals(event)) return "interruptionReason";
        return null;
    }

    /** Rule 5, {@code nowPlayingFieldOf}: trimmed, and past 40 UTF-16 units cut to 39 plus an ellipsis. */
    public static String nowPlayingText(String text) {
        String trimmed = EngineItem.jsTrim(text);
        if (trimmed.length() <= NOW_PLAYING_TEXT_MAX) return trimmed;
        String head = trimmed.substring(0, NOW_PLAYING_TEXT_MAX - 1);
        if (Character.isHighSurrogate(head.charAt(head.length() - 1))) head = head.substring(0, head.length() - 1);
        return head + "…";
    }

    private record Scope(String kind, String event, String key) {}

    /** A value as admitted (null: refused whole) and whether anything inside it was dropped. */
    private record Admitted(JsonNode value, boolean lossy) {}

    private static Admitted admitValue(JsonNode value, Scope scope, int depth) {
        String set = vocabularySet(scope.kind, scope.event, scope.key);
        if (set != null) return admitTokens(value, set);
        if (NOW_PLAYING_KIND.equals(scope.kind) && NOW_PLAYING_TEXT_FIELDS.contains(scope.key) && depth == 0) {
            if (value instanceof JsonNode.Null) return new Admitted(JsonNode.NULL, false);
            if (value instanceof JsonNode.Str s) return new Admitted(JsonNode.str(nowPlayingText(s.value())), false);
            return new Admitted(null, false);
        }
        return switch (value) {
            case JsonNode.Null n -> new Admitted(value, false);
            case JsonNode.Bool b -> new Admitted(value, false);
            case JsonNode.Num n -> Double.isFinite(n.value()) ? new Admitted(value, false) : new Admitted(JsonNode.NULL, true);
            case JsonNode.Str s -> {
                boolean port = scope.key.equals("route") || scope.key.equals("port") || scope.key.equals("routePort");
                boolean ok = port ? isPortType(s.value()) : isToken(s.value());
                yield new Admitted(ok ? value : null, false);
            }
            case JsonNode.Arr a -> {
                boolean lossy = false;
                List<JsonNode> kept = new ArrayList<>();
                for (JsonNode item : a.items()) {
                    Admitted inner = admitValue(item, scope, depth + 1);
                    if (inner.value != null) kept.add(inner.value);
                    else lossy = true;
                    lossy = lossy || inner.lossy;
                }
                yield new Admitted(new JsonNode.Arr(kept), lossy);
            }
            case JsonNode.Obj o -> {
                if (depth >= MAX_DEPTH) yield new Admitted(null, false);
                boolean lossy = false;
                List<JsonNode.Member> kept = new ArrayList<>();
                for (JsonNode.Member member : o.members()) {
                    if (!isToken(member.key()) || isForbiddenKey(member.key()) || has(kept, member.key())) {
                        lossy = true;
                        continue;
                    }
                    Admitted inner = admitValue(member.value(), new Scope(scope.kind, scope.event, member.key()), depth + 1);
                    if (inner.value != null) kept.add(JsonNode.member(member.key(), inner.value));
                    else lossy = true;
                    lossy = lossy || inner.lossy;
                }
                yield new Admitted(new JsonNode.Obj(kept), lossy);
            }
        };
    }

    /** A vocabulary-bound value: a token of the set, null, or an array of them, any other token removed. */
    private static Admitted admitTokens(JsonNode value, String set) {
        List<String> tokens = Vocabulary.SETS.get(set);
        if (value instanceof JsonNode.Null) return new Admitted(JsonNode.NULL, false);
        if (value instanceof JsonNode.Str s) return new Admitted(tokens.contains(s.value()) ? value : null, false);
        if (value instanceof JsonNode.Arr a) {
            List<JsonNode> kept = new ArrayList<>();
            for (JsonNode item : a.items()) {
                if (item instanceof JsonNode.Str s && tokens.contains(s.value())) kept.add(item);
            }
            return new Admitted(new JsonNode.Arr(kept), kept.size() != a.items().size());
        }
        return new Admitted(null, false);
    }

    private static boolean has(List<JsonNode.Member> members, String key) {
        for (JsonNode.Member m : members) if (m.key().equals(key)) return true;
        return false;
    }
}

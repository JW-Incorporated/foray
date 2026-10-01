package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DECODING THE CONTRACT (card A-28, docs/plans/android-assessment.md §5.4; the protocol is
 * docs/native-engine-plan.md §5.1-§5.4): the JVM twin of ContractDecoding.swift (NE-11s).
 *
 * <p>Every payload that crosses the engineHello / engineSend / engineRead bridge and the
 * "engine" event, decoded into a typed value or REFUSED. The rule for accepting one is the
 * page's ({@code player/parity/schema/engine-contract.schema.json}, generated from
 * engine-contract.js), whose every valid and invalid example is one case of the
 * {@code contract} or {@code snapshot} parity family. So an engineSend the page believes it
 * may send is one the engine decodes, and a snapshot the engine sends is one the page
 * believes.
 *
 * <p>THE SCHEMA'S RULES, AS READ HERE (the Swift file's, unchanged):
 * <ul>
 *   <li>unknown KEYS are allowed everywhere (an added field is not a protocol change);
 *       unknown VALUES in a closed set are refused;</li>
 *   <li>{@code integer} is a finite whole number, read into a {@code long}, so a whole number
 *       beyond its range (about 9.2e18, which no sender writes) is refused where the page
 *       would accept it, exactly as the Swift {@code Int} does;</li>
 *   <li>{@code number} is finite; {@code nonNegative} is {@code >= 0} (so -0 passes, as in
 *       JS);</li>
 *   <li>a string's {@code minLength: 1} is "not empty";</li>
 *   <li>a key that is absent is not checked; a key that is present is checked, required or
 *       not (a {@code snapshot} inside a legacy hello must still be one).</li>
 * </ul>
 *
 * <p>A {@code true} is never a number and a {@code 1} never a boolean: {@link JsonNode} keeps
 * the JSON types apart, so there is nothing to guess.
 */
public final class ContractDecoding {
    private ContractDecoding() {}

    /**
     * Why a payload was refused: where (a JSON-pointer-ish path, "" for the payload itself) and
     * what rule it broke. For a diagnostics row; parity compares only accept / refuse.
     */
    public static final class ContractError extends Exception {
        private static final long serialVersionUID = 1L;
        public final String path;
        public final String reason;

        public ContractError(String path, String reason) {
            super((path.isEmpty() ? "(payload)" : path) + ": " + reason);
            this.path = path;
            this.reason = reason;
        }
    }

    /** One of the schema's leaf rules: reads one value at {@code path} or refuses it. */
    @FunctionalInterface
    interface Reader<T> {
        T read(JsonNode node, String path) throws ContractError;
    }

    static ContractError fail(String path, String reason) {
        return new ContractError(path, reason);
    }

    // ---- the leaf rules

    static String string(JsonNode node, String path) throws ContractError {
        if (!(node instanceof JsonNode.Str s)) throw fail(path, "must be a string");
        return s.value();
    }

    static String nonEmptyString(JsonNode node, String path) throws ContractError {
        String text = string(node, path);
        if (text.isEmpty()) throw fail(path, "must not be empty");
        return text;
    }

    static boolean bool(JsonNode node, String path) throws ContractError {
        if (!(node instanceof JsonNode.Bool b)) throw fail(path, "must be a boolean");
        return b.value();
    }

    /** {@code type: number}: JSON has no NaN or Infinity, so a value that cannot be written cannot have come from it. */
    static double number(JsonNode node, String path) throws ContractError {
        if (!(node instanceof JsonNode.Num n) || Double.isNaN(n.value()) || Double.isInfinite(n.value())) {
            throw fail(path, "must be a finite number");
        }
        return n.value();
    }

    static double nonNegative(JsonNode node, String path) throws ContractError {
        double value = number(node, path);
        if (value < 0) throw fail(path, "must be >= 0");
        return value;
    }

    /** {@code exclusiveMinimum: 0}. */
    static double positive(JsonNode node, String path) throws ContractError {
        double value = number(node, path);
        if (!(value > 0)) throw fail(path, "must be > 0");
        return value;
    }

    /** 2^63: the first double a {@code long} cannot hold. */
    private static final double LONG_LIMIT = 9.223372036854775808E18;

    /** {@code type: integer, minimum: <min>}. */
    static Reader<Long> integer(long min) {
        return (node, path) -> {
            double value = number(node, path);
            if (Math.floor(value) != value) throw fail(path, "must be a whole number");
            if (!(value >= -LONG_LIMIT && value < LONG_LIMIT)) throw fail(path, "is beyond the engine's integer range");
            long whole = (long) value;
            if (whole < min) throw fail(path, "must be >= " + min);
            return whole;
        };
    }

    static final Reader<Long> NON_NEGATIVE_INT = integer(0);

    /** {@code enum: [...]} over strings: a closed set of values. */
    static Reader<String> token(List<String> set) {
        return (node, path) -> {
            if (!(node instanceof JsonNode.Str s) || !set.contains(s.value())) {
                throw fail(path, JSWriter.stringify(node) + " is not one of the closed set");
            }
            return s.value();
        };
    }

    /** {@code pattern: ^(forever|none|until:[1-9][0-9]{0,5})$}. */
    static SessionPolicy.HoldPolicy holdPolicy(JsonNode node, String path) throws ContractError {
        SessionPolicy.HoldPolicy policy = SessionPolicy.HoldPolicy.parse(string(node, path));
        if (policy == null) throw fail(path, "is not forever, none or until:<minutes>");
        return policy;
    }

    /**
     * NE-47 (A-66), {@code pattern: ^https://audio\.jwlabs\.ai/[A-Za-z0-9._~/-]+$}: an
     * audition's rendered preview, a file on the narration host
     * ({@link EngineConstants.EngineContract#NARRATION_PUBLIC_BASE}, the page's own constant)
     * whose path is only the characters of a content key. Checked by character, not by URL
     * parsing, so a query, a fragment, credentials, a port, a percent-escape or a look-alike
     * host is refused exactly where the page's regular expression refuses it.
     */
    static String narrationUrl(JsonNode node, String path) throws ContractError {
        String text = string(node, path);
        String base = EngineConstants.EngineContract.NARRATION_PUBLIC_BASE + "/";
        if (!text.startsWith(base)) throw fail(path, "is not a file on the narration host");
        String rest = text.substring(base.length());
        if (rest.isEmpty()) throw fail(path, "is not a plain object path on the narration host");
        for (int i = 0; i < rest.length(); i++) {
            if (!isNarrationPathChar(rest.charAt(i))) throw fail(path, "is not a plain object path on the narration host");
        }
        return text;
    }

    /** {@code [A-Za-z0-9._~/-]}, ASCII only (a surrogate half is neither, so it is refused). */
    static boolean isNarrationPathChar(char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                || c == '.' || c == '_' || c == '~' || c == '/' || c == '-';
    }

    /** {@code type: object}, whatever it holds. */
    static JsonNode object(JsonNode node, String path) throws ContractError {
        if (!(node instanceof JsonNode.Obj)) throw fail(path, "must be an object");
        return node;
    }

    /** {@code type: array} with {@code items} (and {@code minItems}). */
    static <T> Reader<List<T>> array(Reader<T> item, int minItems) {
        return (node, path) -> {
            if (!(node instanceof JsonNode.Arr a)) throw fail(path, "must be an array");
            if (a.items().size() < minItems) throw fail(path, "needs at least " + minItems + " item(s)");
            List<T> out = new ArrayList<>();
            for (int i = 0; i < a.items().size(); i++) out.add(item.read(a.items().get(i), path + "/" + i));
            return out;
        };
    }

    static <T> Reader<List<T>> array(Reader<T> item) {
        return array(item, 0);
    }

    /** {@code type: [<t>, "null"]}: the value, or null for null. */
    static <T> Reader<T> nullable(Reader<T> read) {
        return (node, path) -> node instanceof JsonNode.Null ? null : read.read(node, path);
    }

    /** One JSON object's members, read by the schema's {@code required} / {@code properties}. */
    static final class Obj {
        final JsonNode node;
        final String path;

        Obj(JsonNode node, String path) throws ContractError {
            if (!(node instanceof JsonNode.Obj)) throw fail(path, "must be an object");
            this.node = node;
            this.path = path;
        }

        Obj(JsonNode node) throws ContractError {
            this(node, "");
        }

        boolean has(String key) {
            return node.get(key) != null;
        }

        <T> T required(String key, Reader<T> read) throws ContractError {
            JsonNode value = node.get(key);
            if (value == null) throw fail(path, "missing " + key);
            return read.read(value, path + "/" + key);
        }

        /** Absent is null; present is checked. */
        <T> T optional(String key, Reader<T> read) throws ContractError {
            JsonNode value = node.get(key);
            if (value == null) return null;
            return read.read(value, path + "/" + key);
        }

        /** Present and possibly null ({@code required} + a nullable type). */
        <T> T requiredNullable(String key, Reader<T> read) throws ContractError {
            return required(key, nullable(read));
        }

        /** Absent or null is null; anything else is checked. */
        <T> T optionalNullable(String key, Reader<T> read) throws ContractError {
            return optional(key, nullable(read));
        }

        /** A nested object, read at its own path. */
        Obj nested(String key) throws ContractError {
            return required(key, Obj::new);
        }
    }

    // ---- helpers of the schema ($defs that are not payloads)

    /** {@code $defs.item}: a queue item. Only {@code id} is the contract's; the rest is kept as sent. */
    static JsonNode item(JsonNode node, String path) throws ContractError {
        new Obj(node, path).required("id", ContractDecoding::nonEmptyString);
        return node;
    }

    /** {@code $defs.hop}: one continuation hop, the whole of it kept as sent. */
    static EngineContract.Hop hop(JsonNode node, String path) throws ContractError {
        Obj o = new Obj(node, path);
        long planSeq = o.required("planSeq", NON_NEGATIVE_INT);
        long hopSeq = o.required("hopSeq", NON_NEGATIVE_INT);
        String nextId = o.required("nextId", ContractDecoding::nonEmptyString);
        return new EngineContract.Hop(clampInt(planSeq), clampInt(hopSeq), nextId, node);
    }

    /** {@code $defs.pendingEvent}: {@code {seq, kind: "position", episode_id, seconds, duration, at}}. */
    static JsonNode pendingEvent(JsonNode node, String path) throws ContractError {
        Obj o = new Obj(node, path);
        o.required("seq", NON_NEGATIVE_INT);
        o.required("kind", ContractDecoding::string);
        return node;
    }

    /**
     * A contract integer into an {@code int} field of a core type. The contract admits any
     * {@code long}; a sequence, a count or an index beyond an {@code int} is saturated, which
     * reads the same to every rule the core has (an index past the queue, a seq past every one).
     */
    static int clampInt(long value) {
        return value > Integer.MAX_VALUE ? Integer.MAX_VALUE : value < Integer.MIN_VALUE ? Integer.MIN_VALUE : (int) value;
    }

    /** {@code const: PROTOCOL} for a payload's {@code v}. */
    static long version(JsonNode node, String path) throws ContractError {
        if (!(node instanceof JsonNode.Num n) || n.value() != EngineContract.PROTOCOL_VERSION) {
            throw fail(path, "must be " + EngineContract.PROTOCOL_VERSION);
        }
        return EngineContract.PROTOCOL_VERSION;
    }

    // ---- payloads

    /** engineHello's request (§5.1). */
    public record HelloRequest(String pageBuild, long protocolVersion) {
        public static HelloRequest decode(JsonNode node) throws ContractError {
            Obj o = new Obj(node);
            return new HelloRequest(o.required("pageBuild", ContractDecoding::string),
                    o.required("protocol", integer(1)));
        }
    }

    /**
     * engineHello's answer (§5.1). A {@code native} answer must say everything the page needs
     * to attach; a {@code {mode: "legacy", reason}} says only "not me".
     */
    public record HelloResponse(String mode, String reason, String engineVersion, Long protocolVersion,
                                List<String> capabilities, List<String> ownedKeyPrefixes, Snapshot snapshot) {
        public static HelloResponse decode(JsonNode node) throws ContractError {
            Obj o = new Obj(node);
            String mode = o.required("mode", token(EngineContract.ENGINE_MODES));
            String reason = o.required("reason", token(Vocabulary.SETS.get("modeReason")));
            String engineVersion = o.optional("engineVersion", ContractDecoding::string);
            Long protocol = o.optional("protocol", integer(1));
            List<String> capabilities = o.optional("capabilities", array(token(EngineContract.CAPABILITIES)));
            List<String> prefixes = o.optional("ownedKeyPrefixes", array(ContractDecoding::string));
            Snapshot snapshot = o.optional("snapshot", Snapshot::decode);
            o.optional("pendingAdvances", array(ContractDecoding::hop));
            o.optional("pendingEvents", array(ContractDecoding::pendingEvent));
            if (EngineContract.MODE_NATIVE.equals(mode)) {
                for (String key : new String[] {"engineVersion", "protocol", "capabilities", "ownedKeyPrefixes", "snapshot"}) {
                    if (!o.has(key)) throw fail("", "a native hello is missing " + key);
                }
            }
            return new HelloResponse(mode, reason, engineVersion, protocol, capabilities, prefixes, snapshot);
        }
    }

    /** engineSend's request (§5.1): {@code {v: 1, cmdSeq, cmd, args, source, issuedAtWallMs}}. */
    public record SendRequest(long cmdSeq, String name, EngineContract.Command command, Vocabulary.Source source,
                              Double issuedAtWallMs) {
        public static SendRequest decode(JsonNode node) throws ContractError {
            Obj o = new Obj(node);
            o.required("v", ContractDecoding::version);
            long cmdSeq = o.required("cmdSeq", NON_NEGATIVE_INT);
            String name = o.required("cmd", token(EngineContract.COMMANDS));
            Obj args = o.optional("args", Obj::new);
            String source = o.required("source", token(Vocabulary.SETS.get("source")));
            Double issued = o.optional("issuedAtWallMs", ContractDecoding::nonNegative);
            EngineContract.Command command = ContractDecoding.command(name, args);
            return new SendRequest(cmdSeq, name, command, Vocabulary.Source.of(source), issued);
        }
    }

    /**
     * A command's args. A command that takes args REQUIRES them; one that takes none accepts
     * any object (or no {@code args} at all), because an unknown key is never a refusal.
     */
    static EngineContract.Command command(String name, Obj args) throws ContractError {
        switch (name) {
            case "playEpisode" -> {
                Obj o = need(name, args);
                Obj row = o.nested("lastEpisodeRow");
                row.required("id", ContractDecoding::nonEmptyString);
                JsonNode item = o.required("item", ContractDecoding::item);
                Double startSec = o.optional("startSec", ContractDecoding::nonNegative);
                Boolean moved = o.optional("moved", ContractDecoding::bool);
                return new EngineContract.Command.PlayEpisode(item, startSec, moved, row.node);
            }
            case "playForay" -> {
                Obj o = need(name, args);
                return new EngineContract.Command.PlayForay(
                        o.required("forayId", ContractDecoding::nonEmptyString),
                        o.required("title", ContractDecoding::string),
                        o.required("items", array(ContractDecoding::item, 1)),
                        o.required("buildReport", ContractDecoding::object),
                        o.optional("startElapsedSec", ContractDecoding::nonNegative),
                        o.required("isLocalFile", ContractDecoding::bool),
                        o.required("allowAdPad", ContractDecoding::bool),
                        o.requiredNullable("voiceId", ContractDecoding::string));
            }
            case "setContinuation" -> {
                Obj o = need(name, args);
                long planSeq = o.required("planSeq", NON_NEGATIVE_INT);
                boolean autoAdvance = o.required("autoAdvance", ContractDecoding::bool);
                List<EngineContract.Hop> chain = o.required("chain", array(ContractDecoding::hop));
                EngineContract.Hop previous = o.optionalNullable("previous", ContractDecoding::hop);
                return new EngineContract.Command.SetContinuation(clampInt(planSeq), autoAdvance, chain, previous);
            }
            case "play" -> {
                return new EngineContract.Command.Play();
            }
            case "pause" -> {
                return new EngineContract.Command.Pause();
            }
            case "toggle" -> {
                return new EngineContract.Command.Toggle();
            }
            case "next" -> {
                return new EngineContract.Command.Next();
            }
            case "previous" -> {
                return new EngineContract.Command.Previous();
            }
            case "seekBy" -> {
                return new EngineContract.Command.SeekBy(need(name, args).required("deltaSec", ContractDecoding::number));
            }
            case "seekTo" -> {
                return new EngineContract.Command.SeekTo(need(name, args).required("sec", ContractDecoding::nonNegative));
            }
            case "jump" -> {
                return new EngineContract.Command.Jump(clampInt(need(name, args).required("index", NON_NEGATIVE_INT)));
            }
            case "stop" -> {
                return new EngineContract.Command.Stop(need(name, args).required("persist", ContractDecoding::bool));
            }
            case "setRate" -> {
                return new EngineContract.Command.SetRate(need(name, args).required("rate", ContractDecoding::positive));
            }
            case "setVoice" -> {
                return new EngineContract.Command.SetVoice(need(name, args).requiredNullable("voiceId", ContractDecoding::string));
            }
            case "setInterludeEnabled" -> {
                return new EngineContract.Command.SetInterludeEnabled(need(name, args).required("enabled", ContractDecoding::bool));
            }
            case "setPageVisible" -> {
                return new EngineContract.Command.SetPageVisible(need(name, args).required("visible", ContractDecoding::bool));
            }
            case "ackAdvances" -> {
                return new EngineContract.Command.AckAdvances(clampInt(need(name, args).required("upToSeq", NON_NEGATIVE_INT)));
            }
            case "ackEvents" -> {
                return new EngineContract.Command.AckEvents(clampInt(need(name, args).required("upToSeq", NON_NEGATIVE_INT)));
            }
            case "restoreBar" -> {
                return new EngineContract.Command.RestoreBar();
            }
            case "purge" -> {
                return new EngineContract.Command.Purge();
            }
            case "relinquish" -> {
                String cap = need(name, args).required("cap", token(EngineConstants.EngineContract.RELINQUISH_CAPS));
                EngineContract.RelinquishCap value = null;
                for (EngineContract.RelinquishCap c : EngineContract.RelinquishCap.values()) {
                    if (c.token.equals(cap)) value = c;
                }
                if (value == null) throw fail("/cap", cap + " has no relinquish cap");
                return new EngineContract.Command.Relinquish(value);
            }
            case "audition" -> {
                Obj o = need(name, args);
                return new EngineContract.Command.Audition(o.required("text", ContractDecoding::nonEmptyString),
                        o.requiredNullable("voiceId", ContractDecoding::string),
                        o.optional("url", ContractDecoding::narrationUrl));
            }
            case "setModeOverride" -> {
                return new EngineContract.Command.SetModeOverride(
                        need(name, args).required("mode", token(EngineContract.MODE_OVERRIDES)));
            }
            case "setHoldPolicy" -> {
                return new EngineContract.Command.SetHoldPolicy(need(name, args).required("policy", ContractDecoding::holdPolicy));
            }
            case "probeSession" -> {
                return new EngineContract.Command.ProbeSession();
            }
            case "simulateTermination" -> {
                return new EngineContract.Command.SimulateTermination();
            }
            default -> throw fail("/cmd", name + " is not a command");
        }
    }

    private static Obj need(String name, Obj args) throws ContractError {
        if (args == null) throw fail("", name + " needs args");
        return args;
    }

    /** engineSend's answer: {@code {ok, reason?, snapshot}}. A refusal must carry its reason. */
    public record SendResponse(boolean ok, String reason, Snapshot snapshot) {
        public static SendResponse decode(JsonNode node) throws ContractError {
            Obj o = new Obj(node);
            boolean ok = o.required("ok", ContractDecoding::bool);
            String reason = o.optional("reason", token(EngineConstants.EngineContract.REFUSALS));
            Snapshot snapshot = o.required("snapshot", Snapshot::decode);
            if (!ok && reason == null) throw fail("", "a refusal must carry its reason");
            return new SendResponse(ok, reason, snapshot);
        }
    }

    /**
     * engineRead's request. {@code prefixes} names shared rows only: the engine's private keys
     * are never read through here, nor any row it does not own.
     */
    public record ReadRequest(String what, List<String> prefixes) {
        public static ReadRequest decode(JsonNode node) throws ContractError {
            Obj o = new Obj(node);
            String what = o.required("what", token(EngineContract.READ_KINDS));
            List<String> prefixes = o.optional("prefixes", array((n, path) -> {
                String prefix = string(n, path);
                if (!EngineContract.OWNED_PREFIXES.contains(prefix)) throw fail(path, prefix + " is not a row the engine owns");
                return prefix;
            }));
            return new ReadRequest(what, prefixes);
        }
    }

    /** engineRead("rows")'s answer: key to the exact string stored. */
    public record RowsResponse(Map<String, String> rows) {
        public static RowsResponse decode(JsonNode node) throws ContractError {
            Obj table = new Obj(node).nested("rows");
            Map<String, String> rows = new LinkedHashMap<>();
            for (JsonNode.Member m : table.node.members()) rows.put(m.key(), string(m.value(), table.path + "/" + m.key()));
            return new RowsResponse(Collections.unmodifiableMap(rows));
        }
    }

    /** engineRead("diagnostics")'s answer: DiagRow objects, as written. */
    public record DiagnosticsResponse(List<JsonNode> rows) {
        public static DiagnosticsResponse decode(JsonNode node) throws ContractError {
            return new DiagnosticsResponse(new Obj(node).required("rows", array(ContractDecoding::object)));
        }
    }

    /** Snapshot v1 (§5.3). The fields a reader of the snapshot switches on, and the node as sent. */
    public record Snapshot(long seq, String mode, String state, String session, boolean running, JsonNode node) {
        public static Snapshot decode(JsonNode node) throws ContractError {
            return decode(node, "");
        }

        static Snapshot decode(JsonNode node, String path) throws ContractError {
            Obj o = new Obj(node, path);
            o.required("v", ContractDecoding::version);
            long seq = o.required("seq", NON_NEGATIVE_INT);
            o.required("capturedAtWallMs", ContractDecoding::nonNegative);
            o.required("capturedAtMonotonicMs", ContractDecoding::nonNegative);
            String mode = o.required("mode", token(EngineContract.SNAPSHOT_MODES));
            o.optionalNullable("forayId", ContractDecoding::string);
            o.optionalNullable("index", NON_NEGATIVE_INT);
            o.optionalNullable("itemId", ContractDecoding::string);
            o.optionalNullable("itemKind", ContractDecoding::string);
            String state = o.required("state", token(EngineContract.PLAYER_STATES));
            o.optional("wasPlaying", ContractDecoding::bool);
            boolean running = o.required("running", ContractDecoding::bool);
            o.required("inSeamGap", ContractDecoding::bool);
            o.required("inInterlude", ContractDecoding::bool);
            o.required("buffering", ContractDecoding::bool);
            o.required("ended", ContractDecoding::bool);
            o.required("positionSec", ContractDecoding::nonNegative);
            o.requiredNullable("durationSec", ContractDecoding::nonNegative);
            o.requiredNullable("sourceTimeSec", ContractDecoding::nonNegative);
            o.requiredNullable("playheadItemId", ContractDecoding::string);
            o.required("isNarrationPlayhead", ContractDecoding::bool);
            o.optional("narrationElapsedSec", ContractDecoding::nonNegative);
            o.required("rate", ContractDecoding::positive);
            o.required("effectiveRate", ContractDecoding::nonNegative);
            o.required("canNext", ContractDecoding::bool);
            o.required("canPrevious", ContractDecoding::bool);
            o.required("autoAdvance", ContractDecoding::bool);
            o.optionalNullable("lastError", ContractDecoding::string);
            o.optionalNullable("voiceFallback", ContractDecoding::string);
            o.required("skippedSegments", NON_NEGATIVE_INT);
            o.required("pendingAdvances", NON_NEGATIVE_INT);
            o.required("pendingEvents", NON_NEGATIVE_INT);
            String session = o.required("session", token(EngineConstants.EngineContract.SESSION_PHASES));
            o.required("holdPolicy", ContractDecoding::holdPolicy);
            Obj np = o.nested("nowPlaying");
            np.required("title", ContractDecoding::string);
            np.required("artist", ContractDecoding::string);
            np.required("album", ContractDecoding::string);
            return new Snapshot(seq, mode, state, session, running, node);
        }
    }

    /**
     * An "engine" event (§5.4). Only the fields its {@code type} requires are read: an
     * {@code advanced} event carrying some other {@code code} is not the contract's business.
     */
    public record Event(String type, Snapshot snapshot, String code, String mode, String reason, JsonNode node) {
        public static Event decode(JsonNode node) throws ContractError {
            Obj o = new Obj(node);
            String type = o.required("type", token(EngineContract.EVENTS));
            Snapshot snapshot = null;
            String code = null;
            String mode = null;
            String reason = null;
            switch (type) {
                case "snapshot" -> snapshot = o.required("snapshot", Snapshot::decode);
                case "error" -> code = o.required("code", ContractDecoding::nonEmptyString);
                case "modeChanged" -> {
                    mode = o.required("mode", token(EngineContract.ENGINE_MODES));
                    reason = o.required("reason", token(Vocabulary.SETS.get("modeReason")));
                }
                default -> {}
            }
            return new Event(type, snapshot, code, mode, reason, node);
        }
    }

    // ---- accept or refuse

    /** Why {@code payload} is not a valid {@code kind}, or null when it is. An unknown kind is the caller's bug. */
    public static ContractError refusal(String kind, JsonNode payload) {
        try {
            switch (kind) {
                case "helloRequest" -> HelloRequest.decode(payload);
                case "helloResponse" -> HelloResponse.decode(payload);
                case "sendRequest" -> SendRequest.decode(payload);
                case "sendResponse" -> SendResponse.decode(payload);
                case "readRequest" -> ReadRequest.decode(payload);
                case "rowsResponse" -> RowsResponse.decode(payload);
                case "diagnosticsResponse" -> DiagnosticsResponse.decode(payload);
                case "snapshot" -> Snapshot.decode(payload);
                case "event" -> Event.decode(payload);
                default -> throw new IllegalArgumentException("no contract kind " + kind);
            }
            return null;
        } catch (ContractError e) {
            return e;
        }
    }

    /** {@code contractAccepts(kind, payload)}: accept or refuse, and nothing else. */
    public static boolean accepts(String kind, JsonNode payload) {
        return refusal(kind, payload) == null;
    }
}

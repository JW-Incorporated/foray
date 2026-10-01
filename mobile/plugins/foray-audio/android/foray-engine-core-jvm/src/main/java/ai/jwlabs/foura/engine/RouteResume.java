package ai.jwlabs.foura.engine;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * ROUTE RESUME: WHEN A CAR COMES BACK, DOES 4a PLAY AGAIN BY ITSELF? (card A-61, the JVM twin of
 * the Swift {@code RouteResume} in ForayEngineCore/Policy, NE-38rs; founder Q5,
 * docs/DECISIONS.md 2026-09-25.)
 *
 * <p>THE REFERENCE is player/route-resume.js (NE-38rj), recorded as the {@code route-resume}
 * parity family: {@link #decision} is {@code routeResumeDecision}, {@link #step} is the reducer
 * {@code routeResumeStep} and {@link #replay} is {@code routeResumeReplay}, line for line.
 * {@link EngineCore} keeps a {@link State} and feeds it the same events the JS reducer takes.
 *
 * <p>THE RULE. A route that comes back resumes playback ONLY when every one of these holds:
 * <ol>
 *   <li>the last pause was a route loss ({@code pausedBy == ROUTE}),</li>
 *   <li>of THIS route: the key that came back is the key that was lost,</li>
 *   <li>the route's class allows it: {@code car} always, {@code bluetooth} only with the Bluetooth
 *       arm on ({@code EngineConfig.routeResumeBluetooth}, OFF), {@code other} never,</li>
 *   <li>the route is known: our own audio has been heard through it,</li>
 *   <li>the loss is at most {@link #MAX_LOST_SEC} old, on the WALL clock.</li>
 * </ol>
 * A listener's pause is never resumed, and neither is one a call, the assistant or the system
 * made.
 *
 * <p>THE CLASS ON ANDROID. The JS {@link #routeClass} reads AVAudioSession port types (what the
 * fixtures record). Android has no such port, so its host classifies the device itself
 * (ForayPlaybackService's route watcher, A-61: {@code car} for a device that arrives or leaves in
 * car UI mode, {@code bluetooth} for A2DP, SCO and LE, {@code other} for everything else) and
 * hands the class along with the route ({@link Route#cls}). A route with no class given is
 * classed by its port, as the JS does, so the fixture family runs the JS rule unchanged.
 *
 * <p>KEYS. A route is known by its type and its address, never its name (two cars of one model
 * share a name, and a name is often its owner's). The engine stores and compares a SALTED
 * SHA-256 of the two ({@link #hashedKey}, {@code MessageDigest}: this module is plain Java at
 * API 24), with a per-install salt, and a row shows only its first 8 hex ({@link #rowKey}), so
 * no raw address ever reaches the ring or a paste (DiagGate).
 *
 * <p>THE KNOWN SET. At most {@link #KNOWN_CAP} keys, least recently used first out, persisted by
 * the host in the engine's private preferences (Android's {@code EngineStore},
 * {@code ForayEngine.knownRoutes}), never in the page's storage.
 */
public final class RouteResume {
    private RouteResume() {}

    /**
     * {@code ROUTE_RESUME_MAX_LOST_SEC}: 24 h, provisional. The MEASURE tag lives on the JS constant
     * (route-resume.js), which the generated one copies: NE-38e's {@code route-back} verdict reads
     * the {@code route kind=back lostSec=} rows, and NE-38f / A-68 settle it.
     */
    public static final double MAX_LOST_SEC = EngineConstants.RouteResume.ROUTE_RESUME_MAX_LOST_SEC;
    /**
     * {@code ROUTE_RESUME_BLUETOOTH_DEFAULT}: OFF, provisional (tagged on the JS constant likewise).
     * On Android the arm stays off for a second reason: telling a car's Bluetooth from headphones
     * needs {@code BLUETOOTH_CONNECT}, which is not requested (D-A9: no).
     */
    public static final boolean BLUETOOTH_DEFAULT = EngineConstants.RouteResume.ROUTE_RESUME_BLUETOOTH_DEFAULT;
    /** How long our audio must have been heard through a route before it is known (the Swift {@code knownAfterMs}). */
    public static final double KNOWN_AFTER_MS = 1_000;
    /** The known set's size: a phone meets a handful of cars. */
    public static final int KNOWN_CAP = 8;
    /** The hex a row shows of a key. */
    public static final int ROW_KEY_LENGTH = 8;

    // ---- classes and keys (routeClass, routeKey)

    /** {@code "car" | "bluetooth" | "other"}. */
    public enum RouteClass {
        CAR("car"),
        BLUETOOTH("bluetooth"),
        OTHER("other");

        public final String token;

        RouteClass(String token) {
            this.token = token;
        }
    }

    /** AVAudioSession.Port raw values (the JS module's CAR_PORTS and BLUETOOTH_PORTS). */
    static final List<String> CAR_PORTS = Collections.unmodifiableList(Collections.singletonList("CarAudio"));
    static final List<String> BLUETOOTH_PORTS = Collections.unmodifiableList(
            Arrays.asList("BluetoothA2DPOutput", "BluetoothHFP", "BluetoothLE"));

    /** {@code routeClass(portType)}. */
    public static RouteClass routeClass(String portType) {
        if (portType == null) return RouteClass.OTHER;
        if (CAR_PORTS.contains(portType)) return RouteClass.CAR;
        if (BLUETOOTH_PORTS.contains(portType)) return RouteClass.BLUETOOTH;
        return RouteClass.OTHER;
    }

    private static boolean nonEmpty(String s) {
        return s != null && !s.isEmpty();
    }

    /**
     * {@code routeKey(portType, uid)}: {@code "<port>|<uid>"}, unhashed, or null when either is
     * missing, so a port with no address can never be matched or known.
     */
    public static String routeKey(String portType, String uid) {
        if (!nonEmpty(portType) || !nonEmpty(uid)) return null;
        return portType + "|" + uid;
    }

    /**
     * The key the engine stores, compares and persists: the lowercase hex SHA-256 of the salt, a
     * newline and {@link #routeKey}. Null exactly when {@code routeKey} is. (The Swift one is a
     * hand-written SHA-256 because its package runs on Linux without CryptoKit; the JVM has
     * {@code MessageDigest}, and RouteResumeTest pins it to the same FIPS 180-4 vectors.)
     */
    public static String hashedKey(String portType, String uid, String salt) {
        String key = routeKey(portType, uid);
        if (key == null) return null;
        return sha256Hex((salt == null ? "" : salt) + "\n" + key);
    }

    /** What a row shows of a hashed key: its first 8 hex. */
    public static String rowKey(String hashed) {
        if (hashed == null) return null;
        return hashed.length() <= ROW_KEY_LENGTH ? hashed : hashed.substring(0, ROW_KEY_LENGTH);
    }

    // ---- the decision (routeResumeDecision)

    /** What caused the last pause. */
    public enum PausedBy {
        ROUTE("route"),
        LISTENER("listener"),
        INTERRUPTION("interruption"),
        SYSTEM("system"),
        NONE("none");

        public final String token;

        PausedBy(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null. */
        public static PausedBy of(String token) {
            for (PausedBy v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /**
     * A route as the decision compares it. {@code cls}: the class the host read for it (Android),
     * or null to class it by {@code port} ({@link #routeClass}, the JS rule).
     */
    public record Route(String port, String key, RouteClass cls) {
        public Route(String port, String key) {
            this(port, key, null);
        }

        public RouteClass routeClass() {
            return cls != null ? cls : RouteResume.routeClass(port);
        }
    }

    /** {@code {resume, why}}. {@code why} is a closed token, the {@code route kind=back} row's. */
    public record Decision(boolean resume, String why) {
        public Decision {
            Objects.requireNonNull(why, "why");
        }
    }

    /** The {@code why} tokens (route-resume.js). */
    public static final class Why {
        private Why() {}

        public static final String ROUTE_BACK = "route-back";
        public static final String LISTENER_PAUSED = "listener-paused";
        public static final String INTERRUPTED = "interrupted";
        public static final String SYSTEM_PAUSED = "system-paused";
        public static final String NOT_PAUSED = "not-paused";
        public static final String NO_LOSS = "no-loss";
        public static final String OTHER_ROUTE = "other-route";
        public static final String NOT_A_CAR = "not-a-car";
        public static final String BLUETOOTH_OFF = "bluetooth-off";
        public static final String UNKNOWN_ROUTE = "unknown-route";
        public static final String LOSS_AGE_UNKNOWN = "loss-age-unknown";
        public static final String LOST_TOO_LONG = "lost-too-long";
        /** The engine's own, not the JS policy's: a resume with no current item (EngineCore's row only). */
        public static final String NO_ITEM = "no-item";
    }

    /** {@code NOT_A_ROUTE_PAUSE[pausedBy] ?? "not-paused"}. */
    static String notARoutePause(String pausedBy) {
        PausedBy p = pausedBy == null ? null : PausedBy.of(pausedBy);
        if (p == null) return Why.NOT_PAUSED;
        return switch (p) {
            case LISTENER -> Why.LISTENER_PAUSED;
            case INTERRUPTION -> Why.INTERRUPTED;
            case SYSTEM -> Why.SYSTEM_PAUSED;
            default -> Why.NOT_PAUSED;
        };
    }

    private static Decision no(String why) {
        return new Decision(false, why);
    }

    /**
     * {@code routeResumeDecision({pausedBy, lost, back, known, lostAgoSec, bluetoothArm})}.
     * {@code pausedBy} is a string as the JS takes it (anything but the five reads as
     * {@code not-paused}); {@code lostAgoSec} null is "not a finite number"; {@code bluetoothArm}
     * null is the default.
     */
    public static Decision decision(String pausedBy, Route lost, Route back, boolean known, Double lostAgoSec,
                                    Boolean bluetoothArm) {
        // The founder's Q5 rule: only a pause the route itself caused is resumed.
        if (!PausedBy.ROUTE.token.equals(pausedBy)) return no(notARoutePause(pausedBy));
        if (lost == null || !nonEmpty(lost.key())) return no(Why.NO_LOSS);
        if (back == null || !nonEmpty(back.key()) || !back.key().equals(lost.key())) return no(Why.OTHER_ROUTE);
        RouteClass cls = back.routeClass();
        if (cls == RouteClass.OTHER) return no(Why.NOT_A_CAR);
        if (cls == RouteClass.BLUETOOTH && !Boolean.TRUE.equals(bluetoothArm != null ? bluetoothArm : BLUETOOTH_DEFAULT)) {
            return no(Why.BLUETOOTH_OFF);
        }
        if (!known) return no(Why.UNKNOWN_ROUTE);
        if (lostAgoSec == null || !Double.isFinite(lostAgoSec) || lostAgoSec < 0) return no(Why.LOSS_AGE_UNKNOWN);
        if (lostAgoSec > MAX_LOST_SEC) return no(Why.LOST_TOO_LONG);
        return new Decision(true, Why.ROUTE_BACK);
    }

    // ---- the bookkeeping (routeResumeStep, routeResumeReplay)

    /** The route whose loss paused us, and when (wall-clock seconds). */
    public record Loss(String port, String key, RouteClass cls, Double atSec) {}

    /**
     * {@code routeResumeInitial({playing})}. {@code playing} is the engine's intent (playing, or
     * loading to play), not what the speaker does this instant. Immutable: {@link #step} returns
     * a new one.
     */
    public record State(boolean playing, PausedBy pausedBy, Loss lost) {
        public State {
            Objects.requireNonNull(pausedBy, "pausedBy");
        }

        public State(boolean playing) {
            this(playing, PausedBy.NONE, null);
        }
    }

    /**
     * One event the reducer takes. {@code atSec} is WALL-CLOCK seconds
     * ({@code System.currentTimeMillis()}), never uptime ({@code SystemClock.uptimeMillis} or
     * {@code elapsedRealtime}'s cousins that stop in deep sleep): a phone asleep in a parked car
     * overnight would read a two-day loss as minutes old.
     */
    public sealed interface Event permits Event.Lost, Event.Back, Event.Press, Event.Interruption, Event.SystemPause,
            Event.Playing {
        /** The route went away. Arms a resume only while playing. */
        record Lost(String port, String key, RouteClass cls, Double atSec) implements Event {
            public Lost(String port, String key, Double atSec) {
                this(port, key, null, atSec);
            }
        }

        /** A route came back: asks {@link #decision}. */
        record Back(String port, String key, RouteClass cls, boolean known, Double atSec) implements Event {
            public Back(String port, String key, boolean known, Double atSec) {
                this(port, key, null, known, atSec);
            }
        }

        /**
         * Any press (the listener, the lock screen, the car's own buttons): {@code pause} pauses as
         * the listener, {@code play} plays, anything else leaves a paused engine paused by the
         * listener. Clears the loss.
         */
        record Press(String command) implements Event {}

        /** A call or the assistant took the audio. */
        record Interruption() implements Event {}

        /** The system paused us (media services reset, the queue ended...). */
        record SystemPause() implements Event {}

        /** Our audio became audible, whatever started it. */
        record Playing() implements Event {}

        Event INTERRUPTION = new Interruption();
        Event SYSTEM = new SystemPause();
        Event PLAYING = new Playing();
    }

    /** A step's result: the new state, and the decision a {@code back} asked for (null otherwise). */
    public record Step(State state, Decision decision) {}

    /** {@code routeResumeStep(state, event, {bluetoothArm})}. Pure. */
    public static Step step(State state, Event event, Boolean bluetoothArm) {
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(event, "event");
        return switch (event) {
            case Event.Lost e -> state.playing()
                    ? new Step(new State(false, PausedBy.ROUTE, new Loss(e.port(), e.key(), e.cls(), e.atSec())), null)
                    : new Step(state, null);
            case Event.Back e -> {
                Double age = null;
                Loss lost = state.lost();
                if (lost != null && lost.atSec() != null && e.atSec() != null) age = e.atSec() - lost.atSec();
                Decision made = decision(state.pausedBy().token, lost == null ? null : new Route(lost.port(), lost.key(), lost.cls()),
                        new Route(e.port(), e.key(), e.cls()), e.known(), age, bluetoothArm);
                // At most one resume per loss.
                yield made.resume() ? new Step(new State(true, PausedBy.NONE, null), made) : new Step(state, made);
            }
            case Event.Press e -> {
                if ("pause".equals(e.command())) yield new Step(new State(false, PausedBy.LISTENER, null), null);
                if ("play".equals(e.command())) yield new Step(new State(true, PausedBy.NONE, null), null);
                yield new Step(new State(state.playing(), state.playing() ? state.pausedBy() : PausedBy.LISTENER, null), null);
            }
            case Event.Interruption e -> new Step(interrupted(state, PausedBy.INTERRUPTION), null);
            case Event.SystemPause e -> new Step(interrupted(state, PausedBy.SYSTEM), null);
            case Event.Playing e -> new Step(new State(true, PausedBy.NONE, null), null);
        };
    }

    /** {@code case "interruption": case "system":} of the reducer. */
    private static State interrupted(State s, PausedBy by) {
        if (s.playing() || s.pausedBy() == PausedBy.ROUTE) return new State(false, by, null);
        return new State(s.playing(), s.pausedBy(), null);
    }

    /** One decision of a replay, with the index of the {@code back} it answered. */
    public record ReplayDecision(int event, Decision decision) {}

    /** {@code routeResumeReplay}'s answer. */
    public record Replay(List<ReplayDecision> decisions, int resumes) {}

    /** {@code routeResumeReplay(events, {bluetoothArm, playing})}: fold {@code events} through {@link #step}. */
    public static Replay replay(List<Event> events, Boolean bluetoothArm, boolean playing) {
        State state = new State(playing);
        List<ReplayDecision> decisions = new ArrayList<>();
        int resumes = 0;
        for (int i = 0; i < events.size(); i++) {
            Step result = step(state, events.get(i), bluetoothArm);
            state = result.state();
            if (result.decision() != null) {
                decisions.add(new ReplayDecision(i, result.decision()));
                if (result.decision().resume()) resumes++;
            }
        }
        return new Replay(Collections.unmodifiableList(decisions), resumes);
    }

    // ---- the known set

    /**
     * The routes our audio has been heard through, least recently used first, at most
     * {@link #KNOWN_CAP}. Only 64-hex keys ({@link #hashedKey}'s shape) are ever held, so a stored
     * value from anywhere else is dropped on load. Immutable: {@link #use} returns a new set.
     */
    public static final class KnownRoutes {
        private final List<String> keys;

        public KnownRoutes() {
            this(Collections.emptyList());
        }

        public KnownRoutes(List<String> keys) {
            List<String> kept = new ArrayList<>();
            if (keys != null) {
                for (String key : keys) {
                    if (key == null || !isHashedKey(key)) continue;
                    kept.remove(key);
                    kept.add(key);
                }
            }
            while (kept.size() > KNOWN_CAP) kept.remove(0);
            this.keys = Collections.unmodifiableList(kept);
        }

        public List<String> keys() {
            return keys;
        }

        public boolean contains(String key) {
            return key != null && keys.contains(key);
        }

        /**
         * Our audio was heard through {@code key} again: it becomes the most recently used, and
         * the least recently used goes past the cap. Returns this set when nothing changed.
         */
        public KnownRoutes use(String key) {
            if (key == null || !isHashedKey(key)) return this;
            if (!keys.isEmpty() && keys.get(keys.size() - 1).equals(key)) return this;
            List<String> next = new ArrayList<>(keys);
            next.remove(key);
            next.add(key);
            return new KnownRoutes(next);
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof KnownRoutes k && k.keys.equals(keys);
        }

        @Override
        public int hashCode() {
            return keys.hashCode();
        }

        @Override
        public String toString() {
            return "KnownRoutes" + keys;
        }
    }

    /** 64 lowercase hex characters. */
    public static boolean isHashedKey(String key) {
        return key != null && key.length() == 64 && isLowerHex(key);
    }

    /** A salt: 32 lowercase hex characters (16 random bytes). */
    public static boolean isSalt(String text) {
        return text != null && text.length() == 32 && isLowerHex(text);
    }

    private static boolean isLowerHex(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    // ---- what the host persists (ForayEngine.knownRoutes)

    /**
     * The private key's value: {@code {"v":1,"salt":"<hex>","keys":[...]}}, the Swift
     * {@code RouteResume.Stored}'s bytes. The salt is per install and lives beside the keys it
     * made, so a purge (which removes the key) takes both.
     */
    public record Stored(String salt, List<String> keys) {
        public static final int VERSION = 1;

        public Stored {
            Objects.requireNonNull(salt, "salt");
            keys = new KnownRoutes(keys).keys();
        }

        /** Null for nothing stored, or anything this build cannot trust: the host then starts a new salt and an empty set. */
        public static Stored parse(String text) {
            if (text == null || text.isEmpty()) return null;
            JsonNode node = JsonNode.tryParse(text);
            if (node == null) return null;
            JsonNode v = node.get("v");
            if (v == null || v.numberValue() == null || v.numberValue() != VERSION) return null;
            JsonNode salt = node.get("salt");
            if (salt == null || !isSalt(salt.stringValue())) return null;
            JsonNode keys = node.get("keys");
            if (keys == null || keys.arrayValue() == null) return null;
            List<String> out = new ArrayList<>();
            for (JsonNode k : keys.arrayValue()) {
                String s = k.stringValue();
                if (s != null) out.add(s);
            }
            return new Stored(salt.stringValue(), out);
        }

        public String serialized() {
            List<JsonNode> items = new ArrayList<>();
            for (String k : keys) items.add(JsonNode.str(k));
            return JSWriter.stringify(new JsonNode.Obj(Arrays.asList(
                    JsonNode.member("v", JsonNode.num(VERSION)),
                    JsonNode.member("salt", JsonNode.str(salt)),
                    JsonNode.member("keys", new JsonNode.Arr(items)))));
        }
    }

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /** A new per-install salt. */
    public static String newSalt() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return hex(bytes);
    }

    // ---- SHA-256, for hashedKey

    /** The lowercase hex SHA-256 of {@code text}'s UTF-8 bytes. */
    public static String sha256Hex(String text) {
        return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
    }

    /** The lowercase hex SHA-256 of {@code bytes} (RouteResumeTest pins it to FIPS 180-4's vectors). */
    public static String sha256Hex(byte[] bytes) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            // Every Java platform must provide SHA-256 (the MessageDigest contract).
            throw new IllegalStateException("SHA-256 is missing", e);
        }
    }

    private static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[2 * i] = HEX[(bytes[i] >> 4) & 0xf];
            out[2 * i + 1] = HEX[bytes[i] & 0xf];
        }
        return new String(out);
    }
}

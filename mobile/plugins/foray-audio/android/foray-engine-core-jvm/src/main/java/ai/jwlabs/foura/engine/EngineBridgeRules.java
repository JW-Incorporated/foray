package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * WHAT THE BRIDGE SAYS, AND WHEN (card A-28, docs/plans/android-assessment.md §5.4; the
 * protocol is docs/native-engine-plan.md §5.1-§5.4): the JVM twin of EngineBridgeRules.swift
 * (NE-20).
 *
 * <p>The plugin's three methods ({@code engineHello}, {@code engineSend}, {@code engineRead})
 * and its one event ({@code engine}) carry JSON the page validates against the same schema the
 * {@code contract} and {@code snapshot} families pin. Everything that decides the SHAPE of those
 * payloads, and when an event may leave, is here, pure, so a plain JUnit test checks every answer
 * against {@link ContractDecoding#accepts} and the Android bridge only moves the bytes across
 * Capacitor. The page-side model of the same rules is {@code player/parity/reference-engine.js}.
 *
 * <p>Nested here, as three small types rather than three files: {@link EngineSnapshot} (the
 * snapshot's content), {@link SnapshotStamper} (its content-versioned {@code seq}) and
 * {@link SnapshotCoalescer} (when a snapshot event may leave).
 */
public final class EngineBridgeRules {
    private EngineBridgeRules() {}

    /** What {@code engineHello} names this engine: the Copy header's {@code v<ver>}. */
    public static final String ENGINE_VERSION = "1.0.0";

    /** The Capacitor event every engine event rides on: native-engine.js {@code ENGINE_EVENT}. */
    public static final String EVENT_NAME = "engine";

    /** §5.4: at most one {@code snapshot} event per this many ms while the page is visible. */
    public static final double SNAPSHOT_EVENT_MIN_MS = 1000;

    /**
     * THE CAPABILITIES THIS BINARY MAY ADVERTISE on Android: what it implements AND what the
     * JVM parity books let it claim. The gate is the Swift literal's (plan §6.6), read against
     * player/parity/jvm-pending.json instead of swift-pending.json: shell-invariants refuses an
     * entry here any of whose families ({@code player/parity/capabilities.json}) the JVM does not
     * run (since A-63 nothing may be owed, so every such family is in the books' "runs"). So,
     * since A-42 (the A2 flip), iOS's M2 four:
     * <ul>
     *   <li>{@code episode}: the core plays episodes (A-24), and {@code engine-mode} (the lane's
     *       once-per-process decision, with the crash-loop guard) is ported by A-29, so every
     *       family under it runs on the JVM;</li>
     *   <li>{@code continuation}: the hop walk is the core's (A-24), and its families owe
     *       nothing on the JVM;</li>
     *   <li>{@code restore}: the cold path and the restore record are A-27's, and its families
     *       (compare, rows, resume-rules, engine-mode) all run on the JVM;</li>
     *   <li>{@code foray}: the Foray tape and the deck pair are A-40's, the rendered narration,
     *       the TTS fallback seam and the jingle A-41's, and every family under it runs on the
     *       JVM (0 owed).</li>
     * </ul>
     * What a build ADVERTISES is this ∩ what it DECLARES (mobile/ENGINE_DEFAULT.json's android
     * block: nothing until A-31, {@code episode} and {@code continuation} from that flip, all
     * four since A-42), so a claim here changes no launch by itself. A capability missing from the hello is refused
     * {@code capability-off} by {@code engineSend}, and the page relinquishes to its own player
     * when the one it needs is missing (client.js {@code engineCan}).
     */
    public static final List<String> ADVERTISED_CAPABILITIES = Collections.unmodifiableList(
            new ArrayList<>(Arrays.asList("episode", "continuation", "restore", "foray")));

    /** {@code declared ∩ ADVERTISED_CAPABILITIES}, in the contract's order. Null declares nothing. */
    public static List<String> capabilities(List<String> declared) {
        List<String> out = new ArrayList<>();
        if (declared == null) return out;
        for (String cap : EngineContract.CAPABILITIES) {
            if (declared.contains(cap) && ADVERTISED_CAPABILITIES.contains(cap)) out.add(cap);
        }
        return out;
    }

    /** The capability a command needs before the engine will act on it, if any. */
    public static String requiredCapability(EngineContract.Command command) {
        if (command instanceof EngineContract.Command.PlayEpisode) return "episode";
        if (command instanceof EngineContract.Command.PlayForay) return "foray";
        return null;
    }

    // ---- engineHello

    /** Not the native engine: {@code {mode: "legacy", reason, protocol}}. The page runs its own player. */
    public static JsonNode legacyHello(Vocabulary.ModeReason reason) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("mode", JsonNode.str(EngineContract.MODE_LEGACY)));
        m.add(JsonNode.member("reason", JsonNode.str(reason.token)));
        m.add(JsonNode.member("protocol", JsonNode.num(EngineContract.PROTOCOL_VERSION)));
        return new JsonNode.Obj(m);
    }

    /** The native answer (§5.1), with the unacked hops and position events the page drains on attach. */
    public static JsonNode nativeHello(Vocabulary.ModeReason reason, List<String> capabilities, JsonNode snapshot,
                                       List<EngineCommand.AdvanceEntry> pendingAdvances,
                                       List<EngineCommand.PendingEvent> pendingEvents) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("mode", JsonNode.str(EngineContract.MODE_NATIVE)));
        m.add(JsonNode.member("reason", JsonNode.str(reason.token)));
        m.add(JsonNode.member("engineVersion", JsonNode.str(ENGINE_VERSION)));
        m.add(JsonNode.member("protocol", JsonNode.num(EngineContract.PROTOCOL_VERSION)));
        m.add(JsonNode.member("capabilities", strings(capabilities)));
        m.add(JsonNode.member("ownedKeyPrefixes", strings(EngineContract.OWNED_PREFIXES)));
        m.add(JsonNode.member("snapshot", snapshot));
        List<JsonNode> advances = new ArrayList<>();
        for (EngineCommand.AdvanceEntry e : pendingAdvances) advances.add(e.node());
        m.add(JsonNode.member("pendingAdvances", new JsonNode.Arr(advances)));
        List<JsonNode> events = new ArrayList<>();
        for (EngineCommand.PendingEvent e : pendingEvents) events.add(e.node());
        m.add(JsonNode.member("pendingEvents", new JsonNode.Arr(events)));
        return new JsonNode.Obj(m);
    }

    // ---- engineSend

    /**
     * The one refusal a send reports: the first of the turn's failures that is a contract
     * token. The core only ever fails with one, so the fallback is a guard, not a path.
     */
    public static String refusal(List<String> failures) {
        if (failures == null || failures.isEmpty()) return null;
        for (String f : failures) {
            if (EngineConstants.EngineContract.REFUSALS.contains(f)) return f;
        }
        return EngineContract.Refusal.UNKNOWN_CMD.token;
    }

    /** {@code {ok, reason?, snapshot}}. Never a rejection (§5.1). */
    public static JsonNode sendResponse(String refusal, JsonNode snapshot) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("ok", JsonNode.bool(refusal == null)));
        if (refusal != null) m.add(JsonNode.member("reason", JsonNode.str(refusal)));
        m.add(JsonNode.member("snapshot", snapshot));
        return new JsonNode.Obj(m);
    }

    // ---- engineRead

    /** {@code {rows: {key: stored string}}}, keys sorted, so two reads of the same rows are the same bytes. */
    public static JsonNode rowsResponse(Map<String, String> rows) {
        List<JsonNode.Member> table = new ArrayList<>();
        for (Map.Entry<String, String> e : new TreeMap<>(rows).entrySet()) {
            table.add(JsonNode.member(e.getKey(), JsonNode.str(e.getValue())));
        }
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("rows", new JsonNode.Obj(table)));
        return new JsonNode.Obj(m);
    }

    /** {@code {rows: [DiagRow]}}: the whole ring, oldest first, in one call. */
    public static JsonNode diagnosticsResponse(List<JsonNode> rows) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("rows", new JsonNode.Arr(rows)));
        return new JsonNode.Obj(m);
    }

    // ---- events (§5.4)

    public static JsonNode snapshotEvent(JsonNode snapshot) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("type", JsonNode.str("snapshot")));
        m.add(JsonNode.member("snapshot", snapshot));
        return new JsonNode.Obj(m);
    }

    /** The core's own events: a walked hop ({@code advanced}), a failure ({@code error}) and a segment the ladder refused ({@code skipped}). */
    public static JsonNode event(EngineCommand.EngineEvent event) {
        List<JsonNode.Member> m = new ArrayList<>();
        switch (event) {
            case EngineCommand.EngineEvent.Advanced a -> {
                m.add(JsonNode.member("type", JsonNode.str("advanced")));
                m.add(JsonNode.member("hop", a.entry().node()));
            }
            case EngineCommand.EngineEvent.Error e -> {
                m.add(JsonNode.member("type", JsonNode.str("error")));
                m.add(JsonNode.member("code", JsonNode.str(e.code())));
                m.add(JsonNode.member("message", JsonNode.str(e.message() == null ? "" : e.message())));
            }
            case EngineCommand.EngineEvent.Skipped s -> {
                // A-40: ADR-0007's ladder refused a segment at load.
                m.add(JsonNode.member("type", JsonNode.str("skipped")));
                m.add(JsonNode.member("itemId", JsonNode.str(s.itemId())));
                m.add(JsonNode.member("index", JsonNode.num(s.index())));
                m.add(JsonNode.member("reason", JsonNode.str(s.reason())));
            }
        }
        return new JsonNode.Obj(m);
    }

    /** The engine gave the process back: from here the page must run the JS player. */
    public static JsonNode modeChangedEvent(Vocabulary.ModeReason reason) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("type", JsonNode.str("modeChanged")));
        m.add(JsonNode.member("mode", JsonNode.str(EngineContract.MODE_LEGACY)));
        m.add(JsonNode.member("reason", JsonNode.str(reason.token)));
        return new JsonNode.Obj(m);
    }

    /** One ring row as written, for a page that is looking. */
    public static JsonNode diagEvent(JsonNode row) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("type", JsonNode.str("diag")));
        m.add(JsonNode.member("row", row));
        return new JsonNode.Obj(m);
    }

    /** The ring kinds that also go out live as a {@code diag} event: faults only. */
    public static final List<String> LIVE_DIAG_KINDS = Collections.unmodifiableList(
            new ArrayList<>(Collections.singletonList("fault")));

    private static JsonNode strings(List<String> values) {
        List<JsonNode> out = new ArrayList<>();
        for (String v : values) out.add(JsonNode.str(v));
        return new JsonNode.Arr(out);
    }

    // ---- Snapshot v1 (§5.3)

    /**
     * The snapshot's CONTENT, from the core's state and the deck's reading at the moment it is
     * taken: everything but {@code seq} and the two capture stamps, which {@link SnapshotStamper}
     * adds. The Swift {@code EngineSnapshot.body}, the Foray fields included since A-40 (the seam
     * gap, the interlude, the narration playhead, the skipped segments, and the spoken line's
     * clock when there is one and a clock was given).
     */
    public static final class EngineSnapshot {
        private EngineSnapshot() {}

        public static List<JsonNode.Member> body(EngineCore core, DeckReading deck, String lastError) {
            return body(core, deck, lastError, null);
        }

        public static List<JsonNode.Member> body(EngineCore core, DeckReading deck, String lastError, Double monoMs) {
            EngineState state = core.state();
            String type = state.stateType();
            // A stopped engine keeps its queue (the reducer is idle); the page sees nothing loaded.
            EngineItem item = type.equals("idle") ? null : state.currentItem();
            String mode = item == null ? "none" : (state.forayId != null ? "foray" : "episode");
            boolean loaded = item != null && state.loadedId != null;
            Double position = finite(deck.positionSec);
            double playhead = loaded ? JSMath.max(0, position == null ? 0 : position) : 0;
            Double duration = finite(deck.durationSec);
            JsonNode durationNode = loaded && duration != null && duration > 0 ? JsonNode.num(duration) : JsonNode.NULL;
            double rate = state.rate > 0 && !Double.isInfinite(state.rate) && !Double.isNaN(state.rate)
                    ? state.rate : PlaybackRate.DEFAULT_RATE;
            double effectiveRate = type.equals("playing") && !state.buffering ? rate : 0;
            MediaMapping.Metadata metadata = item == null ? null : MediaMapping.metadata(
                    new MediaMapping.Item(string(item.node.get("kind")), string(item.node.get("title")),
                            string(item.node.get("show"))),
                    null, "", 0.0, 0.0, null, MediaMapping.APP_ARTWORK_URL);

            List<JsonNode.Member> m = new ArrayList<>();
            m.add(JsonNode.member("v", JsonNode.num(EngineContract.PROTOCOL_VERSION)));
            m.add(JsonNode.member("mode", JsonNode.str(mode)));
            if (state.forayId != null && item != null) m.add(JsonNode.member("forayId", JsonNode.str(state.forayId)));
            m.add(JsonNode.member("index", item == null ? JsonNode.NULL : JsonNode.num(state.currentIndex)));
            m.add(JsonNode.member("itemId", item == null ? JsonNode.NULL : JsonNode.str(item.id)));
            String kind = item == null ? null : string(item.node.get("kind"));
            m.add(JsonNode.member("itemKind", item == null ? JsonNode.NULL
                    : JsonNode.str(kind != null ? kind : (item.kind == PlayerItemKind.TTS ? EngineConstants.QueueState.TTS : "episode"))));
            m.add(JsonNode.member("state", JsonNode.str(type)));
            if (state.player instanceof PlayerQueueState.Interrupted i) {
                m.add(JsonNode.member("wasPlaying", JsonNode.bool(i.wasPlaying())));
            }
            m.add(JsonNode.member("running", JsonNode.bool(state.isRunning())));
            m.add(JsonNode.member("inSeamGap", JsonNode.bool(state.inSeamGap())));
            m.add(JsonNode.member("inInterlude", JsonNode.bool(state.inInterlude)));
            m.add(JsonNode.member("buffering", JsonNode.bool(state.buffering)));
            m.add(JsonNode.member("ended", JsonNode.bool(type.equals("ended"))));
            m.add(JsonNode.member("positionSec", JsonNode.num(playhead)));
            m.add(JsonNode.member("durationSec", durationNode));
            m.add(JsonNode.member("sourceTimeSec", loaded ? JsonNode.num(playhead) : JsonNode.NULL));
            m.add(JsonNode.member("playheadItemId", state.loadedId == null ? JsonNode.NULL : JsonNode.str(state.loadedId)));
            m.add(JsonNode.member("isNarrationPlayhead", JsonNode.bool(state.isNarrationPlayhead())));
            m.add(JsonNode.member("rate", JsonNode.num(rate)));
            m.add(JsonNode.member("effectiveRate", JsonNode.num(effectiveRate)));
            m.add(JsonNode.member("canNext", JsonNode.bool(core.canNext())));
            m.add(JsonNode.member("canPrevious", JsonNode.bool(item != null && core.canPrevious())));
            m.add(JsonNode.member("autoAdvance", JsonNode.bool(state.autoAdvance)));
            m.add(JsonNode.member("lastError", lastError == null ? JsonNode.NULL : JsonNode.str(lastError)));
            m.add(JsonNode.member("skippedSegments", JsonNode.num(state.skippedSegments)));
            m.add(JsonNode.member("pendingAdvances", JsonNode.num(state.advanceLog.size())));
            m.add(JsonNode.member("pendingEvents", JsonNode.num(state.pendingEvents.size())));
            m.add(JsonNode.member("session", JsonNode.str(state.session.token)));
            m.add(JsonNode.member("holdPolicy", JsonNode.str(state.holdPolicy.text())));
            List<JsonNode.Member> np = new ArrayList<>();
            np.add(JsonNode.member("title", JsonNode.str(metadata == null ? "" : metadata.title())));
            np.add(JsonNode.member("artist", JsonNode.str(metadata == null ? "" : metadata.artist())));
            np.add(JsonNode.member("album", JsonNode.str(metadata == null ? "" : metadata.album())));
            m.add(JsonNode.member("nowPlaying", new JsonNode.Obj(np)));
            // reference-engine.js: the spoken line's clock, when there is one.
            Double elapsed = monoMs == null ? null : core.narrationElapsedSec(monoMs);
            if (elapsed != null && Double.isFinite(elapsed) && elapsed >= 0) {
                m.add(JsonNode.member("narrationElapsedSec", JsonNode.num(elapsed)));
            }
            return m;
        }

        private static Double finite(Double value) {
            return value == null || Double.isNaN(value) || Double.isInfinite(value) ? null : value;
        }

        private static String string(JsonNode node) {
            return node == null ? null : node.stringValue();
        }
    }

    /**
     * {@code seq} is a CONTENT version (reference-engine.js {@code snapshot()}): it moves exactly
     * when something other than the capture time changed, so the page can drop a snapshot older
     * than the one it holds, and the coalescer can tell a transition that changed nothing from
     * one that did.
     */
    public static final class SnapshotStamper {
        private int seq;
        private String lastKey;

        public int seq() {
            return seq;
        }

        /** The stamped snapshot, and whether its content differs from the last one stamped. */
        public record Stamped(JsonNode snapshot, boolean changed) {}

        public Stamped stamp(List<JsonNode.Member> body, double wallMs, double monoMs) {
            String key = JSWriter.stringify(new JsonNode.Obj(body));
            boolean changed = !key.equals(lastKey);
            if (changed) {
                lastKey = key;
                seq += 1;
            }
            List<JsonNode.Member> members = new ArrayList<>(body);
            List<JsonNode.Member> header = new ArrayList<>();
            header.add(JsonNode.member("seq", JsonNode.num(seq)));
            header.add(JsonNode.member("capturedAtWallMs", JsonNode.num(stampOf(wallMs))));
            header.add(JsonNode.member("capturedAtMonotonicMs", JsonNode.num(stampOf(monoMs))));
            // `v` first, then the stamps, then the rest, as §5.3 lists them.
            int versionAt = 0;
            for (int i = 0; i < members.size(); i++) {
                if (members.get(i).key().equals("v")) {
                    versionAt = i + 1;
                    break;
                }
            }
            members.addAll(versionAt, header);
            return new Stamped(new JsonNode.Obj(members), changed);
        }

        private static double stampOf(double ms) {
            return Double.isNaN(ms) || Double.isInfinite(ms) ? 0 : Math.max(0, ms);
        }
    }

    /**
     * WHEN A SNAPSHOT EVENT MAY LEAVE (§5.4): on a transition that changed the content, at most
     * one per {@link #SNAPSHOT_EVENT_MIN_MS}, the latest winning, and never while the page is
     * hidden. A hidden page reads on visible instead, so coming back into view sends exactly one,
     * whatever piled up. Pure: the host arms a timer for {@link Step#OPEN_WINDOW} (re-arming
     * replaces the last one) and calls {@link #windowClosed()} when it fires.
     */
    public static final class SnapshotCoalescer {
        /** One thing the host does, in order: send the current snapshot now, or arm the window timer. */
        public enum Step {
            EMIT,
            OPEN_WINDOW
        }

        private boolean visible;
        private boolean dirty;
        private boolean windowOpen;

        public SnapshotCoalescer(boolean visible) {
            this.visible = visible;
        }

        public SnapshotCoalescer() {
            this(true);
        }

        public boolean visible() {
            return visible;
        }

        public boolean dirty() {
            return dirty;
        }

        public boolean windowOpen() {
            return windowOpen;
        }

        /** A transition changed the snapshot's content. */
        public List<Step> changed() {
            dirty = true;
            return pump();
        }

        /** The window's timer fired. */
        public List<Step> windowClosed() {
            windowOpen = false;
            return pump();
        }

        /**
         * {@code setPageVisible}. Hidden: nothing leaves until visible again. Hidden to visible:
         * one snapshot NOW (a window left over from before the page hid does not hold it back).
         * Visible to visible: just a change.
         */
        public List<Step> setVisible(boolean newValue) {
            boolean wasVisible = visible;
            visible = newValue;
            if (!newValue) return new ArrayList<>();
            dirty = true;
            if (!wasVisible) windowOpen = false;
            return pump();
        }

        private List<Step> pump() {
            List<Step> out = new ArrayList<>();
            if (!visible || windowOpen || !dirty) return out;
            dirty = false;
            windowOpen = true;
            out.add(Step.EMIT);
            out.add(Step.OPEN_WINDOW);
            return out;
        }
    }
}

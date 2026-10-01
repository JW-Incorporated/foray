package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.ContractDecoding;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineBridgeRules;
import ai.jwlabs.foura.engine.EngineBridgeRules.EngineSnapshot;
import ai.jwlabs.foura.engine.EngineBridgeRules.SnapshotCoalescer;
import ai.jwlabs.foura.engine.EngineBridgeRules.SnapshotStamper;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineCore;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineState;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * THE BRIDGE on Android (card A-28, docs/plans/android-assessment.md §5.4; the protocol is
 * docs/native-engine-plan.md §5.1-§5.4): what {@code engineHello}, {@code engineSend} and
 * {@code engineRead} answer, and which {@code engine} events reach the page. The JVM twin of the
 * iOS {@code EngineBridge} (ForayAudioPlugin/Engine/EngineBridge.swift, NE-20), speaking the same
 * protocol v1, so the page's client (player/native-engine.js), its facades and its relinquish path
 * run unchanged over it.
 *
 * <p>The plugin moves bytes (Capacitor's options in, a {@code JSObject} out, and
 * {@code notifyListeners}); everything the page is told is decided here, on main, from the owner's
 * lane and the engine's core. Every payload's shape is the core's ({@link EngineBridgeRules}), so
 * a plain JUnit test checks each against {@link ContractDecoding#accepts}, and this file builds no
 * JSON of its own. PURE JVM: no Android type, so the tests run it over fakes.
 *
 * <h2>ALWAYS AN ANSWER</h2>
 *
 * Each method returns a payload and never throws: an invalid send is {@code {ok: false, reason:
 * "unknown-cmd", snapshot}}, an invalid read reads nothing, and a process with no engine (the
 * legacy lane, or after a relinquish) says so in the hello and refuses sends with a reason.
 *
 * <h2>EVENTS: COALESCED, AND ONLY TO A PAGE THAT IS LOOKING</h2>
 *
 * A hidden page is a WebView the system may throttle or freeze, and an event into it is work for
 * nobody. So nothing at all leaves while the page is hidden; snapshots go at most once a second
 * while it is visible ({@link SnapshotCoalescer}), and the page reads on visible instead (§5.4).
 * What a hidden page missed that matters (walked hops, position events) rides in the snapshot's
 * counts and the hello's logs.
 *
 * <h2>THE PAGE'S VISIBILITY IS THE ENGINE'S LIFECYCLE</h2>
 *
 * iOS feeds the core {@code background} / {@code foreground} from UIKit. On Android the page's
 * {@code setPageVisible} is that signal (A-26 handed it on): a change of visibility is also a
 * {@code Lifecycle} input, after the command, so the core flushes the playhead when the listener
 * leaves and reconciles when they come back.
 *
 * <h2>SEQUENCE GAPS, AND A REFUSAL ON RECORD</h2>
 *
 * Every valid send writes a {@code cmd} row with its source before anything can no-op (D-4), and
 * {@code seqGap: "y"} when its {@code cmdSeq} is not the last one plus one. A hello resets the
 * count. A command the bridge or the engine REFUSED writes a second {@code cmd} row after it,
 * {@code result=<refusal>} (L02).
 *
 * <p>NOT THREAD-SAFE, BY DESIGN: every method is called on the main looper.
 */
public final class EngineBridge {
    /** The lane this process plays through, decided once, and why. */
    public record Decision(String mode, Vocabulary.ModeReason reason) {
        public Decision {
            Objects.requireNonNull(mode, "mode");
            Objects.requireNonNull(reason, "reason");
        }

        public boolean isNative() {
            return EngineContract.MODE_NATIVE.equals(mode);
        }
    }

    /**
     * What the bridge needs of the process's owner: the lane, the engine, and the things only the
     * owner may do (stand the hello watchdog down, write the Developer override, run the one-way
     * relinquish with its hand-over). An interface, so the tests run over a fake owner.
     */
    public interface Owner {
        Decision decideOnce();

        /** The engine's host: live, or torn down after a relinquish, or null when there is none. */
        ForayEngineHost engine();

        /** The page claimed the engine (the hello watchdog, A-29, stands down). */
        void helloReceived();

        /**
         * The engine completed a turn (A-29: the first-input healthy marker, which clears the
         * crash-loop sentinel).
         */
        void engineTurned();

        /**
         * The engine threw while answering the page ({@code at}: {@code hello}). The owner gives
         * the process back (A-29): a fault row, a page-health strike and the relinquish. Must not
         * throw.
         */
        void engineFaulted(String at, RuntimeException error);

        /** The Developer engine setting ({@code MODE_OVERRIDES}), for the next launch. */
        void setModeOverride(String mode);

        /** The one-way hand-over: the core goes terminal, and the owner gives the process back. */
        ForayEngineHost.Verdict relinquish(EngineContract.RelinquishCap cap, Vocabulary.Source source);
    }

    /** What the bridge reads from the engine's records and hears from them ({@link EngineLog}). */
    public interface Records {
        /** What the records tell a listener, on the host's thread. */
        interface Listener {
            void onEmit(EngineCommand.EngineEvent event);

            void onRow(JsonNode row, String kind);
        }

        /** The shared rows under these row-key prefixes, as stored. */
        Map<String, String> sharedRows(List<String> prefixes);

        /** The whole diagnostics ring, oldest first. */
        List<JsonNode> diagnosticRows();

        /** Everything the engine stored, gone. */
        void purge();

        void diag(EngineCommand.DiagEntry entry);

        void setListener(Listener listener);
    }

    private final Owner owner;
    private final Records records;
    private final EngineSeams.Timing timing;
    private final List<String> declaredCapabilities;
    private final Consumer<JsonNode> deliver;

    private final SnapshotStamper stamper = new SnapshotStamper();
    private SnapshotCoalescer coalescer = new SnapshotCoalescer(true);
    private EngineSeams.Cancellable window;
    private Long lastCmdSeq;
    private String lastError;
    private ForayEngineHost hooked;
    private boolean handBackAnnounced;

    public EngineBridge(Owner owner, Records records, EngineSeams.Timing timing, List<String> declaredCapabilities,
                        Consumer<JsonNode> deliver) {
        this.owner = Objects.requireNonNull(owner, "owner");
        this.records = Objects.requireNonNull(records, "records");
        this.timing = Objects.requireNonNull(timing, "timing");
        this.declaredCapabilities = declaredCapabilities == null
                ? Collections.<String>emptyList() : new ArrayList<>(declaredCapabilities);
        this.deliver = Objects.requireNonNull(deliver, "deliver");
        records.setListener(new Records.Listener() {
            @Override
            public void onEmit(EngineCommand.EngineEvent event) {
                engineEmitted(event);
            }

            @Override
            public void onRow(JsonNode row, String kind) {
                liveRow(row, kind);
            }
        });
        hookIfNeeded();
    }

    /** The build's declared capabilities ∩ what this binary may advertise. */
    public List<String> capabilities() {
        return EngineBridgeRules.capabilities(declaredCapabilities);
    }

    /** Whether events may leave (tests read it). */
    public boolean pageVisible() {
        return coalescer.visible();
    }

    // ---- engineHello

    public JsonNode hello(JsonNode payload) {
        owner.helloReceived();
        hookIfNeeded();
        if (!ContractDecoding.accepts("helloRequest", payload)) row("hello", field("invalid", JsonNode.str("y")));
        // A new page: its own command count, and a page that starts in view. Its first snapshot
        // is the one in this answer.
        lastCmdSeq = null;
        cancelWindow();
        coalescer = new SnapshotCoalescer(true);

        Decision decision = owner.decideOnce();
        ForayEngineHost engine = liveEngine();
        if (engine == null) return EngineBridgeRules.legacyHello(legacyReason(decision));
        try {
            EngineFaults.check(EngineFaults.HELLO);
            EngineState state = engine.state();
            return EngineBridgeRules.nativeHello(decision.reason(), capabilities(), snapshot(), state.advanceLog,
                    state.pendingEvents);
        } catch (RuntimeException e) {
            // A-29: AN ENGINE THAT CANNOT ANSWER GIVES THE PROCESS BACK, and the page is told so. The
            // owner relinquishes (the service stops, so the legacy one may start), and `legacy /
            // downgrade` is an answer the page's decideMode reads as "run the JS player": the
            // fallback is the old player, never silence.
            owner.engineFaulted("hello", e);
            return EngineBridgeRules.legacyHello(Vocabulary.ModeReason.DOWNGRADE);
        }
    }

    // ---- engineSend

    public JsonNode send(JsonNode payload) {
        hookIfNeeded();
        ContractDecoding.SendRequest request;
        try {
            request = ContractDecoding.SendRequest.decode(payload);
        } catch (ContractDecoding.ContractError e) {
            JsonNode cmd = payload == null ? null : payload.get("cmd");
            List<JsonNode.Member> fields = new ArrayList<>();
            fields.add(JsonNode.member("invalid", JsonNode.str("y")));
            fields.add(JsonNode.member("cmd", cmd != null && cmd.stringValue() != null ? JsonNode.str(cmd.stringValue()) : JsonNode.NULL));
            row("cmd", fields);
            return reply(EngineContract.Refusal.UNKNOWN_CMD.token);
        }

        // D-4: the source is on record before anything can no-op.
        boolean gap = lastCmdSeq != null && request.cmdSeq() != lastCmdSeq + 1;
        lastCmdSeq = request.cmdSeq();
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("cmd", JsonNode.str(request.name())));
        fields.add(JsonNode.member("source", JsonNode.str(request.source().token)));
        fields.add(JsonNode.member("cmdSeq", JsonNode.num(request.cmdSeq())));
        if (gap) fields.add(JsonNode.member("seqGap", JsonNode.str("y")));
        row("cmd", fields);

        String refusal = dispatch(request);
        if (refusal != null) {
            // L02: the outcome, after the fact, only when it is a refusal.
            List<JsonNode.Member> result = new ArrayList<>();
            result.add(JsonNode.member("cmd", JsonNode.str(request.name())));
            result.add(JsonNode.member("cmdSeq", JsonNode.num(request.cmdSeq())));
            result.add(JsonNode.member("result", JsonNode.str(refusal)));
            row("cmd", result);
        }
        return reply(refusal);
    }

    /** One valid command, run: null when it was accepted, else the refusal the page is answered with. */
    private String dispatch(ContractDecoding.SendRequest request) {
        EngineContract.Command command = request.command();
        // The Developer setting works in every lane: it is how a listener on the web player asks
        // for the native one at the next launch.
        if (command instanceof EngineContract.Command.SetModeOverride m) {
            owner.setModeOverride(m.mode());
            return null;
        }
        // A-67 (NE-40's DV-8 trial): route sharing is an AVAudioSession policy with no Android
        // counterpart. Nothing is stored, and the page is told so rather than shown a choice that
        // nothing applies (client.js offers no such row on Android).
        if (command instanceof EngineContract.Command.SetRouteSharing) return EngineContract.Refusal.CAPABILITY_OFF.token;
        ForayEngineHost engine = liveEngine();
        if (engine == null) {
            // "Delete my data" works in every lane too: what an earlier native session stored is
            // still in the records.
            if (command instanceof EngineContract.Command.Purge) {
                records.purge();
                return null;
            }
            ForayEngineHost any = owner.engine();
            return any != null && any.isTornDown()
                    ? EngineContract.Refusal.RELINQUISHED.token : EngineContract.Refusal.CAPABILITY_OFF.token;
        }
        String needed = EngineBridgeRules.requiredCapability(command);
        if (needed != null && !capabilities().contains(needed)) return EngineContract.Refusal.CAPABILITY_OFF.token;

        ForayEngineHost.Verdict verdict;
        if (command instanceof EngineContract.Command.Relinquish r) {
            // The owner's, not the core's alone: it runs the hand-over after the core goes terminal.
            verdict = owner.relinquish(r.cap(), request.source());
        } else {
            boolean wasVisible = coalescer.visible();
            verdict = engine.handle(new EngineInput.Command(command, request.source()));
            if (command instanceof EngineContract.Command.SetPageVisible v) {
                apply(coalescer.setVisible(v.visible()));
                // The page's visibility is the engine's lifecycle on Android (see the class comment).
                if (v.visible() != wasVisible && !engine.isTornDown()) {
                    engine.handle(new EngineInput.Lifecycle(v.visible()
                            ? new EngineInput.LifecycleEvent.Foreground() : new EngineInput.LifecycleEvent.Background()));
                }
            }
        }
        if (command instanceof EngineContract.Command.Purge) {
            // NE-23's order: stop without persisting, then this. What the engine stored is the
            // records', removed now, before the answer the page waits on to purge its own.
            records.purge();
        }
        if (command instanceof EngineContract.Command.PlayEpisode && verdict.ok()) lastError = null;
        return EngineBridgeRules.refusal(verdict.failures());
    }

    // ---- engineRead

    public JsonNode read(JsonNode payload) {
        hookIfNeeded();
        ContractDecoding.ReadRequest request;
        try {
            request = ContractDecoding.ReadRequest.decode(payload);
        } catch (ContractDecoding.ContractError e) {
            // An unowned or unknown prefix reads NOTHING rather than something: shared rows
            // only, and only the engine's.
            JsonNode what = payload == null ? null : payload.get("what");
            String kind = what == null ? null : what.stringValue();
            if ("snapshot".equals(kind)) return snapshot();
            if ("diagnostics".equals(kind)) return EngineBridgeRules.diagnosticsResponse(Collections.<JsonNode>emptyList());
            return EngineBridgeRules.rowsResponse(Collections.<String, String>emptyMap());
        }
        switch (request.what()) {
            case "snapshot":
                return snapshot();
            case "rows":
                return EngineBridgeRules.rowsResponse(records.sharedRows(
                        request.prefixes() == null ? EngineContract.OWNED_PREFIXES : request.prefixes()));
            default:
                return EngineBridgeRules.diagnosticsResponse(records.diagnosticRows());
        }
    }

    // ---- the engine

    /** The engine playing this process, while it still does. */
    private ForayEngineHost liveEngine() {
        if (!owner.decideOnce().isNative()) return null;
        ForayEngineHost engine = owner.engine();
        return engine == null || engine.isTornDown() ? null : engine;
    }

    /**
     * Why this process is not native: the owner's reason in the legacy lane; {@code downgrade}
     * once the engine gave the process back; {@code not-built} for a native decision with no
     * engine (its service could not be reached), which a hello must still say truthfully.
     */
    private Vocabulary.ModeReason legacyReason(Decision decision) {
        if (!decision.isNative()) return decision.reason();
        return owner.engine() == null ? Vocabulary.ModeReason.NOT_BUILT : Vocabulary.ModeReason.DOWNGRADE;
    }

    /** Listen to the engine once it exists (a recreated service is a new host). Idempotent. */
    private void hookIfNeeded() {
        ForayEngineHost engine = owner.engine();
        if (engine == null || engine == hooked) return;
        hooked = engine;
        handBackAnnounced = false;
        engine.setTurnListener(this::transitioned);
    }

    // ---- the snapshot

    public JsonNode snapshot() {
        return stamp().snapshot();
    }

    private SnapshotStamper.Stamped stamp() {
        List<JsonNode.Member> body;
        ForayEngineHost engine = owner.engine();
        if (engine != null && owner.decideOnce().isNative()) {
            // A torn-down engine still answers (its session reads `relinquished`), but its deck
            // is gone: nothing is loaded.
            DeckReading deck = engine.isTornDown() ? DeckReading.idle() : engine.deckReading();
            body = EngineSnapshot.body(engine.core(), deck, lastError);
        } else {
            body = EngineSnapshot.body(new EngineCore(new EngineConfig()), DeckReading.idle(), null);
        }
        return stamper.stamp(body, timing.wallMs(), timing.monoMs());
    }

    private JsonNode reply(String refusal) {
        return EngineBridgeRules.sendResponse(refusal, snapshot());
    }

    /** The snapshot of no engine at all: what a reply carries when the bridge itself could not run. */
    public static JsonNode emptySnapshot() {
        return new SnapshotStamper().stamp(EngineSnapshot.body(new EngineCore(new EngineConfig()), DeckReading.idle(), null),
                0, 0).snapshot();
    }

    // ---- events

    /** After every input the engine handled, and at its teardown. */
    private void transitioned() {
        ForayEngineHost engine = owner.engine();
        if (engine != null && !engine.isTornDown()) owner.engineTurned();
        if (engine != null && engine.isTornDown() && !handBackAnnounced) {
            handBackAnnounced = true;
            if (coalescer.visible()) deliver.accept(EngineBridgeRules.modeChangedEvent(Vocabulary.ModeReason.DOWNGRADE));
        }
        if (stamp().changed()) apply(coalescer.changed());
    }

    private void engineEmitted(EngineCommand.EngineEvent event) {
        if (event instanceof EngineCommand.EngineEvent.Error e) lastError = e.code();
        if (!coalescer.visible()) return;
        deliver.accept(EngineBridgeRules.event(event));
    }

    private void liveRow(JsonNode row, String kind) {
        if (!coalescer.visible() || !EngineBridgeRules.LIVE_DIAG_KINDS.contains(kind)) return;
        deliver.accept(EngineBridgeRules.diagEvent(row));
    }

    private void apply(List<SnapshotCoalescer.Step> steps) {
        for (SnapshotCoalescer.Step step : steps) {
            switch (step) {
                case EMIT -> deliver.accept(EngineBridgeRules.snapshotEvent(snapshot()));
                case OPEN_WINDOW -> {
                    cancelWindow();
                    window = timing.schedule(EngineBridgeRules.SNAPSHOT_EVENT_MIN_MS, false, this::windowClosed);
                }
            }
        }
    }

    private void windowClosed() {
        cancelWindow();
        apply(coalescer.windowClosed());
    }

    private void cancelWindow() {
        EngineSeams.Cancellable w = window;
        window = null;
        if (w != null) w.cancel();
    }

    // ---- rows

    /**
     * The bridge's rows go where the engine's go (the records' ring). With no engine there is
     * nowhere: a legacy lane writes no rows at all, so a deletion cannot miss one.
     */
    private void row(String kind, List<JsonNode.Member> fields) {
        if (owner.engine() == null) return;
        records.diag(new EngineCommand.DiagEntry(kind, fields));
    }

    private static List<JsonNode.Member> field(String key, JsonNode value) {
        List<JsonNode.Member> out = new ArrayList<>();
        out.add(JsonNode.member(key, value));
        return out;
    }
}

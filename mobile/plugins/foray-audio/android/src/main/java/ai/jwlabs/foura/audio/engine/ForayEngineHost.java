package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineCore;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineNow;
import ai.jwlabs.foura.engine.EngineState;
import ai.jwlabs.foura.engine.EngineTimer;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.ResumeRules;
import ai.jwlabs.foura.engine.SessionPolicy;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * THE ENGINE'S IMPERATIVE SHELL on Android (card A-26, docs/plans/android-assessment.md §5.4):
 * one per {@code ForayPlaybackService}, on the main looper, hosting the pure {@link EngineCore}.
 * The JVM twin of the iOS {@code ForayEngine} (ForayAudioPlugin/Engine/ForayEngine.swift,
 * NE-15h), and like it, it decides nothing:
 * <ol>
 *   <li>it turns every observation (deck events, focus, remote presses, timers) into an
 *       {@link EngineInput};</li>
 *   <li>reads the clocks and the deck, and calls {@code core.handle(input, now)};</li>
 *   <li>interprets each {@link EngineCommand} that comes back through its seams, in order;</li>
 *   <li>tears everything down, once, when the core relinquishes.</li>
 * </ol>
 *
 * <h2>ACTIVATION IS A REQUEST AND A RESPONSE INSIDE ONE TURN</h2>
 *
 * The core emits {@code sessionActivate} and parks the intent. The host calls the session seam
 * synchronously and feeds {@code sessionResult} straight back in, interpreting what that answer
 * produced BEFORE any command that followed the request. So a refused activation is
 * {@code commandFailed} and no deck command at all (plan §4.4's audible-start invariant, end to
 * end), exactly as on iOS.
 *
 * <h2>ONE TURN AT A TIME</h2>
 *
 * A seam may call back while a command is being interpreted (Media3 delivers a listener
 * callback from inside a {@code pause()}; the deck answers {@code ready} from inside
 * {@code load} on a warm source). Handling that input on the spot would interleave a second
 * turn with the rest of the first one's commands, so it is queued and runs the moment the
 * current turn's last command has been interpreted, still inside the same main-thread call.
 * Only the activation answer jumps the queue, because the core is waiting on it.
 *
 * <h2>THE SURFACE</h2>
 *
 * After every input handled to the end, the host computes the {@link Surface}: which remote
 * commands work ({@code MediaMapping.commandAvailability} of the core's snapshot) and what the
 * lock screen says ({@code MediaMapping.sessionView} of the core's {@code mediaView}), and hands
 * it to the {@link SurfaceListener}, which is the Media3 session's player ({@link EnginePlayer}).
 * One object is both iOS's remote-command registry and its Now Playing writer here, because on
 * Android the session player is both.
 *
 * <h2>TERMINAL</h2>
 *
 * When a turn leaves the core relinquished, the host tears down the deck, every timer and the
 * listener, and answers every later input with {@code relinquished} without touching a seam.
 * The listener's last surface is a CLEARED one (nothing enabled, nothing to show), never the
 * last turn's again: the relinquished core still names its item, so its own snapshot would not
 * clear (CH3-07). Then {@link #setOnTornDown the torn-down hook} runs, once: the service
 * releases its Media3 session there, because on Android "leave it for the legacy lane" means a
 * second session gone, not one Now Playing centre left alone as on iOS.
 *
 * <p>NOT THREAD-SAFE, BY DESIGN: every method is called on the host's one looper (main).
 */
public final class ForayEngineHost {
    /** What one input came to: the core's refusals from its turn (and the activation it asked for). */
    public record Verdict(List<String> failures, boolean deferred) {
        public Verdict {
            failures = Collections.unmodifiableList(new ArrayList<>(failures));
        }

        static final Verdict QUEUED = new Verdict(Collections.<String>emptyList(), true);

        public boolean ok() {
            return failures.isEmpty();
        }
    }

    /**
     * What the remote surface shows after a turn: the enabled commands (with the founder's skip
     * pair), and the session view (null when there is nothing to show, which is also when
     * {@code availability.clearsNowPlaying()}). {@code seq} counts surfaces, so a reader can tell
     * two identical ones apart.
     */
    public record Surface(MediaMapping.CommandAvailability availability, MediaMapping.SessionView view,
                          boolean buffering, int seq) {}

    /** Told after every turn (once at start, and a cleared surface at teardown), on the host's thread. */
    public interface SurfaceListener {
        void onSurface(Surface surface);
    }

    private final EngineSeams seams;
    private final EngineCore core;
    private final ArrayDeque<EngineInput> inbox = new ArrayDeque<>();
    private int depth;
    private boolean started;
    private boolean tornDown;
    private final Map<EngineTimer, EngineSeams.Cancellable> timers = new EnumMap<>(EngineTimer.class);
    /** The open grace span's reason and start (monotonic), for the {@code grace} rows' heldMs. */
    private EngineCommand.GraceReason graceReason;
    private double graceSinceMs;
    private SurfaceListener surfaceListener;
    private Runnable onTornDown;
    private Surface surface;
    private int surfaceSeq;
    private int activations;

    public ForayEngineHost(EngineSeams seams, EngineConfig config, Map<String, ResumeRules.StoredPosition> positions) {
        this.seams = Objects.requireNonNull(seams, "seams");
        this.core = new EngineCore(config, positions);
        surface = computeSurface(surfaceSeq);
    }

    public ForayEngineHost(EngineSeams seams, EngineConfig config) {
        this(seams, config, Collections.<String, ResumeRules.StoredPosition>emptyMap());
    }

    /** The core's state, for READING only (the dump, the tests). */
    public EngineState state() {
        return core.state();
    }

    /** The surface as the last turn left it. */
    public Surface surface() {
        return surface;
    }

    public boolean isTornDown() {
        return tornDown;
    }

    /** How many times the session seam was asked to activate. */
    public int activations() {
        return activations;
    }

    /** Timers still armed, by kind. */
    public java.util.Set<EngineTimer> liveTimers() {
        return Collections.unmodifiableSet(timers.keySet());
    }

    public void setSurfaceListener(SurfaceListener listener) {
        surfaceListener = listener;
        if (listener != null && !tornDown) listener.onSurface(surface);
    }

    /**
     * Run once, at the end of {@link #teardown()}, whatever took the engine down (the iOS host's
     * {@code onTornDown}, ForayEngine.swift). Set on the host's thread.
     */
    public void setOnTornDown(Runnable hook) {
        onTornDown = hook;
    }

    /** Observe the deck. Idempotent; a torn-down host never starts again. */
    public void start() {
        if (started || tornDown) return;
        started = true;
        seams.deck.setListener(event -> handle(new EngineInput.Deck(event)));
        publishSurface();
    }

    /**
     * Stop the deck, every timer and the listener, hand the listener a cleared surface, run the
     * torn-down hook, and refuse every later input. Runs by itself when the core relinquishes;
     * the service calls it at {@code onDestroy}.
     */
    public void teardown() {
        if (tornDown) return;
        tornDown = true;
        for (EngineSeams.Cancellable t : timers.values()) t.cancel();
        timers.clear();
        graceReason = null;
        seams.deck.setListener(null);
        seams.deck.invalidate();
        inbox.clear();
        surface = clearedSurface(++surfaceSeq);
        SurfaceListener listener = surfaceListener;
        surfaceListener = null;
        if (listener != null) listener.onSurface(surface);
        Runnable hook = onTornDown;
        onTornDown = null;
        if (hook != null) hook.run();
    }

    // ---- inputs

    /** Run one input through the core and interpret what it returns. */
    public Verdict handle(EngineInput input) {
        if (tornDown) return new Verdict(Collections.singletonList(EngineContract.Refusal.RELINQUISHED.token), false);
        if (depth > 0) {
            inbox.addLast(input);
            return Verdict.QUEUED;
        }
        List<String> failures = runTurn(input);
        drain();
        publishSurface();
        return new Verdict(failures, false);
    }

    /**
     * A remote press (the session's player, a media button, a notification button): the core's
     * {@code remote} row and ruling, then a {@code remote kind=status} companion row with the
     * verdict, as on iOS (NE-18).
     */
    public Verdict remote(EngineInput.RemotePress press) {
        Verdict verdict = handle(new EngineInput.Remote(press));
        if (!tornDown) {
            List<JsonNode.Member> fields = new ArrayList<>();
            fields.add(JsonNode.member("kind", JsonNode.str("status")));
            fields.add(JsonNode.member("cmd", JsonNode.str(remoteToken(press.command()))));
            fields.add(JsonNode.member("status", JsonNode.str(statusToken(verdict))));
            if (!verdict.failures().isEmpty()) fields.add(JsonNode.member("reason", JsonNode.str(verdict.failures().get(0))));
            seams.output.diag(new EngineCommand.DiagEntry("remote", fields));
        }
        return verdict;
    }

    /** iOS's {@code RemoteVerdict} token for a verdict: what the system would have been told. */
    public static String statusToken(Verdict verdict) {
        if (verdict.failures().isEmpty()) return "success";
        if (verdict.failures().contains(EngineContract.Refusal.NOT_LOADED.token)) return "noActionableNowPlayingItem";
        return "commandFailed";
    }

    /** The command's name as the core's {@code remote} row spells it (iOS's MPRemoteCommand names). */
    static String remoteToken(MediaMapping.RemoteCommand command) {
        return switch (command) {
            case PLAY -> "play";
            case PAUSE -> "pause";
            case TOGGLE_PLAY_PAUSE -> "togglePlayPause";
            case NEXT_TRACK -> "nextTrack";
            case PREVIOUS_TRACK -> "previousTrack";
            case SKIP_BACKWARD -> "skipBackward";
            case SKIP_FORWARD -> "skipForward";
            case CHANGE_PLAYBACK_POSITION -> "changePlaybackPosition";
            case STOP -> "stop";
        };
    }

    // ---- turns

    private void drain() {
        while (!inbox.isEmpty() && !tornDown) runTurn(inbox.removeFirst());
    }

    private List<String> runTurn(EngineInput input) {
        depth += 1;
        List<String> failures = new ArrayList<>();
        try {
            List<EngineCommand> commands = core.handle(input, now());
            for (EngineCommand command : commands) {
                if (tornDown) break;
                failures.addAll(interpret(command));
            }
        } finally {
            depth -= 1;
        }
        if (core.state().session == SessionPolicy.Phase.RELINQUISHED) teardown();
        return failures;
    }

    private EngineNow now() {
        return new EngineNow(seams.timing.wallMs(), seams.timing.monoMs(), seams.deck.reading());
    }

    /** Every command has a case: a command the host drops is a stuck player. */
    private List<String> interpret(EngineCommand command) {
        switch (command) {
            case EngineCommand.Deck d -> seams.deck.send(d.command());
            case EngineCommand.SessionActivate a -> {
                // Synchronous, and answered before the next command in this list.
                EngineSeams.Activation answer = seams.session.activate();
                activations += 1;
                return runTurn(new EngineInput.SessionAnswer(
                        new EngineInput.SessionResult(a.requestId(), answer.ok(), answer.error(), answer.activateMs())));
            }
            case EngineCommand.SessionDeactivate d -> seams.session.deactivate(d.notifyOthers());
            case EngineCommand.SessionReapplyCategory r -> seams.session.reapplyCategory();
            case EngineCommand.SessionRebuild r -> seams.session.rebuild();
            case EngineCommand.GraceBegin g -> beginGrace(g.reason());
            case EngineCommand.GraceEnd g -> endGrace(g.outcome());
            case EngineCommand.TimerArm t -> arm(t.timer(), t.afterMs(), t.repeating());
            case EngineCommand.TimerCancel t -> {
                EngineSeams.Cancellable live = timers.remove(t.timer());
                if (live != null) live.cancel();
            }
            case EngineCommand.WritePosition w -> seams.output.writePosition(w.write());
            case EngineCommand.WriteRow w -> seams.output.writeRow(w.row());
            case EngineCommand.AppendEvent e -> seams.output.appendEvent(e.event());
            case EngineCommand.WriteRestore w -> seams.output.writeRestore(w.record());
            case EngineCommand.Speak s -> {
                // An audition line (engineSend audition): the synthesiser behind the engine is
                // A-41's. Written down rather than dropped, so a Copy says why nothing spoke.
                seams.output.diag(new EngineCommand.DiagEntry("speak", Collections.singletonList(
                        JsonNode.member("kind", JsonNode.str("unsupported")))));
            }
            case EngineCommand.Emit e -> seams.output.emit(e.event());
            case EngineCommand.Diag d -> seams.output.diag(d.entry());
            case EngineCommand.CommandFailed f -> {
                return Collections.singletonList(f.reason());
            }
        }
        return Collections.emptyList();
    }

    // ---- grace (a row on Android)

    /**
     * Plan §4.4's grace span. iOS holds a UIKit background task for it; a mediaPlayback
     * foreground service has no background budget to borrow, so on Android the span is its
     * rows: {@code grace kind=begin} and {@code grace kind=end outcome=… heldMs=…}, the resume
     * latency the car drive is judged on.
     */
    private void beginGrace(EngineCommand.GraceReason reason) {
        graceReason = reason;
        graceSinceMs = seams.timing.monoMs();
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("kind", JsonNode.str("begin")));
        fields.add(JsonNode.member("reason", JsonNode.str(reason.token)));
        fields.add(JsonNode.member("task", JsonNode.str("none")));
        seams.output.diag(new EngineCommand.DiagEntry("grace", fields));
    }

    private void endGrace(EngineCommand.GraceOutcome outcome) {
        EngineCommand.GraceReason reason = graceReason;
        graceReason = null;
        if (reason == null) return;
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("kind", JsonNode.str("end")));
        fields.add(JsonNode.member("outcome", JsonNode.str(outcome.token)));
        fields.add(JsonNode.member("reason", JsonNode.str(reason.token)));
        fields.add(JsonNode.member("heldMs", JsonNode.num(Math.round(seams.timing.monoMs() - graceSinceMs))));
        seams.output.diag(new EngineCommand.DiagEntry("grace", fields));
    }

    // ---- timers

    private void arm(EngineTimer timer, double afterMs, boolean repeating) {
        EngineSeams.Cancellable previous = timers.remove(timer);
        if (previous != null) previous.cancel();
        timers.put(timer, seams.timing.schedule(afterMs, repeating, () -> timerFired(timer, repeating)));
    }

    /** A one-shot is spent once it fires: nothing stays registered for a timer the core no longer thinks is armed. */
    private void timerFired(EngineTimer timer, boolean repeating) {
        if (tornDown) return;
        if (!repeating) {
            EngineSeams.Cancellable spent = timers.remove(timer);
            if (spent != null) spent.cancel();
        }
        handle(new EngineInput.Timer(timer));
    }

    // ---- the surface

    private Surface computeSurface(int seq) {
        MediaMapping.CommandAvailability availability =
                MediaMapping.commandAvailability(core.commandSnapshot(), MediaMapping.SeekSteps.DEFAULT);
        MediaMapping.SessionView view = null;
        if (!availability.clearsNowPlaying()) {
            MediaMapping.View mv = core.mediaView(seams.deck.reading());
            if (mv != null) view = MediaMapping.sessionView(mv);
        }
        return new Surface(availability, view, core.state().buffering, seq);
    }

    /**
     * The terminal surface: what an UNLOADED snapshot maps to (every command disabled, Now Playing
     * cleared), with nothing to show. Not {@code computeSurface}: a relinquish leaves the core's
     * queue and index as they were, so its snapshot still reads the item it was playing.
     */
    private static Surface clearedSurface(int seq) {
        MediaMapping.CommandSnapshot none = new MediaMapping.CommandSnapshot(
                MediaMapping.CommandSnapshot.Mode.UNLOADED, false, false, false, false);
        return new Surface(MediaMapping.commandAvailability(none, MediaMapping.SeekSteps.DEFAULT), null, false, seq);
    }

    private void publishSurface() {
        if (tornDown) return;
        surface = computeSurface(++surfaceSeq);
        SurfaceListener listener = surfaceListener;
        if (listener != null) listener.onSurface(surface);
    }

    /**
     * The surface re-read NOW (the deck's playhead moves between turns), for the session
     * player's position and the dump. Does not tell the listener.
     */
    public Surface freshSurface() {
        return tornDown ? surface : computeSurface(surfaceSeq);
    }
}

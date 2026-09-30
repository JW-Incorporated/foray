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
import ai.jwlabs.foura.engine.RestoreRecord;
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
 * <h2>THE BRIDGE LISTENS (A-28)</h2>
 *
 * The page's bridge ({@link EngineBridge}) hears every turn through the one
 * {@link #setTurnListener turn listener}: after each input handled to the end (the surface is
 * published first), and once more at teardown. It reads the snapshot's content from
 * {@link #core()} and {@link #deckReading()}; it never changes anything but through
 * {@link #handle}.
 *
 * <h2>THE FORAY TAPE (A-40)</h2>
 *
 * The service builds the core with the tape on ({@link EngineConfig#forayTapeEnabled}) over a
 * {@link DeckPair}, so a {@code playForay} that reaches the core plays: the seam beat and the
 * narration pulse are ordinary timers here, and the deck pair answers {@code prepare}. What the
 * host does NOT have yet is a synthesiser and a jingle player (A-41, with rendered narration's
 * Phase 4): a spoken line is answered {@code failed} at once, as the JS tape answers a bridge with
 * no on-device TTS plugin, so the core steps over it (a bridge) or reports the load (a first line);
 * the jingle is off ({@code interludeAvailable} false), and the silence node is off. Until A-42
 * the page's bridge still refuses {@code playForay} ({@code foray} is not advertised), so only the
 * debug driver reaches it.
 *
 * <h2>TERMINAL</h2>
 *
 * When a turn leaves the core relinquished, the host tears down the deck, every timer and the
 * listener, and answers every later input with {@code relinquished} without touching a seam.
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

    /** Told after every turn (and once at start), on the host's thread. */
    public interface SurfaceListener {
        void onSurface(Surface surface);
    }

    /**
     * What a cold boot found in the restore record (card A-27): the Swift
     * {@code ForayEngine.ColdBootOutcome}, token for token, because the {@code restore} row
     * that says which one is the same row on both platforms.
     */
    public enum ColdBootOutcome {
        /** A record with a queue: the session is painted paused at the recorded position, nothing activated. */
        PAINTED("painted"),
        /** No record, or one this build cannot trust: a play answers {@code noActionableNowPlayingItem}. */
        NO_RECORD("none"),
        /** {@code {mode: "relinquished"}} (plan §4.6 step 6): the legacy lane owns playback. */
        RELINQUISHED("relinquished"),
        /** A Foray record (A-40's), or a queue whose items this build cannot read. */
        UNPLAYABLE("unplayable"),
        /** An input was already handled, or the engine is not started or is torn down: the core is never replaced. */
        LATE("late");

        public final String token;

        ColdBootOutcome(String token) {
            this.token = token;
        }
    }

    private final EngineSeams seams;
    /** Replaced once, by {@link #coldBoot}, before any input; never after. */
    private EngineCore core;
    private final ArrayDeque<EngineInput> inbox = new ArrayDeque<>();
    private int depth;
    private boolean started;
    private boolean tornDown;
    /** An input has been handled: from then on the core is the one the inputs built, and a cold boot is late. */
    private boolean handledAny;
    private final Map<EngineTimer, EngineSeams.Cancellable> timers = new EnumMap<>(EngineTimer.class);
    /** The open grace span's reason and start (monotonic), for the {@code grace} rows' heldMs. */
    private EngineCommand.GraceReason graceReason;
    private double graceSinceMs;
    private SurfaceListener surfaceListener;
    private Runnable turnListener;
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

    /** The core, for READING only: the bridge's snapshot body (A-28). */
    public EngineCore core() {
        return core;
    }

    /** The deck's reading now, or idle once torn down (the deck is gone). */
    public ai.jwlabs.foura.engine.DeckReading deckReading() {
        return tornDown ? ai.jwlabs.foura.engine.DeckReading.idle() : seams.deck.reading();
    }

    /**
     * Told after every input handled to the end, and once at teardown, on the host's thread: the
     * page's bridge (A-28), which stamps a snapshot and decides whether an event may leave. One
     * listener; null clears it.
     */
    public void setTurnListener(Runnable listener) {
        turnListener = listener;
    }

    private void turned() {
        Runnable listener = turnListener;
        if (listener == null) return;
        try {
            listener.run();
        } catch (RuntimeException ignored) {
            // A listener that throws must never cost the engine a turn.
        }
    }

    /** The surface as the last turn left it. */
    public Surface surface() {
        return surface;
    }

    public boolean isTornDown() {
        return tornDown;
    }

    /** Whether any input has reached the core yet (a cold boot after one is {@link ColdBootOutcome#LATE}). */
    public boolean hasHandledInput() {
        return handledAny;
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

    /** Observe the deck. Idempotent; a torn-down host never starts again. */
    public void start() {
        if (started || tornDown) return;
        started = true;
        seams.deck.setListener(event -> handle(new EngineInput.Deck(event)));
        publishSurface();
    }

    /**
     * Stop the deck, every timer and the listener, and refuse every later input. Runs by itself
     * when the core relinquishes; the service calls it at {@code onDestroy}.
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
        SurfaceListener listener = surfaceListener;
        surfaceListener = null;
        if (listener != null) listener.onSurface(surface);
        turned();
    }

    // ---- the cold path (A-27)

    /**
     * Plan §4.5, the cold path, the JVM twin of the Swift {@code ForayEngine.coldBoot} (NE-24):
     * rebuild the core from the private restore record, BEFORE any input, and hand it the queue
     * as {@code lifecycle(coldLaunch(autoplay: false))}, so the session's commands and its
     * paused entry (the recorded item at the recorded position) are published with no
     * activation and nothing sent to the deck (S-3). The play that follows (a car's, through
     * Media3's playback resumption) is an ordinary remote press: it activates once and loads at
     * the recorded offset.
     *
     * <p>Writes one {@code restore kind=cold-boot record=<outcome>} row (with {@code index} and
     * {@code items} when it painted), except when it is late: a boot after the first input
     * never replaces the core an input is already driving, and says nothing.
     */
    public ColdBootOutcome coldBoot(RestoreRecord record) {
        ColdBootOutcome outcome;
        EngineCore.ColdRestore restored = null;
        if (!started || tornDown || handledAny || depth > 0) {
            outcome = ColdBootOutcome.LATE;
        } else if (record == null) {
            outcome = ColdBootOutcome.NO_RECORD;
        } else if (record.mode() == RestoreRecord.Mode.RELINQUISHED) {
            outcome = ColdBootOutcome.RELINQUISHED;
        } else {
            restored = EngineCore.restoring(record, core.config());
            outcome = restored == null ? ColdBootOutcome.UNPLAYABLE : ColdBootOutcome.PAINTED;
        }
        if (outcome != ColdBootOutcome.LATE) {
            List<JsonNode.Member> fields = new ArrayList<>();
            fields.add(JsonNode.member("kind", JsonNode.str("cold-boot")));
            fields.add(JsonNode.member("record", JsonNode.str(outcome.token)));
            if (restored != null) {
                fields.add(JsonNode.member("index", JsonNode.num(restored.index())));
                fields.add(JsonNode.member("items", JsonNode.num(restored.queue().size())));
            }
            seams.output.diag(new EngineCommand.DiagEntry("restore", fields));
        }
        if (restored != null) {
            core = restored.core();
            handle(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.ColdLaunch(restored.queue(), restored.index(), false)));
        }
        return outcome;
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
        if (!tornDown) turned();
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
        handledAny = true;
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
            case EngineCommand.Narration n -> narration(n.command());
            case EngineCommand.Interlude i -> {
                // No jingle player (A-41): the core arms none with interludeAvailable off. One that
                // arrives anyway ends at once, as a refused start does, so the beat never waits on it.
                if (i.command() == EngineCommand.InterludeCommand.START) {
                    handle(new EngineInput.Interlude(new EngineInput.InterludeEvent.Ended("refused")));
                }
            }
            // The silence node is off (silenceNodeEnabled false): nothing to render.
            case EngineCommand.SilenceStart s -> {}
            case EngineCommand.SilenceStop s -> {}
            // The surface is re-read after every turn; a pulse needs nothing more.
            case EngineCommand.NarrationPulse p -> {}
        }
        return Collections.emptyList();
    }

    /**
     * The narrating overlay's synthesiser (A-41's: Android {@code TextToSpeech} behind the engine).
     * Until it exists a spoken line is refused at once, as the JS tape's bridge answers with no
     * on-device TTS plugin, so the core steps over a bridge and reports a first line; nothing
     * ever starts, so a pause, a stop or a discard has nothing to act on. Queued behind the current
     * turn, as any answer a seam gives while a turn is being interpreted.
     */
    private void narration(EngineCommand.NarrationCommand command) {
        switch (command) {
            case EngineCommand.NarrationCommand.Speak s -> {
                seams.output.diag(new EngineCommand.DiagEntry("speak", java.util.Arrays.asList(JsonNode.member("kind", JsonNode.str("unsupported")),
                        JsonNode.member("seq", JsonNode.num(s.seq())))));
                handle(new EngineInput.Narrator(new EngineInput.NarratorEvent.Failed(s.seq(), "no-synthesiser")));
            }
            case EngineCommand.NarrationCommand.Resume r -> handle(new EngineInput.Narrator(
                    new EngineInput.NarratorEvent.Resumed(r.seq(), EngineInput.NarrationResumeAnswer.NO_ANSWER)));
            case EngineCommand.NarrationCommand.Pause p -> {}
            case EngineCommand.NarrationCommand.Stop s -> {}
            case EngineCommand.NarrationCommand.Discard d -> {}
        }
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
            MediaMapping.View mv = core.mediaView(seams.deck.reading(), seams.timing.monoMs());
            if (mv != null) view = MediaMapping.sessionView(mv);
        }
        return new Surface(availability, view, core.state().buffering, seq);
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

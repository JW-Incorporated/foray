package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckDeadlineClass;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineConstants;
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
import ai.jwlabs.foura.engine.RouteResume;
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
 * narration pulse are ordinary timers here, and the deck pair answers {@code prepare}. Since A-42
 * the build advertises {@code foray}, so the page's own {@code playForay} reaches it through the
 * bridge (until then only the debug driver did).
 *
 * <h2>THE NARRATION AND THE JINGLE (A-41)</h2>
 *
 * A RENDERED line (one with an {@code audio_url}) is an ordinary file on the deck: the core loads
 * it like a segment, and its §14 fallback (the file failed or missed its deadline) asks the
 * synthesiser to read the line's script instead. A SPOKEN line, the fallback and the voice
 * picker's audition all go to the {@link EngineSeams.Speaking speaker} ({@link SpeechNarrator}
 * over {@code TextToSpeech}), whose answers come back as {@code narrator} inputs queued behind the
 * turn that asked. The seam's jingle goes to the {@link EngineSeams.InterludePlaying jingle
 * player} ({@link InterludePlayer}); its end shrinks the seam back to the beat. A host built with
 * neither (the tests, a build whose asset is missing) keeps A-40's behaviour: a spoken line is
 * answered {@code failed} at once, so the core steps over it, and a jingle start ends at once. The
 * silence node stays off.
 *
 * <h2>THE BEAT HOLDS THE CPU (A-40 review)</h2>
 *
 * Between two segments NO player plays: the outgoing deck paused at its out-point (Media3's wake
 * mode lets its lock go with play-when-ready), and the incoming one, promoted warm, never gated a
 * load (ExoDeck's gate lock is held only while a load gates). So the seam beat, a handler timer on
 * uptime, would run with no lock at all, and with the screen off the CPU may suspend inside it and
 * the next segment start late or not until something else wakes the phone. The host therefore
 * holds a {@link BeatAwake} exactly while the core reads {@code inSeamGap}, re-synced after every
 * turn and let go at teardown. The beat is bounded by the core (its own timer, the jingle's
 * ceiling, and every transport action cuts it), so the lock is too.
 *
 * <p>A SPOKEN LINE IS THE SAME CASE (A-41 review). While a spoken line (a bridge, or a rendered
 * line's fallback) is the Foray's playhead, no deck plays either: the synthesiser is
 * {@code TextToSpeech}, in ANOTHER process, and nothing in this one holds the CPU while it
 * synthesises (about 2 s on the emulator before the first word), between its callbacks, or while
 * the line's own timers run. So the same lock is held while the core runs with a spoken line as its
 * playhead ({@code isNarrationPlayhead} and running), and goes with a pause, a stop or the next
 * item's load landing.
 *
 * <h2>A SILENT SEAM KEEPS THE SERVICE IN THE FOREGROUND (A-65)</h2>
 *
 * Android does not suspend a process that runs a foreground {@code MediaSessionService}; its risk
 * is the service LEAVING the foreground while nothing sounds, and Media3 keeps it there only while
 * the session's player has play-when-ready on and is READY or BUFFERING. So no silence is rendered
 * (the silence node stays off, as on iOS): the {@link Surface} says when the Foray is in its seam
 * beat ({@link Surface#silentSeam}), and the facade reports that as BUFFERING with play-when-ready
 * on ({@link EnginePlayer}), the clock standing still until the next item is audible.
 *
 * <p>THE LATE-TIMER ROW (NE-46's detector, mirrored). Every one-shot timer the host arms is kept in
 * a ledger with its due time on both clocks; when one fires, and when the deck's P-13 load deadline
 * fires, the host compares the due time with now BEFORE the input is handled (so the seam and the
 * grace span it may close are still what the timer found). More than
 * {@code NARRATION_SUSPEND_GAP_MS} late while a grace span is held writes
 * {@code grace kind=late timer= lateMs= inSeam=y|n reason= clock=mono|wall}, iOS's row without
 * {@code bgRemainingMs} (a mediaPlayback foreground service has no background budget). The row
 * decides nothing. On Android the monotonic clock is {@code elapsedRealtime}, which keeps counting
 * in deep sleep, so a timer the sleeping CPU held back is late on it; the wall clock is kept for the
 * row's iOS shape.
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
     * two identical ones apart. {@code listeningRate} (A-60) is the listener's speed
     * ({@code EngineState.rate}), which the session publishes whatever the view's clock is doing:
     * the view's rate is 0 through a stall, and the listener's speed is not. {@code silentSeam}
     * (A-65) is the seam beat ({@link #inSeamBeat}): no item of the Foray sounds and its clock stands
     * still, which the facade reports as BUFFERING so the service stays in the foreground.
     */
    public record Surface(MediaMapping.CommandAvailability availability, MediaMapping.SessionView view,
                          boolean buffering, int seq, double listeningRate, boolean silentSeam) {
        /** A surface outside a seam beat. */
        public Surface(MediaMapping.CommandAvailability availability, MediaMapping.SessionView view,
                       boolean buffering, int seq, double listeningRate) {
            this(availability, view, buffering, seq, listeningRate, false);
        }

        /** A surface whose listening speed is the view's running rate (1 when the clock stands still). */
        public Surface(MediaMapping.CommandAvailability availability, MediaMapping.SessionView view, boolean buffering, int seq) {
            this(availability, view, buffering, seq, viewRate(view));
        }

        private static double viewRate(MediaMapping.SessionView view) {
            MediaMapping.PositionState position = view == null ? null : view.positionState();
            return position != null && position.playbackRate() > 0 ? position.playbackRate() : 1;
        }
    }

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
    private BeatAwake beatAwake;
    private boolean beatHeld;
    private Surface surface;
    private int surfaceSeq;
    private int activations;
    /** The known routes the store last heard (A-61), persisted when a turn changes them. */
    private List<String> storedKnownRoutes;
    /**
     * A-65 (NE-46's ledger): when each armed ONE-SHOT timer is due, {@code {mono, wall}}, from its
     * arm until it fires or is cancelled. Repeating timers are not kept.
     */
    private final Map<EngineTimer, double[]> timerDue = new EnumMap<>(EngineTimer.class);
    /** A-65: the deck's P-13 deadline in ms by class ({@link #setLoadDeadlines}); empty: none is checked. */
    private Map<DeckDeadlineClass, Double> loadDeadlineMs = Collections.emptyMap();
    /** A-65: the newest load the host sent the deck: its token, its P-13 class and the wall clock then. */
    private Integer lastLoadToken;
    private DeckDeadlineClass lastLoadClass;
    private double lastLoadWallMs;

    public ForayEngineHost(EngineSeams seams, EngineConfig config, Map<String, ResumeRules.StoredPosition> positions) {
        this.seams = Objects.requireNonNull(seams, "seams");
        this.core = new EngineCore(withKnownRoutes(config, seams.knownRoutes), positions);
        storedKnownRoutes = core.config().knownRoutes();
        surface = computeSurface(surfaceSeq);
    }

    /**
     * A-61 (the Swift ForayEngine init, NE-38rs): the install's salt and the routes our audio was
     * heard through, from {@code ForayEngine.knownRoutes}; a new salt when there is none (it is
     * written with the first known route). A config that already carries a salt and no store
     * (a test) keeps its own.
     */
    static EngineConfig withKnownRoutes(EngineConfig config, EngineSeams.KnownRoutesStoring store) {
        RouteResume.Stored stored = null;
        if (store != null) {
            try {
                stored = store.loadKnownRoutes();
            } catch (RuntimeException e) {
                stored = null;
            }
        }
        if (stored != null) return config.withRouteResume(config.routeResumeBluetooth(), stored.salt(), stored.keys());
        String salt = RouteResume.isSalt(config.routeSalt()) ? config.routeSalt() : RouteResume.newSalt();
        return config.withRouteResume(config.routeResumeBluetooth(), salt, config.knownRoutes());
    }

    /**
     * A-61: the core's known routes are the host's to keep, in the private key, whenever a turn
     * changed them (a route heard for a second, a data deletion). An empty set removes the key, so
     * a deletion leaves nothing behind.
     */
    private void persistKnownRoutesIfChanged() {
        List<String> keys = core.state().knownRoutes.keys();
        if (keys.equals(storedKnownRoutes)) return;
        storedKnownRoutes = keys;
        EngineSeams.KnownRoutesStoring store = seams.knownRoutes;
        if (store == null) return;
        try {
            store.saveKnownRoutes(keys.isEmpty() ? null : new RouteResume.Stored(core.config().routeSalt(), keys));
        } catch (RuntimeException ignored) {
            // A failed write must never cost the engine a turn (the store writes its own fault row).
        }
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

    /**
     * A-65: the deck's own P-13 deadlines, in ms by class (the service's {@code ExoDeck} config), so a
     * {@code deadlineExceeded} that arrives late while grace is held writes
     * {@code grace kind=late timer=load-deadline}. Without them (the plain-JVM tests) no load deadline
     * is checked, as iOS's headless core does with an empty {@code loadDeadlineMs}.
     */
    public void setLoadDeadlines(Map<DeckDeadlineClass, Double> deadlines) {
        loadDeadlineMs = deadlines == null || deadlines.isEmpty()
                ? Collections.<DeckDeadlineClass, Double>emptyMap() : new EnumMap<>(deadlines);
    }

    /** Holds the CPU awake through the seam beat; see THE BEAT HOLDS THE CPU. */
    public interface BeatAwake {
        void setStayAwake(boolean stayAwake);
    }

    /** The lock the host holds while the seam beat runs (the service's: a partial wake lock). Null: none. */
    public void setBeatAwake(BeatAwake awake) {
        if (beatHeld && beatAwake != null) beatAwake.setStayAwake(false);
        beatHeld = false;
        beatAwake = awake;
        syncBeatAwake();
    }

    /** Whether the host holds the beat's lock now (tests and the diagnostics). */
    public boolean holdsBeatWakeLock() {
        return beatHeld;
    }

    /**
     * The beat's lock is held exactly while the core's seam beat runs, or while a spoken line is the
     * running playhead (A-41 review), on a live host.
     */
    private void syncBeatAwake() {
        EngineState st = core.state();
        boolean want = beatAwake != null && !tornDown && (st.inSeamGap() || (st.isNarrationPlayhead() && st.isRunning()));
        if (want == beatHeld) return;
        beatHeld = want;
        beatAwake.setStayAwake(want);
    }

    public void setSurfaceListener(SurfaceListener listener) {
        surfaceListener = listener;
        if (listener != null && !tornDown) listener.onSurface(surface);
    }

    /** Observe the deck. Idempotent; a torn-down host never starts again. */
    public void start() {
        if (started || tornDown) return;
        started = true;
        seams.deck.setListener(event -> {
            // A-65: a P-13 deadline is measured as it arrives, before the turn it starts.
            if (event instanceof DeckEvent.DeadlineExceeded d) noteLateDeadline(d);
            handle(new EngineInput.Deck(event));
        });
        if (seams.speaker != null) {
            seams.speaker.setListener(new EngineSeams.SpeakingListener() {
                @Override
                public void onNarratorEvent(EngineInput.NarratorEvent event) {
                    handle(new EngineInput.Narrator(event));
                }

                @Override
                public void onAuditionEnded(String end) {
                    // The core has no input for an audition's end: a row, so a Copy says how it ended.
                    seams.output.diag(new EngineCommand.DiagEntry("speaker", java.util.Arrays.asList(
                            JsonNode.member("kind", JsonNode.str("audition-end")), JsonNode.member("end", JsonNode.str(end)))));
                }
            });
        }
        if (seams.interlude != null) {
            seams.interlude.setOnEnded(reason -> handle(new EngineInput.Interlude(new EngineInput.InterludeEvent.Ended(reason))));
        }
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
        timerDue.clear();
        graceReason = null;
        seams.deck.setListener(null);
        seams.deck.invalidate();
        // Nothing sounds past a teardown: the synthesiser and the jingle go with the deck.
        if (seams.speaker != null) {
            seams.speaker.setListener(null);
            seams.speaker.release();
        }
        if (seams.interlude != null) {
            seams.interlude.setOnEnded(null);
            seams.interlude.release();
        }
        inbox.clear();
        syncBeatAwake();
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
        syncBeatAwake();
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
        persistKnownRoutesIfChanged();
        if (core.state().session == SessionPolicy.Phase.RELINQUISHED) teardown();
        return failures;
    }

    private EngineNow now() {
        // A-61: the current route, the one a playing deck is heard through (null: none known).
        EngineInput.RoutePort route = null;
        if (seams.routes != null) {
            try {
                route = seams.routes.currentRoute();
            } catch (RuntimeException ignored) {
                route = null;
            }
        }
        return new EngineNow(seams.timing.wallMs(), seams.timing.monoMs(), seams.deck.reading(), null,
                ai.jwlabs.foura.engine.NarratorReading.UNKNOWN, route);
    }

    /** Every command has a case: a command the host drops is a stuck player. */
    private List<String> interpret(EngineCommand command) {
        switch (command) {
            case EngineCommand.Deck d -> {
                if (d.command() instanceof DeckCommand.Load load) {
                    // A-65: the load a later deadline belongs to, its class and the wall clock now.
                    lastLoadToken = load.token();
                    lastLoadClass = load.deadlineClass() == null ? DeckDeadlineClass.CLIP : load.deadlineClass();
                    lastLoadWallMs = seams.timing.wallMs();
                }
                seams.deck.send(d.command());
            }
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
                timerDue.remove(t.timer());
            }
            case EngineCommand.WritePosition w -> seams.output.writePosition(w.write());
            case EngineCommand.WriteRow w -> seams.output.writeRow(w.row());
            case EngineCommand.AppendEvent e -> seams.output.appendEvent(e.event());
            case EngineCommand.WriteRestore w -> seams.output.writeRestore(w.record());
            case EngineCommand.Speak s -> {
                // An audition line (engineSend audition), on the one synthesiser. With none, written
                // down rather than dropped, so a Copy says why nothing spoke.
                if (seams.speaker != null) {
                    seams.speaker.speak(s.text(), s.voiceId());
                } else {
                    seams.output.diag(new EngineCommand.DiagEntry("speak", Collections.singletonList(
                            JsonNode.member("kind", JsonNode.str("unsupported")))));
                }
            }
            case EngineCommand.Emit e -> seams.output.emit(e.event());
            case EngineCommand.Diag d -> seams.output.diag(d.entry());
            case EngineCommand.CommandFailed f -> {
                return Collections.singletonList(f.reason());
            }
            case EngineCommand.Narration n -> narration(n.command());
            case EngineCommand.Interlude i -> interlude(i.command());
            // The silence node is off (silenceNodeEnabled false): nothing to render.
            case EngineCommand.SilenceStart s -> {}
            case EngineCommand.SilenceStop s -> {}
            // The surface is re-read after every turn; a pulse needs nothing more.
            case EngineCommand.NarrationPulse p -> {}
        }
        return Collections.emptyList();
    }

    /**
     * The jingle (A-41's {@link InterludePlayer}). The core asks only when {@code interludeAvailable}
     * is on and its session is active; the player checks the session again. A start that is refused
     * (or a host with no player) ends at once, queued behind this turn, so the beat never waits on a
     * jingle that will not sound.
     */
    private void interlude(EngineCommand.InterludeCommand command) {
        EngineSeams.InterludePlaying player = seams.interlude;
        switch (command) {
            case START -> {
                if (player == null || !player.start()) {
                    handle(new EngineInput.Interlude(new EngineInput.InterludeEvent.Ended("refused")));
                }
            }
            case STOP -> {
                if (player != null) player.stop();
            }
            case RELEASE -> {
                if (player != null) player.release();
            }
        }
    }

    /**
     * The narrating overlay's synthesiser: {@link SpeechNarrator} over Android {@code TextToSpeech}
     * (A-41), the same one that speaks an audition; its answers come back through the listener set at
     * {@link #start}, after this turn. With no speaker a spoken line is refused at once, as the JS
     * tape's bridge answers with no on-device TTS plugin, so the core steps over a bridge and reports a
     * first line; nothing ever starts, so a pause, a stop or a discard has nothing to act on. Queued
     * behind the current turn, as any answer a seam gives while a turn is being interpreted.
     */
    private void narration(EngineCommand.NarrationCommand command) {
        if (seams.speaker != null) {
            seams.speaker.narrate(command);
            return;
        }
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
        if (repeating) {
            timerDue.remove(timer);
        } else {
            timerDue.put(timer, new double[] {seams.timing.monoMs() + afterMs, seams.timing.wallMs() + afterMs});
        }
        timers.put(timer, seams.timing.schedule(afterMs, repeating, () -> timerFired(timer, repeating)));
    }

    /** A one-shot is spent once it fires: nothing stays registered for a timer the core no longer thinks is armed. */
    private void timerFired(EngineTimer timer, boolean repeating) {
        if (tornDown) return;
        if (!repeating) {
            EngineSeams.Cancellable spent = timers.remove(timer);
            if (spent != null) spent.cancel();
            // A-65: how late it fired, measured before its input is handled (or queued).
            double[] due = timerDue.remove(timer);
            if (due != null) lateRow(timer.token, seams.timing.monoMs() - due[0], seams.timing.wallMs() - due[1]);
        }
        handle(new EngineInput.Timer(timer));
    }

    // ---- the late-timer row (A-65, NE-46's detector)

    /** The {@code timer=} of a late P-13 load deadline (the deck runs it, not the core): iOS's token. */
    public static final String LOAD_DEADLINE_TIMER = "load-deadline";

    /**
     * The deck's P-13 deadline for the newest load, against the deadline the deck runs for its class:
     * the deck's own {@code afterMs} (elapsedRealtime) and the wall clock since the load was sent.
     */
    private void noteLateDeadline(DeckEvent.DeadlineExceeded event) {
        if (tornDown || lastLoadToken == null || event.token() != lastLoadToken || lastLoadClass == null) return;
        Double deadlineMs = loadDeadlineMs.get(lastLoadClass);
        if (deadlineMs == null) return;
        lateRow(LOAD_DEADLINE_TIMER, event.afterMs() - deadlineMs, seams.timing.wallMs() - lastLoadWallMs - deadlineMs);
    }

    /**
     * {@code grace kind=late timer= lateMs= inSeam=y|n reason= clock=mono|wall}, when a grace span is
     * held and the timer is more than {@code NARRATION_SUSPEND_GAP_MS} late on either clock (the
     * larger reading; {@code clock} says which one saw it). The Swift {@code EngineCore.lateRow}
     * (NE-46, #901), written by the host here because on Android the timers are the host's, and with
     * no {@code bgRemainingMs} (Android has no background budget).
     */
    private void lateRow(String timer, double monoLateMs, double wallLateMs) {
        EngineState st = core.state();
        EngineCommand.GraceReason reason = st.grace;
        if (reason == null) return;
        double gap = EngineConstants.QueueManager.NARRATION_SUSPEND_GAP_MS;
        double mono = Double.isFinite(monoLateMs) ? monoLateMs : Double.NEGATIVE_INFINITY;
        double wall = Double.isFinite(wallLateMs) ? wallLateMs : Double.NEGATIVE_INFINITY;
        double lateMs = Math.max(mono, wall);
        if (!(lateMs > gap)) return;
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("kind", JsonNode.str("late")));
        fields.add(JsonNode.member("timer", JsonNode.str(timer)));
        fields.add(JsonNode.member("lateMs", JsonNode.num(Math.round(lateMs))));
        fields.add(JsonNode.member("inSeam", JsonNode.str(inSilentSeam(st) ? "y" : "n")));
        fields.add(JsonNode.member("reason", JsonNode.str(reason.token)));
        fields.add(JsonNode.member("clock", JsonNode.str(mono > gap ? "mono" : "wall")));
        seams.output.diag(new EngineCommand.DiagEntry("grace", fields));
    }

    /** The seam beat: a beat is running, or its landed load waits out the beat's remainder. */
    public static boolean inSeamBeat(EngineState st) {
        return st.inSeamGap() || st.gapParkedToken != null;
    }

    /**
     * Between an out-point and the next item's audible start (the Swift {@code inSilentSeam}, NE-46):
     * the seam beat, or a grace span that is a seam's ({@code seam}, {@code prepare-miss}, or the
     * handover after a spoken line).
     */
    public static boolean inSilentSeam(EngineState st) {
        if (inSeamBeat(st)) return true;
        EngineCommand.GraceReason grace = st.grace;
        return grace == EngineCommand.GraceReason.SEAM || grace == EngineCommand.GraceReason.PREPARE_MISS
                || grace == EngineCommand.GraceReason.NARRATION_HANDOVER;
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
        EngineState st = core.state();
        return new Surface(availability, view, st.buffering, seq, st.rate, view != null && inSeamBeat(st));
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

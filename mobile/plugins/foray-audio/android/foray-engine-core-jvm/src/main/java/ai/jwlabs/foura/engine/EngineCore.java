package ai.jwlabs.foura.engine;

import ai.jwlabs.foura.engine.EngineCommand.AdvanceEntry;
import ai.jwlabs.foura.engine.EngineCommand.DiagEntry;
import ai.jwlabs.foura.engine.EngineCommand.GraceOutcome;
import ai.jwlabs.foura.engine.EngineCommand.GraceReason;
import ai.jwlabs.foura.engine.EngineCommand.InterludeCommand;
import ai.jwlabs.foura.engine.EngineCommand.NarrationCommand;
import ai.jwlabs.foura.engine.EngineCommand.PendingEvent;
import ai.jwlabs.foura.engine.EngineContract.Refusal;
import ai.jwlabs.foura.engine.EngineInput.InterludeEvent;
import ai.jwlabs.foura.engine.EngineInput.LifecycleEvent;
import ai.jwlabs.foura.engine.EngineInput.NarrationResumeAnswer;
import ai.jwlabs.foura.engine.EngineInput.NarratorEvent;
import ai.jwlabs.foura.engine.EngineInput.QueueInput;
import ai.jwlabs.foura.engine.EngineInput.RemotePress;
import ai.jwlabs.foura.engine.EngineInput.RouteChange;
import ai.jwlabs.foura.engine.EngineInput.SessionEvent;
import ai.jwlabs.foura.engine.EngineInput.SessionResult;
import ai.jwlabs.foura.engine.EngineState.DeckPrepareReport;
import ai.jwlabs.foura.engine.EngineState.DeferredIntent;
import ai.jwlabs.foura.engine.EngineState.PendingActivation;
import ai.jwlabs.foura.engine.EngineState.PendingLoad;
import ai.jwlabs.foura.engine.EngineState.SpokenLine;
import ai.jwlabs.foura.engine.Vocabulary.Source;
import ai.jwlabs.foura.engine.Vocabulary.StopCause;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * THE ENGINE'S FUNCTIONAL CORE (card A-24 for episodes, A-40 for Forays;
 * docs/native-engine-plan.md §4.2): {@code handle(input, now) -> [EngineCommand]}, pure, on one
 * owned state. The JVM twin of {@code EngineCore} in ForayEngineCore
 * (Engine/EngineCore.swift, NE-14s / NE-30s / NE-31s), and like it the port of
 * {@code PlayerQueueManager} (player/queue-manager.js) around the reducer A-23 brought to parity,
 * with the three things the web manager does not own and the native engine does: the audio
 * session ({@link SessionPolicy}), grace spans, and the deck as a request and a response instead
 * of a promise. The {@code manager-episode}, {@code manager-foray} and {@code prepare} fixtures
 * the JS records are its contract: the same steps, driven through this core by the JVM scenario
 * driver, must produce the same op log.
 *
 * <p>THE FORAY TAPE (A-40), behind {@link EngineConfig#forayTapeEnabled}, exactly as the Swift
 * core carries it: {@code playForay} with its structural check (J-4) and a resume point on the
 * Foray clock; ADR-0007's load-time ladder ({@link SeekPolicy#segmentLoadGate}) when a segment's
 * copy reports its duration; the seam beat ({@link SeamGap}), stamped at the out-point as an
 * ABSOLUTE deadline so the next load happens inside it, and cut by every transport action; the
 * standby deck's {@code prepare}; the Foray transport (previous by the Foray clock, a scrub and a
 * nudge on it); the packed {@code seam} row; and the {@code cp_foray} cadence. The narrating
 * overlay (a spoken line through the synthesiser, rendered bridges on the deck, the §14 fallback
 * to the script) and the jingle ({@link Interlude}) are the same core's rules, ported with it; the
 * host's synthesiser and jingle player are A-41's, and until then the host answers a spoken line
 * as a bridge with no synthesiser does (the JS {@code _speakNarration} throwing). With the tape
 * OFF every one of those paths is a no-op or unreachable, and the core is A-24's episode engine
 * exactly (the {@code manager-episode} family runs so).
 *
 * <p>WHY IT IS SYNCHRONOUS WHERE THE JS AWAITS. An effect that has to wait (a load) is a
 * command now and an input later ({@code ready(token)}), and everything else in a turn
 * happens in order, with nothing interleaved.
 *
 * <p>THE AUDIBLE-START INVARIANT (plan §4.4) is structural: every play-ish intent goes
 * through {@code begin}, which asks {@link SessionPolicy}; an intent that needs the
 * session emits {@code sessionActivate} and PARKS until the host feeds the answer back in
 * the same turn, so a failed activation ends in {@code commandFailed} with nothing
 * audible. {@code startPlayback} refuses outright without an active session, and a spoken line
 * and a jingle are refused the same way, as the backstop the {@code session-invariant} rule checks
 * every scenario turn against.
 *
 * <p>A relinquished or torn-down core is terminal: {@link #handle} returns nothing.
 *
 * <p>NOT THREAD-SAFE, BY DESIGN: the host feeds it on one thread, as iOS feeds it on main.
 */
public final class EngineCore {
    /** Plan §4.3: an uncommanded pause within this long of a route going away (either order) is the route's. */
    public static final double ROUTE_ATTRIBUTION_MS = 500;
    /** {@code REMOTE_DUPLICATE_WINDOW_MS}: a second press of the same command inside it is recorded as {@code dupCandidate}. */
    public static final double REMOTE_DUPLICATE_WINDOW_MS = 500;
    /** The {@code pendingEvents} log is bounded (plan §5.5): a page that never attaches must not grow it without limit. */
    public static final int PENDING_EVENTS_CAP = 512;
    /** Walked hops the page has not acked; the chain the page sends is K = 8 long. */
    public static final int ADVANCE_LOG_CAP = 64;
    /**
     * P-14, the stall display (plan §4.3; #866), the Swift {@code EngineCore.bufferingWhileWaiting}
     * (NE-38): the surface shows {@code buffering} from the moment the deck reports waiting (a
     * {@code deck kind=time-control status=waiting reason=} row) until it reports playing again,
     * with no debounce. PROVISIONAL (card A-60): on Android the session derives its speed from
     * the facade ({@code EnginePlayer}), which publishes the listening speed while playing and 0
     * only while buffering, so iOS's rate-0 latch cannot recur as such. Settled by the
     * {@code time-control} rows (NE-38e verdict {@code rate-latch}, A-68); false would show a
     * stall as playing.
     */
    public static final boolean BUFFERING_WHILE_WAITING = true; // MEASURE: verdict=rate-latch (NE-38e). Rows: deck kind=time-control status=waiting reason=.
    /** DiagGate's {@code tokenMax}: the longest free token a row carries as itself. */
    static final int DIAG_TOKEN_MAX = 64;

    private final EngineState state;
    private final EngineConfig config;

    // The turn in progress. Set at the top of `handle` and read only inside it.
    private List<EngineCommand> out = new ArrayList<>();
    private EngineNow now = new EngineNow(0, 0, DeckReading.idle());
    /**
     * The deck as the turn has left it: the host's reading, then updated by every deck
     * command this turn emits (a load resets the playhead, a pause silences), exactly as the
     * JS reads its fake element back after an effect ran.
     */
    private DeckReading deck = DeckReading.idle();
    /** A load, play, pause or unload was commanded this turn. */
    private boolean deckMovedThisTurn = false;
    /** {@code stop({persist: false})} is data deletion: its reducer save is skipped. */
    private boolean suppressSave = false;
    /** {@code _narrationStopping} (L-05): the pause a stop's reducer emits must not pause a synthesiser the stop then stops. */
    private boolean narrationStopping = false;

    public EngineCore(EngineConfig config, Map<String, ResumeRules.StoredPosition> positions) {
        this.config = Objects.requireNonNull(config, "config");
        state = new EngineState();
        state.holdPolicy = config.holdPolicy();
        state.rate = PlaybackRate.normalize(config.rate());
        state.positions = new HashMap<>(positions);
        state.interludeEnabled = config.interludeEnabled();
        state.voiceId = voice(config.voiceId());
    }

    public EngineCore(EngineConfig config) {
        this(config, Collections.<String, ResumeRules.StoredPosition>emptyMap());
    }

    /** The core's state, for READING only (see {@link EngineState}). */
    public EngineState state() {
        return state;
    }

    public EngineConfig config() {
        return config;
    }

    /** {@code typeof id === "string" && id ? id : null}. */
    static String voice(String id) {
        return id == null || id.isEmpty() ? null : id;
    }

    /**
     * What a cold boot rebuilt from the engine's private restore record (card A-27, the JVM
     * twin of the Swift {@code EngineCore.ColdRestore}, NE-24; plan §4.5): the core, and the
     * queue and index the host hands it as {@code lifecycle(coldLaunch(autoplay: false))},
     * which paints the session paused and activates nothing (S-3).
     */
    public record ColdRestore(EngineCore core, List<EngineItem> queue, int index) {
        public ColdRestore {
            Objects.requireNonNull(core, "core");
            queue = Collections.unmodifiableList(new ArrayList<>(queue));
        }
    }

    /**
     * A core rebuilt from a restore record, or null for a record there is nothing to play
     * from: {@code relinquished} (the legacy lane owns playback, plan §4.6), {@code foray}
     * (as on iOS: a cold boot restores an episode, and a Foray is resumed from its
     * {@code cp_foray} row by the page), an empty queue, an index outside it, or an item this
     * build cannot read (no id).
     *
     * <p>What the record carries and a core cannot learn from an input comes back here, as
     * the Swift {@code restoring} brings it back: the listener's speed, where the current item
     * was (as the stored position a cold start resumes from, through {@link ResumeRules}), and
     * the walked hops and pending events the page has not drained yet, with their sequence
     * numbers. The queue and index are NOT set here: they arrive through the one door, as
     * {@code coldLaunch}, so the rows and the surface follow.
     */
    public static ColdRestore restoring(RestoreRecord record, EngineConfig config) {
        if (record == null || record.mode() != RestoreRecord.Mode.EPISODE || record.queue().isEmpty()) return null;
        if (record.index() < 0 || record.index() >= record.queue().size()) return null;
        List<EngineItem> items = new ArrayList<>();
        for (JsonNode node : record.queue()) {
            EngineItem item = EngineItem.of(node);
            if (item == null) return null;
            items.add(item);
        }
        EngineItem current = items.get(record.index());
        Map<String, ResumeRules.StoredPosition> positions = new HashMap<>();
        if (record.offsetSec() > 0) {
            positions.put(current.id, new ResumeRules.StoredPosition(record.offsetSec(), current.durationSec));
        }
        EngineCore core = new EngineCore(config.withRate(record.rate()), positions);
        List<PendingEvent> events = new ArrayList<>();
        for (JsonNode node : record.pendingEvents()) {
            PendingEvent event = PendingEvent.restored(node);
            if (event != null) events.add(event);
        }
        int lastEvent = 0;
        for (PendingEvent event : events) lastEvent = Math.max(lastEvent, event.seq());
        core.state.pendingEvents = new ArrayList<>(events.subList(Math.max(0, events.size() - PENDING_EVENTS_CAP), events.size()));
        core.state.lastEventSeq = lastEvent;
        List<AdvanceEntry> advances = new ArrayList<>();
        for (JsonNode node : record.advanceLog()) {
            AdvanceEntry entry = AdvanceEntry.restored(node);
            if (entry != null) advances.add(entry);
        }
        int lastAdvance = 0;
        for (AdvanceEntry entry : advances) lastAdvance = Math.max(lastAdvance, entry.seq());
        core.state.advanceLog = new ArrayList<>(advances.subList(Math.max(0, advances.size() - ADVANCE_LOG_CAP), advances.size()));
        core.state.lastAdvanceSeq = lastAdvance;
        String voiceId = voice(record.voiceId());
        if (voiceId != null) core.state.voiceId = voiceId;
        return new ColdRestore(core, items, record.index());
    }

    /**
     * {@code canNext} (plan §5.5): the queue has a next item, or the continuation chain is
     * non-empty, REGARDLESS of {@code autoAdvance}. A Foray never chains.
     */
    public boolean canNext() {
        return nextItem(cursor(), true) != null || (state.forayId == null && !state.chain.isEmpty());
    }

    /** Previous restarts the item in place, so it exists whenever one does. */
    public boolean canPrevious() {
        return state.currentItem() != null;
    }

    /** {@code seamGapRemainingMs}: what is left of the seam beat at {@code monoMs}, 0 when no beat is running. */
    public double seamGapRemainingMs(double monoMs) {
        Double until = state.gapUntilMono;
        return until == null ? 0 : Math.max(0, until - monoMs);
    }

    /**
     * {@code narrationElapsedSec}: the spoken line's wall-time clock at {@code monoMs}, null while
     * the playhead is not a spoken line.
     */
    public Double narrationElapsedSec(double monoMs) {
        SpokenLine line = state.narration;
        return line == null ? null : line.elapsedSec(monoMs);
    }

    /**
     * The Snapshot v1 fields (plan §5.3) that decide which remote commands work, fed to
     * {@link MediaMapping#commandAvailability}. {@code mode} is {@code none} when nothing is
     * current or the listener closed the player; a Foray reads as {@code foray}.
     */
    public MediaMapping.CommandSnapshot commandSnapshot() {
        MediaMapping.CommandSnapshot.Mode mode;
        if (state.closed || state.currentItem() == null) {
            mode = MediaMapping.CommandSnapshot.Mode.UNLOADED;
        } else if (state.forayId != null) {
            mode = MediaMapping.CommandSnapshot.Mode.FORAY;
        } else {
            mode = MediaMapping.CommandSnapshot.Mode.EPISODE;
        }
        return new MediaMapping.CommandSnapshot(mode, state.stateType().equals("ended"), canNext(), canPrevious(),
                state.autoAdvance);
    }

    /** {@link #mediaView(DeckReading, Double)} with no clock: a spoken line's playhead is then unknown. */
    public MediaMapping.View mediaView(DeckReading reading) {
        return mediaView(reading, null);
    }

    /**
     * {@code mediaSessionView}'s input for the current item, as the page's
     * {@code episodeMediaView} gathers it (player/client.js), or null when there is nothing
     * to show. The playhead and duration are the deck's while it holds this item, else the
     * position the next play will start from; {@code playing} is the transport running, and
     * a load in flight is {@code buffering}. A Foray is described on the FORAY's clock
     * ({@link #forayMediaView}); {@code monoMs} is what a spoken line's playhead is read at.
     */
    public MediaMapping.View mediaView(DeckReading reading, Double monoMs) {
        EngineItem item = state.currentItem();
        if (state.closed || item == null) return null;
        if (state.forayId != null) return forayMediaView(item, reading, monoMs);
        boolean loaded = item.id.equals(state.loadedId);
        ResumeRules.StoredPosition stored = state.positions.get(item.id);
        Double position = loaded ? reading.positionSec : null;
        if (position == null) position = state.pendingStartSec;
        if (position == null && stored != null) position = stored.seconds();
        if (position == null) position = item.startSec;
        if (position == null) position = 0.0;
        Double duration = loaded ? reading.durationSec : null;
        if (duration == null) duration = item.durationSec;
        if (duration == null && stored != null) duration = stored.duration();
        boolean loading = state.player instanceof PlayerQueueState.LoadingItem
                || state.player instanceof PlayerQueueState.Transitioning;
        MediaMapping.View view = new MediaMapping.View();
        view.item = mediaItem(item);
        view.showArtworkUrl = string(item.node.get("artwork_url"));
        view.durationSec = duration;
        view.positionSec = position;
        view.playbackRate = state.rate;
        view.buffering = state.buffering || loading;
        view.playing = state.isRunning();
        view.inSeamGap = state.inSeamGap();
        view.ended = state.stateType().equals("ended");
        view.foray = false;
        return view;
    }

    /**
     * client.js {@code mediaViewFields}'s FORAY branch (the Swift {@code forayMediaView},
     * NE-37c): the item and the one after it (a line's "Up next:"), the Foray's title and "clip n
     * of N"; the FORAY's clock (its runtime as the duration, the playhead on it); and
     * {@code buffering} as the deck's stall latch plus a clip load in flight, and a bridge only
     * while it is still loading.
     */
    MediaMapping.View forayMediaView(EngineItem item, DeckReading reading, Double monoMs) {
        int index = Math.max(0, state.currentIndex);
        EngineItem next = index + 1 < state.queue.size() ? state.queue.get(index + 1) : null;
        List<ForayItem> items = forayItems();
        List<Double> starts = ForayClock.segmentStarts(items);
        SpokenLine line = state.narration;
        boolean speaking = line != null && line.itemId.equals(item.id) && item.id.equals(state.loadedId);
        Double playhead;
        if (speaking) {
            playhead = monoMs == null ? null : line.elapsedSec(monoMs);
        } else if (item.id.equals(state.loadedId)) {
            playhead = reading.positionSec;
        } else if (state.pendingLoad != null && state.pendingLoad.itemId().equals(item.id)) {
            playhead = state.pendingLoad.startSec();
        } else {
            playhead = null;
        }
        double position;
        if (playhead != null && Double.isFinite(playhead)) {
            position = ForayClock.forayElapsed(items, (double) index, playhead);
        } else {
            position = index < starts.size() ? starts.get(index) : 0;
        }
        boolean loading;
        if (state.player instanceof PlayerQueueState.LoadingItem) {
            loading = true;
        } else if (state.player instanceof PlayerQueueState.Transitioning) {
            loading = state.pendingLoad != null;
        } else {
            loading = false;
        }
        MediaMapping.View view = new MediaMapping.View();
        view.item = mediaItem(item);
        view.nextItem = next == null ? null : mediaItem(next);
        view.forayTitle = state.forayTitle != null ? state.forayTitle : "";
        view.index = (double) index;
        view.total = (double) state.queue.size();
        view.showArtworkUrl = string(item.node.get("artwork_url"));
        view.durationSec = ForayClock.forayRuntimeSec(items);
        view.positionSec = position;
        // THE RATE THE PLAYHEAD REALLY MOVES AT: a SPOKEN line runs at 1x on the wall clock.
        view.playbackRate = speaking ? 1.0 : state.rate;
        view.buffering = state.buffering || loading;
        view.playing = state.isRunning();
        view.inSeamGap = state.inSeamGap();
        view.ended = state.stateType().equals("ended");
        view.foray = true;
        return view;
    }

    private static MediaMapping.Item mediaItem(EngineItem item) {
        return new MediaMapping.Item(string(item.node.get("kind")), string(item.node.get("title")), string(item.node.get("show")));
    }

    // ---- the one door

    public List<EngineCommand> handle(EngineInput input, EngineNow at) {
        if (state.session == SessionPolicy.Phase.RELINQUISHED || state.tornDown) return Collections.emptyList();
        now = Objects.requireNonNull(at, "now");
        deck = at.deck().copy();
        out = new ArrayList<>();
        deckMovedThisTurn = false;
        if (input instanceof EngineInput.SessionAnswer answer) {
            onSessionResult(answer.result());
        } else {
            PendingActivation parked = state.pendingActivation;
            if (parked != null) {
                // The host feeds the answer before anything else (plan §4.2); an intent still
                // parked here was never answered, and a play nobody confirmed must not start
                // later on a stranger's turn.
                state.pendingActivation = null;
                diag("session", m("kind", str("activation-abandoned")), m("requestId", num(parked.requestId())));
            }
            route(input);
        }
        if (state.session != SessionPolicy.Phase.RELINQUISHED && !state.tornDown) settleTurn();
        List<EngineCommand> result = Collections.unmodifiableList(out);
        out = new ArrayList<>();
        return result;
    }

    private void route(EngineInput input) {
        switch (input) {
            case EngineInput.Command c -> onCommand(c.command(), c.source());
            case EngineInput.Queue q -> onQueue(q.input());
            case EngineInput.Remote r -> onRemote(r.press());
            case EngineInput.Deck d -> onDeck(d.event());
            case EngineInput.SessionAnswer a -> {}
            case EngineInput.Session s -> onSession(s.event());
            case EngineInput.Lifecycle l -> onLifecycle(l.event());
            case EngineInput.Timer t -> onTimer(t.timer());
            case EngineInput.Narrator n -> onNarrator(n.event());
            case EngineInput.Interlude i -> onInterlude(i.event());
        }
    }

    // ---- page commands

    private void onCommand(EngineContract.Command command, Source source) {
        switch (command) {
            case EngineContract.Command.PlayEpisode c -> {
                EngineItem episode = EngineItem.of(c.item());
                if (episode == null) {
                    refuse(Refusal.NOT_LOADED);
                    return;
                }
                // LEAVING IS A FLUSH (audit round 2, player-3): the outgoing episode's playhead
                // is written before the queue stops naming it.
                flushPosition();
                state.queue = new ArrayList<>(Collections.singletonList(episode));
                state.currentIndex = -1;
                state.forayId = null;
                state.forayTitle = null;
                state.lastEpisodeRow = c.lastEpisodeRow();
                state.lastEpisodeRowWritten = false;
                state.startingHop = null;
                playIndex(0, c.startSec(), source);
            }
            case EngineContract.Command.PlayForay c -> {
                // Off (M1) the page relinquishes before a Foray; the bridge refuses one while
                // `foray` is not advertised, and a core with the tape off says the same.
                if (!config.forayTapeEnabled()) {
                    refuse(Refusal.CAPABILITY_OFF);
                    return;
                }
                playForay(c, source);
            }
            // The Developer engine setting is the bridge's (it works in every lane); nothing here.
            case EngineContract.Command.SetModeOverride c -> {}
            case EngineContract.Command.SetContinuation c -> {
                state.planSeq = c.planSeq();
                state.autoAdvance = c.autoAdvance();
                state.chain = new ArrayList<>(c.chain());
                state.previousHop = c.previous();
            }
            case EngineContract.Command.Play c -> play(source);
            case EngineContract.Command.Pause c -> pause(source);
            case EngineContract.Command.Toggle c -> toggle(source);
            case EngineContract.Command.Next c -> next(source);
            case EngineContract.Command.Previous c -> previous(source);
            case EngineContract.Command.SeekBy c -> nudge(c.deltaSec(), source);
            case EngineContract.Command.SeekTo c -> scrub(c.sec(), source);
            case EngineContract.Command.Jump c -> playIndex(c.index(), null, source);
            case EngineContract.Command.Stop c -> stop(c.persist(), source);
            case EngineContract.Command.SetRate c -> setRate(c.rate());
            case EngineContract.Command.SetVoice c -> {
                // `setVoice(id)`: the NEXT line speaks in it, and a cold narration too.
                state.voiceId = voice(c.voiceId());
                diag("narration", m("kind", str("voice")), m("chosen", JsonNode.bool(state.voiceId != null)));
                writeRestore();
            }
            case EngineContract.Command.SetInterludeEnabled c -> {
                // A preference about the rest of the hour, not a transport action.
                if (c.on() != state.interludeEnabled) {
                    diag("interlude", m("kind", str("enabled")), m("on", JsonNode.bool(c.on())));
                }
                state.interludeEnabled = c.on();
            }
            case EngineContract.Command.SetPageVisible c -> state.pageVisible = c.visible();
            case EngineContract.Command.AckAdvances c -> {
                state.advanceLog.removeIf(e -> e.seq() <= c.upToSeq());
                writeRestore();
            }
            case EngineContract.Command.AckEvents c -> {
                state.pendingEvents.removeIf(e -> e.seq() <= c.upToSeq());
                writeRestore();
            }
            // Painting a restored bar is the page's; nothing audible happens.
            case EngineContract.Command.RestoreBar c -> {}
            case EngineContract.Command.Purge c -> stop(false, source);
            case EngineContract.Command.Relinquish c -> relinquish(c.cap(), source);
            case EngineContract.Command.Audition c -> {
                // OQ-5: refused while running; otherwise the engine's own synthesiser speaks it
                // after a SessionPolicy activation.
                if (state.isRunning() || audibleNow()) {
                    refuse(Refusal.ENGINE_BUSY);
                    return;
                }
                begin(new DeferredIntent.Audition(c.text(), c.voiceId()), Source.AUDITION);
            }
            case EngineContract.Command.SetHoldPolicy c -> state.holdPolicy = c.policy();
            // The host's (the session probe).
            case EngineContract.Command.ProbeSession c -> {}
            case EngineContract.Command.SimulateTermination c -> {
                // Developer only: the record a cold boot restores from is written NOW.
                if (state.queue.isEmpty()) {
                    refuse(Refusal.NOT_LOADED);
                    return;
                }
                writeRestore();
                EngineItem current = state.currentItem();
                diag("restore", m("kind", str("sim-termination-armed")), m("item", current == null ? JsonNode.NULL : str(current.id)));
            }
        }
    }

    private void onQueue(QueueInput input) {
        switch (input) {
            case QueueInput.Load q -> {
                // `loadQueue(items)`: the queue is replaced, nothing loads.
                state.queue = new ArrayList<>(q.items());
                state.currentIndex = -1;
                state.forayId = null;
                state.closed = false;
            }
            case QueueInput.LoadForay q -> {
                // `setQueueFromForay(foray, opts)` with the page's build: the same replacement,
                // plus the options the load-time ladder reads.
                state.queue = new ArrayList<>(q.items());
                state.currentIndex = -1;
                state.forayId = null;
                state.closed = false;
                state.forayIsLocalFile = q.isLocalFile();
                state.forayAllowAdPad = q.allowAdPad();
            }
            case QueueInput.PlayIndex q -> playIndex(q.index(), q.startSec(), q.source());
            case QueueInput.SetRate q -> setRate(q.rate());
            case QueueInput.Seek q -> {
                // The manager's own `seek`: straight to the reducer, which holds it for a load in
                // flight and refuses it with nothing loaded. A transport action, so it cuts a
                // running beat (the parked load starts at the new second).
                cutSeamGap("seek");
                dispatch(new PlayerEvent.Seek(q.sec(), q.precise()));
                releaseSeamGap();
            }
        }
    }

    // ---- transport

    private void playIndex(int index, Double startSec, Source source) {
        if (index < 0 || index >= state.queue.size()) {
            refuse(Refusal.NOT_LOADED);
            return;
        }
        cutSeamGap("play");
        begin(new DeferredIntent.PlayIndex(index, startSec), source);
        releaseSeamGap();
    }

    /**
     * {@code resume()}: play the current item. While the transport already runs the reducer
     * answers (the same item loading or playing is a no-op) and no session or grace is
     * involved. A FINISHED Foray starts over ({@code endedPlayAction}).
     */
    private void play(Source source) {
        EngineItem item = state.currentItem();
        if (item == null) {
            refuse(Refusal.NOT_LOADED);
            return;
        }
        if (TransportPolicy.endedPlayAction(state.forayId != null, state.stateType()) == TransportPolicy.Toggle.START_OVER) {
            playIndex(0, null, source);
            return;
        }
        cutSeamGap("resume");
        if (state.isRunning()) {
            dispatch(new PlayerEvent.Play(item.ref()));
        } else {
            begin(DeferredIntent.RESUME, source);
        }
        releaseSeamGap();
    }

    /**
     * {@code pause()}. THE POSTCONDITION IS SILENCE (#689 report 3): the reducer's
     * {@code interruptionBegan} is idempotent and emits no pause from {@code interrupted}, so
     * a deck audible while the machine says paused is paused here, by the deck's own word.
     */
    private void pause(Source source) {
        cutSeamGap("pause");
        state.pausedByListener = true;
        stopRow(StopCause.PAUSE, source);
        dispatch(PlayerEvent.INTERRUPTION_BEGAN);
        if (audibleNow()) {
            diag("pause", m("kind", str("forced")), m("why", str("the deck was audible while the machine said paused")));
            deckCommand(DeckCommand.PAUSE);
        }
        applySession(SessionPolicy.transition(state.session, new SessionPolicy.Input.Simple(SessionPolicy.InputKind.PAUSE),
                state.holdPolicy));
        armHoldTimerIfPaused();
        releaseSeamGap();
        // A pause is a moment the resume point becomes the thing read back next time.
        persistForay(true);
    }

    /** TOGGLE FROM NATIVE TRUTH: {@code running} is the belief OR the deck's own word (#689). */
    private void toggle(Source source) {
        boolean running = state.isRunning() || audibleNow();
        TransportPolicy.Toggle decision = TransportPolicy.resolveToggle(!running, false, state.forayId != null, state.stateType(),
                running, state.currentItem() != null, (double) state.queue.size());
        switch (decision) {
            case PAUSE -> pause(source);
            case RESUME, LOAD, PLAY_RESTORED -> play(source);
            case START_OVER -> playIndex(0, null, source);
            case NONE -> {}
        }
    }

    /** Next: the queue's next item (bridges stepped over), else the first continuation hop. */
    private void next(Source source) {
        if (nextItem(cursor(), true) != null) {
            cutSeamGap("skipToNext");
            begin(DeferredIntent.SKIP_NEXT, source);
            releaseSeamGap();
            return;
        }
        // A Foray is ONE queue: its last item's next is nothing, never a hop.
        if (state.forayId == null && !state.chain.isEmpty()) {
            begin(new DeferredIntent.WalkHop(state.chain.get(0)), source);
            return;
        }
        refuse(Refusal.NO_NEXT);
    }

    /**
     * Previous RESTARTS the item in place ({@code skipToPrevious}); walking back to
     * {@code previousHop} is the page's call and arrives as a playEpisode. In a Foray the Foray
     * clock decides ({@code previousAction}): inside the first {@code RESTART_WINDOW_SEC} of a
     * clip it goes to the one before, otherwise it restarts this one.
     */
    private void previous(Source source) {
        EngineItem item = state.currentItem();
        if (item == null) {
            refuse(Refusal.NO_PREVIOUS);
            return;
        }
        if (forayTransport()) {
            int index = state.currentIndex;
            List<Double> starts = ForayClock.segmentStarts(forayItems());
            double start = index >= 0 && index < starts.size() ? starts.get(index) : 0;
            if (TransportPolicy.previousAction(index, forayPositionSec(item), start) == TransportPolicy.Previous.ITEM_BEFORE) {
                playIndex(index - 1, null, source);
                return;
            }
        }
        cutSeamGap("skipToPrevious");
        begin(DeferredIntent.SKIP_PREVIOUS, source);
        releaseSeamGap();
    }

    /**
     * A nudge ({@code seekBy}, a lock-screen or car skip) on the clock the listener sees: the
     * Foray's in a Foray ({@link #forayNudge}), else the episode's ({@link #seekBy}).
     */
    private void nudge(double deltaSec, Source source) {
        if (forayTransport()) {
            forayNudge(deltaSec, source);
        } else {
            seekBy(deltaSec, source);
        }
    }

    /**
     * A scrub ({@code seekTo}, a lock-screen or car {@code changePlaybackPosition}) on the clock
     * the listener sees. In a Foray the surface publishes the FORAY's clock, so a scrub to 20:00
     * of a 50-minute Foray is 20:00 of the Foray ({@link #forayScrub}), never second 1200 of the
     * clip's source episode, which would seek past the clip's out-point into a stranger's audio
     * (A-42; found in A-40 and moot until Android advertised {@code foray}).
     */
    private void scrub(double sec, Source source) {
        if (forayTransport()) {
            forayScrub(sec, source);
        } else {
            seekTo(sec, source);
        }
    }

    /**
     * {@code seekTo} from the page or the lock screen: clamped the way the page clamps an
     * episode seek, then {@code seekAction}: with nothing loaded to seek in, the target is
     * WRITTEN DOWN as the next play's own start.
     */
    private void seekTo(double sec, Source source) {
        EngineItem item = state.currentItem();
        if (item == null) {
            refuse(Refusal.NOT_LOADED);
            return;
        }
        Double target = TransportPolicy.clampEpisodeTarget(sec, deck.durationSec != null ? deck.durationSec : item.durationSec);
        if (target == null) return;
        if (TransportPolicy.seekAction(false, state.stateType()) == TransportPolicy.Seek.PEND) {
            state.pendingStartSec = target;
            return;
        }
        cutSeamGap("seek");
        dispatch(new PlayerEvent.Seek(target, false));
        releaseSeamGap();
    }

    /**
     * A nudge steps from where the listener IS: the deck's playhead once it holds the item;
     * WHILE A LOAD OF IT IS IN FLIGHT, the second that load will land on (audit round 2,
     * p-impatient-1); otherwise the pended start.
     */
    private void seekBy(double deltaSec, Source source) {
        EngineItem item = state.currentItem();
        if (item == null) {
            refuse(Refusal.NOT_LOADED);
            return;
        }
        PendingLoad pending = state.pendingLoad;
        Double loading = !item.id.equals(state.loadedId) && pending != null && pending.itemId().equals(item.id)
                ? Double.valueOf(pending.startSec()) : null;
        Double position = item.id.equals(state.loadedId) ? deck.positionSec : null;
        if (position == null) position = loading;
        if (position == null) position = state.pendingStartSec;
        if (position == null) position = 0.0;
        Double target = TransportPolicy.skipTarget(false, position, deltaSec,
                deck.durationSec != null ? deck.durationSec : item.durationSec);
        if (target == null) return;
        seekTo(target, source);
    }

    /**
     * {@code stop()}: a close ({@code persist}) or a data deletion. The cause row, then the
     * reducer's save and pause, then the session is released WITH notify.
     */
    private void stop(boolean persist, Source source) {
        cutSeamGap("stop");
        try {
            state.pausedByListener = true;
            stopRow(persist ? StopCause.CLOSE : StopCause.DATA_DELETION, source);
            // CLOSING IS A FLUSH (audit round 2, player-3): the reducer's stop saves nothing, so
            // the playhead is written first. A data deletion writes nothing.
            if (persist) flushPosition();
            state.closed = true;
            suppressSave = !persist;
            // L-05: "Stopping a Foray must also stop speech", in ONE call: the reducer's pause is
            // held off so a pause never precedes the stop.
            boolean wasSpeaking = state.narration != null;
            narrationStopping = wasSpeaking;
            dispatch(PlayerEvent.STOP);
            narrationStopping = false;
            suppressSave = false;
            if (wasSpeaking) stopNarration();
            applySession(SessionPolicy.transition(state.session,
                    new SessionPolicy.Input.Simple(persist ? SessionPolicy.InputKind.CLOSE : SessionPolicy.InputKind.DATA_DELETION),
                    state.holdPolicy));
            if (!persist) {
                state.positions.clear();
                state.eventMarks.clear();
                state.pendingEvents.clear();
                state.advanceLog.clear();
                state.lastEpisodeRow = null;
                state.pendingStartSec = null;
                out.add(new EngineCommand.WriteRestore(null));
            }
        } finally {
            releaseSeamGap();
        }
    }

    /**
     * {@code setRate(rate)}: snapped onto the ladder, remembered, and handed to the deck at
     * once (it holds it and re-applies it on every play). A snapped value says so. A SPOKEN
     * LINE IS NOT SPED UP (corner case #18): a tap while one is audible is kept and reaches the
     * deck when the line ends ({@code restoreRate}); a RENDERED line follows the listener (D2).
     */
    private void setRate(Double requested) {
        PlaybackRate.Snap snap = PlaybackRate.snap(requested);
        if (snap.snapped()) {
            diag("rate", m("kind", str("snapped")), m("requested", Rows.finiteOrNull(requested)),
                    m("applied", num(snap.applied())));
        }
        state.rate = snap.applied();
        if (config.forayTapeEnabled() && state.narration != null && narrationIsAudible()) {
            state.pendingRate = snap.applied();
            diag("rate", m("kind", str("deferred")), m("applied", num(snap.applied())));
            return;
        }
        deckCommand(new DeckCommand.SetRate(snap.applied()));
    }

    /** {@code _narrationIsAudible()}: read from the item, since {@code transitioning} covers a bridge loading too. */
    private boolean narrationIsAudible() {
        EngineItem current = state.currentItem();
        return state.stateType().equals("transitioning") || (current != null && current.kind == PlayerItemKind.TTS);
    }

    /**
     * queue-manager.js {@code focusOf(state)} read through {@code _itemFor}: the queue item
     * the reducer's state is about, null when idle or ended.
     */
    private EngineItem focusItem() {
        QueueItemRef ref = switch (state.player) {
            case PlayerQueueState.Playing p -> p.item();
            case PlayerQueueState.Transitioning t -> t.to();
            case PlayerQueueState.Interrupted i -> i.item();
            case PlayerQueueState.LoadingItem l -> l.target();
            case PlayerQueueState.Idle i -> null;
            case PlayerQueueState.Ended e -> null;
        };
        return ref == null ? null : find(ref.id());
    }

    /**
     * The one-way relinquish (plan §4.6): stop WITH persistence, keep the session active with
     * no deactivate and no notify, end grace, cancel timers, write the
     * {@code {mode: "relinquished"}} record, and go terminal.
     */
    private void relinquish(EngineContract.RelinquishCap cap, Source source) {
        // Nothing parked may start audio after the engine gave the process back.
        cutSeamGap("relinquish");
        state.gapParkedToken = null;
        state.gapCut = false;
        stopRow(StopCause.RELINQUISH, source);
        if (state.isRunning()) {
            state.pausedByListener = true;
            dispatch(PlayerEvent.INTERRUPTION_BEGAN);
        } else {
            persistPosition();
        }
        if (audibleNow()) deckCommand(DeckCommand.PAUSE);
        // The synthesiser outlives nothing the engine gave back.
        if (state.narration != null) stopNarration();
        deckCommand(DeckCommand.UNLOAD);
        if (state.grace != null) endGrace(GraceOutcome.RELINQUISHED);
        if (state.positionTimerArmed) {
            out.add(new EngineCommand.TimerCancel(EngineTimer.POSITION_TICK));
            state.positionTimerArmed = false;
        }
        cancelHoldTimer();
        state.session = SessionPolicy.transition(state.session, new SessionPolicy.Input.Simple(SessionPolicy.InputKind.RELINQUISH),
                state.holdPolicy).phase();
        state.pendingActivation = null;
        state.pendingLoad = null;
        String stamp = Rows.timestamp(now.wallMs());
        if (stamp != null) out.add(new EngineCommand.WriteRestore(RestoreRecord.relinquished(stamp, config.build())));
        diag("mode", m("reason", str(Vocabulary.ModeReason.DOWNGRADE.token)), m("cap", str(cap.token)));
    }

    // ---- remote commands

    /**
     * A lock-screen, car or headset press. The {@code remote} row is written FIRST, before
     * any no-op return (D-4), with {@code dupCandidate} recorded and nothing dropped (T-8). A
     * remote stop is a pause (T-7). Its grace fields are filled in AFTER the press is handled
     * (NE-16g): the row keeps its place at the head of the turn, but {@code grace=y} has to
     * say whether THIS press is covered.
     */
    private void onRemote(RemotePress press) {
        boolean dup = false;
        if (state.lastRemote != null && state.lastRemote.command() == press.command()) {
            double gap = now.monoMs() - state.lastRemote.atMono();
            dup = gap >= 0 && gap < REMOTE_DUPLICATE_WINDOW_MS;
        }
        state.lastRemote = new EngineState.LastRemote(press.command(), now.monoMs());
        List<JsonNode.Member> fields = Arrays.asList(
                m("cmd", str(remoteToken(press.command()))),
                m("dupCandidate", str(dup ? "y" : "n")),
                m("route", press.routePort() == null ? JsonNode.NULL : str(press.routePort())),
                m("thread", str(press.onMain() ? "main" : "bg")),
                m("state", str(state.stateType())));
        int rowAt = out.size();
        out.add(new EngineCommand.Diag(new DiagEntry("remote", concat(fields, graceFields()))));
        try {
            MediaMapping.SeekSteps steps = MediaMapping.SeekSteps.DEFAULT;
            switch (press.command()) {
                case PLAY -> play(Source.REMOTE);
                case PAUSE -> pause(Source.REMOTE);
                case TOGGLE_PLAY_PAUSE -> toggle(Source.REMOTE);
                case NEXT_TRACK -> next(Source.REMOTE);
                case PREVIOUS_TRACK -> previous(Source.REMOTE);
                // A-42: a press is on the clock the surface PUBLISHED, which in a Foray is the
                // Foray's (forayMediaView), so it takes the page's own path: client.js's
                // forayMediaSurface steps with nudgeBy and scrubs with foraySeek.
                case SKIP_FORWARD -> nudge(press.value() != null ? press.value() : steps.forwardSec(), Source.REMOTE);
                case SKIP_BACKWARD -> nudge(-(press.value() != null ? press.value() : steps.backwardSec()), Source.REMOTE);
                case CHANGE_PLAYBACK_POSITION -> {
                    if (press.value() == null) {
                        refuse(Refusal.NOT_LOADED);
                    } else {
                        scrub(press.value(), Source.REMOTE);
                    }
                }
                case STOP -> {
                    switch (TransportPolicy.remoteStopAction(null)) {
                        case PAUSE -> pause(Source.REMOTE);
                        case CLOSE -> stop(true, Source.REMOTE);
                    }
                }
            }
        } finally {
            out.set(rowAt, new EngineCommand.Diag(new DiagEntry("remote", concat(fields, graceFields()))));
        }
    }

    /** The command's name as iOS's MPRemoteCommand set spells it (the Swift enum's raw values), for the row. */
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

    // ---- beginning a play: grace, the session, then the intent

    /**
     * Every intent that may start audio comes through here. Grace first (the span is silent
     * from this moment), then {@link SessionPolicy}: an intent that needs the session parks
     * behind {@code sessionActivate}.
     */
    private void begin(DeferredIntent intent, Source source) {
        // A play reopens a closed player; an audition is not a play of the queue.
        if (!(intent instanceof DeferredIntent.Audition)) state.closed = false;
        GraceReason reason = graceReason(intent, source);
        if (reason != null) beginGrace(reason);
        spanRow(intent);
        SessionPolicy.PlayVia via = switch (source) {
            case TAP -> SessionPolicy.PlayVia.TAP;
            case REMOTE, RESTORE -> SessionPolicy.PlayVia.REMOTE;
            case AUDITION -> SessionPolicy.PlayVia.AUDITION_TAP;
            case RECONCILE, SESSION, AUTOADVANCE, AUTORESUME -> SessionPolicy.PlayVia.AUTORESUME;
        };
        SessionPolicy.Transition transition = SessionPolicy.transition(state.session, new SessionPolicy.Input.UserPlay(via),
                state.holdPolicy);
        if (transition.actions().contains(SessionPolicy.Action.ACTIVATE)) {
            requestActivation(intent, source);
            return;
        }
        run(intent, source);
    }

    /**
     * Which grace span an intent opens, if any (plan §4.4): a remote play, a tap while
     * backgrounded, an interruption resume, a route resume, a cold play, and a continuation
     * hop loading in the background.
     */
    private GraceReason graceReason(DeferredIntent intent, Source source) {
        return switch (intent) {
            case DeferredIntent.InterruptionResume i -> GraceReason.INTERRUPTION_RESUME;
            case DeferredIntent.RouteResume i -> GraceReason.ROUTE_RESUME;
            case DeferredIntent.ColdPlay i -> GraceReason.COLD_PLAY;
            case DeferredIntent.Audition i -> null;
            case DeferredIntent.WalkHop i when source == Source.AUTOADVANCE -> state.backgrounded ? GraceReason.AUTO_ADVANCE : null;
            case DeferredIntent.PlayIndex i -> tapOrRemote(source);
            case DeferredIntent.Resume i -> tapOrRemote(source);
            case DeferredIntent.SkipNext i -> tapOrRemote(source);
            case DeferredIntent.SkipPrevious i -> tapOrRemote(source);
            case DeferredIntent.WalkHop i -> tapOrRemote(source);
        };
    }

    private GraceReason tapOrRemote(Source source) {
        if (source == Source.REMOTE) return GraceReason.REMOTE_PLAY;
        return state.backgrounded ? GraceReason.BACKGROUND_TAP : null;
    }

    /**
     * The {@code resume} and {@code cold-play} rows (NE-16g): written the moment the intent's
     * span opens, before the activation it may wait on, with {@code grace=}, its reason and
     * the background budget.
     */
    private void spanRow(DeferredIntent intent) {
        EngineItem current = state.currentItem();
        JsonNode item = current == null ? JsonNode.NULL : str(current.id);
        if (intent instanceof DeferredIntent.InterruptionResume) {
            diag("resume", concat(Arrays.asList(m("kind", str("interruption")), m("item", item)), graceFields()));
        } else if (intent instanceof DeferredIntent.RouteResume) {
            diag("resume", concat(Arrays.asList(m("kind", str("route")), m("item", item)), graceFields()));
        } else if (intent instanceof DeferredIntent.ColdPlay) {
            diag("cold-play", concat(Arrays.asList(m("item", item), m("index", num(state.currentIndex))), graceFields()));
        }
    }

    /** {@code grace=y|n}, the open span's reason, and the background time the host read for this input. */
    private List<JsonNode.Member> graceFields() {
        Double bg = now.bgRemainingMs();
        return Arrays.asList(
                m("grace", str(state.grace == null ? "n" : "y")),
                m("graceReason", state.grace == null ? JsonNode.NULL : str(state.grace.token)),
                m("bgRemainingMs", Rows.finiteOrNull(bg == null ? null : roundHalfAwayFromZero(bg))));
    }

    private void requestActivation(DeferredIntent intent, Source source) {
        state.lastRequestId += 1;
        state.pendingActivation = new PendingActivation(state.lastRequestId, intent, source);
        out.add(new EngineCommand.SessionActivate(state.lastRequestId));
    }

    /**
     * The activation's answer, in the same turn. Only then does the parked intent run; a
     * failure is {@code commandFailed(session-failed:<token>)} and nothing audible (an
     * interruption's resume stays paused).
     */
    private void onSessionResult(SessionResult result) {
        PendingActivation parked = state.pendingActivation;
        if (parked == null || parked.requestId() != result.requestId()) {
            diag("session", m("kind", str("result-unexpected")), m("requestId", num(result.requestId())));
            return;
        }
        state.pendingActivation = null;
        SessionPolicy.Transition transition = SessionPolicy.transition(state.session,
                new SessionPolicy.Input.SessionResult(result.ok(), result.error()), state.holdPolicy);
        state.session = transition.phase();
        diag("session", m("kind", str("activate")), m("ok", JsonNode.bool(result.ok())),
                m("activateMs", Rows.finiteOrNull(result.activateMs())),
                m("reason", transition.reason() == null ? JsonNode.NULL : str(transition.reason())));
        if (!result.ok()) {
            out.add(new EngineCommand.CommandFailed(
                    transition.reason() != null ? transition.reason() : SessionPolicy.sessionFailedReason(result.error())));
            if (parked.intent() instanceof DeferredIntent.InterruptionResume) {
                dispatch(new PlayerEvent.InterruptionEnded(false));
            }
            releaseSeamGap();
            return;
        }
        state.activatedInProcess = true;
        cancelHoldTimer();
        run(parked.intent(), parked.source());
        // A beat cut by the action that asked for this activation is released only now, after
        // that action issued its own load.
        releaseSeamGap();
    }

    /** The intent itself, once the session allows sound. */
    private void run(DeferredIntent intent, Source source) {
        switch (intent) {
            case DeferredIntent.PlayIndex p -> {
                if (p.index() < 0 || p.index() >= state.queue.size()) {
                    refuse(Refusal.NOT_LOADED);
                    return;
                }
                state.currentIndex = p.index();
                state.pausedByListener = false;
                state.pausedByRoute = false;
                // `Number.isFinite(at) && at >= 0 ? at : null`: the listener's own destination
                // rides on the LOAD, so nothing is audible from the wrong second.
                Double start = p.startSec();
                Double explicit = start != null && Rows.isFinite(start) && start >= 0 ? start : null;
                dispatch(new PlayerEvent.Play(state.queue.get(p.index()).ref()), LoadOffsets.explicitAt(explicit));
            }
            case DeferredIntent.Resume r -> {
                EngineItem item = state.currentItem();
                if (item == null) {
                    refuse(Refusal.NOT_LOADED);
                    return;
                }
                state.pausedByListener = false;
                state.pausedByRoute = false;
                Double explicit = state.pendingStartSec;
                state.pendingStartSec = null;
                dispatch(new PlayerEvent.Play(item.ref()), LoadOffsets.explicitAt(explicit));
            }
            case DeferredIntent.SkipNext s -> {
                Next next = nextItem(cursor(), true);
                if (next == null) {
                    refuse(Refusal.NO_NEXT);
                    return;
                }
                // currentIndex is NOT advanced here: the reducer's skip saves the outgoing
                // position first, against what is loaded. `load` moves it.
                state.targetIndex = next.index();
                dispatch(new PlayerEvent.SkipToNext(next.item().ref()));
            }
            case DeferredIntent.SkipPrevious s -> {
                // "Restart" must mean zero. From idle (a failed load) or ended the reducer has no
                // item in focus, so name the item this engine holds and it takes its fresh-play
                // branch (player-core-1).
                if (state.player instanceof PlayerQueueState.Idle || state.player instanceof PlayerQueueState.Ended) {
                    EngineItem held = state.currentItem();
                    if (held == null) return;
                    dispatch(new PlayerEvent.SkipToPrevious(held.ref()), LoadOffsets.forcedAt(0));
                } else {
                    dispatch(new PlayerEvent.SkipToPrevious(null), LoadOffsets.forcedAt(0));
                }
            }
            case DeferredIntent.InterruptionResume i -> dispatch(new PlayerEvent.InterruptionEnded(true), LoadOffsets.rewinding(true));
            case DeferredIntent.RouteResume r -> {
                EngineItem item = state.currentItem();
                if (item == null) return;
                state.pausedByRoute = false;
                dispatch(new PlayerEvent.Play(item.ref()));
            }
            case DeferredIntent.ColdPlay c -> {
                EngineItem item = state.currentItem();
                if (item == null) {
                    refuse(Refusal.NOT_LOADED);
                    return;
                }
                dispatch(new PlayerEvent.Play(item.ref()));
            }
            case DeferredIntent.WalkHop w -> walk(w.hop(), source);
            case DeferredIntent.Audition a -> out.add(new EngineCommand.Speak(a.text(), a.voiceId()));
        }
    }

    // ---- the reducer and its effects

    private void dispatch(PlayerEvent event) {
        dispatch(event, LoadOffsets.NONE);
    }

    private void dispatch(PlayerEvent event, LoadOffsets offsets) {
        PlayerQueueStateMachine.Transition t = PlayerQueueStateMachine.reduce(state.player, event);
        state.player = t.state();
        for (PlayerEffect effect : t.effects()) perform(effect, offsets);
    }

    /** Every effect has a case ({@code _perform}): a missed effect is a stuck player. */
    private void perform(PlayerEffect effect, LoadOffsets offsets) {
        switch (effect) {
            case PlayerEffect.LoadItem e -> load(e.item(), offsets);
            case PlayerEffect.StartPlayback e -> startPlayback();
            case PlayerEffect.PausePlayback e -> {
                // L-05: every pause surface arrives here, so a spoken line pauses its
                // SYNTHESISER, not a deck that is not playing it.
                if (state.narration != null) {
                    pauseNarration();
                } else {
                    deckCommand(DeckCommand.PAUSE);
                }
            }
            case PlayerEffect.SavePosition e -> {
                if (!suppressSave) persistPosition();
            }
            case PlayerEffect.SeekTo e -> deckCommand(new DeckCommand.Seek(e.seconds()));
            case PlayerEffect.SeekRejected e -> diag("seek", m("kind", str("rejected")), m("reason", str(e.reason())));
            case PlayerEffect.SetOutPoint e -> deckCommand(new DeckCommand.SetOutPoint(e.seconds()));
            case PlayerEffect.ResetRateForTTS e -> {
                // Founder ruling D2, 2026-09-28: a RENDERED line plays at the LISTENER's rate; a
                // SPOKEN line has no deck under it. DECIDED BY THE ITEM THIS EFFECT IS FOR, not
                // by the line now loaded.
                EngineItem target = focusItem();
                if (target != null) {
                    if (target.isSynthNarration()) return;
                } else if (state.narration != null) {
                    return;
                }
                deckCommand(new DeckCommand.SetRate(state.rate));
            }
            case PlayerEffect.RestoreRate e -> {
                if (state.narration != null) return;
                state.pendingRate = null;
                deckCommand(new DeckCommand.SetRate(state.rate));
            }
            case PlayerEffect.PlayTransitionTTS e -> {
                // With the Foray tape on a bridge plays: a RENDERED one on the deck, a SPOKEN one
                // through the synthesiser. With the tape off every bridge is stepped over the way
                // a bridge that failed to load is: a missing line never stalls the queue (#12).
                if (config.forayTapeEnabled()) {
                    playTransitionBridge();
                } else {
                    advancePastBridgeFailure();
                }
            }
            case PlayerEffect.EmitTelemetry e -> {}
        }
    }

    /**
     * {@code _loadItem(ref)}: where the load starts, decided in the JS order, then one
     * {@code load} with a fresh token. The index moves NOW (after the outgoing save already
     * ran); the loaded id moves only when {@code ready} comes back.
     */
    private void load(QueueItemRef ref, LoadOffsets offsets) {
        EngineItem item = find(ref.id());
        if (item == null) {
            // Drop the beat's deadline with the item it belonged to.
            endSeamGap("unknownRef");
            dispatch(new PlayerEvent.Error("loadItem: unknown ref " + ref.id()));
            return;
        }
        ItemBounds bounds = item.bounds();
        state.targetIndex = null;
        Double playhead = deck.positionSec;
        boolean readable = playhead != null && Rows.isFinite(playhead);
        // RE-ENTERING THE ITEM THE DECK HOLDS is a resume in place (#689), never from the end
        // of a finished item, and never when a restart or the listener's own destination was
        // asked for.
        boolean reEntering = offsets.forced() == null && offsets.explicit() == null && item.id.equals(state.loadedId)
                && readable && !deck.ended;
        boolean inPlace = false;
        if (reEntering) {
            double at = playhead;
            if (bounds != null) {
                inPlace = at > bounds.startSec() && at < bounds.endSec();
            } else {
                // A bridge is one authored line: there is no "where I was".
                inPlace = item.kind != PlayerItemKind.TTS && at > 0;
            }
        }
        // An explicit offset beats the in-point only from INSIDE the slice (#65 §4).
        Double explicitInside = null;
        Double explicit = offsets.explicit();
        if (explicit != null) {
            if (bounds != null) {
                if (explicit >= bounds.startSec() && explicit < bounds.endSec()) explicitInside = explicit;
            } else {
                explicitInside = explicit;
            }
        }
        double startSec;
        if (explicitInside != null) {
            startSec = explicitInside;
        } else if (inPlace) {
            double at = playhead;
            // An OS interruption's should-resume steps back INTERRUPTION_REWIND_SEC, never
            // before the item's own start (plan §4.4).
            if (offsets.rewind()) {
                Double back = TransportPolicy.interruptionResumeOffset(at, bounds == null ? null : bounds.startSec());
                startSec = back != null ? back : at;
            } else {
                startSec = at;
            }
        } else if (bounds != null) {
            // A segment's in-point overrides any saved position, always.
            startSec = bounds.startSec();
        } else if (offsets.forced() != null) {
            startSec = offsets.forced();
        } else {
            startSec = item.kind == PlayerItemKind.TTS ? 0 : savedPosition(item);
        }
        int index = indexOf(item.id);
        if (index >= 0) state.currentIndex = index;
        state.lastToken += 1;
        int token = state.lastToken;
        // §14: a rendered line already being SPOKEN because its file failed, paused and now
        // resumed, is a spoken line for this load: it continues the utterance instead of
        // retrying the file mid-sentence. A restart (`forced`) tries the file again.
        boolean resumingFallback = offsets.forced() == null && item.id.equals(state.fallbackSpokenId)
                && item.id.equals(state.loadedId) && state.narration != null && state.narration.paused;
        if (config.forayTapeEnabled() && (item.isSynthNarration() || resumingFallback)) {
            // §7 item 1: a script-only line has no file for a deck; it is SPOKEN.
            loadSpokenLine(item, token, offsets.forced() != null);
            return;
        }
        state.pendingLoad = new PendingLoad(token, item.id, startSec);
        deckCommand(new DeckCommand.Load(token, item.id, item.audioUrl, startSec, bounds != null, DeckDeadlineClass.of(item)));
    }

    /**
     * {@code _savedPositionFor(item)}: where a COLD start begins, through the one owner of
     * "where did the listener get to" ({@link ResumeRules#resumeOffset}).
     */
    private double savedPosition(EngineItem item) {
        Double duration = item.durationSec != null && Rows.isFinite(item.durationSec) && item.durationSec > 0 ? item.durationSec : null;
        double seconds = ResumeRules.resumeOffset(state.positions.get(item.id), duration);
        return Rows.isFinite(seconds) && seconds > 0 ? seconds : 0;
    }

    /**
     * {@code startPlayback}. The session backstop: without an active session this refuses
     * and says so, whatever path got here. A spoken line's first start is already under way;
     * a start after a pause CONTINUES the same utterance. A play that did start stamps the
     * page's {@code lastEpisodeRow} (it "actually plays" now) and the restore record.
     */
    private void startPlayback() {
        if (state.session != SessionPolicy.Phase.ACTIVE) {
            diag("fault", m("kind", str("no-session")), m("session", str(state.session.token)));
            out.add(new EngineCommand.CommandFailed(Refusal.SESSION_FAILED_OTHER.token));
            return;
        }
        SpokenLine line = state.narration;
        if (line != null) {
            if (line.paused) out.add(new EngineCommand.Narration(new NarrationCommand.Resume(line.seq)));
            writeRestore();
            return;
        }
        deckCommand(DeckCommand.PLAY);
        JsonNode row = state.lastEpisodeRow;
        if (row != null && !state.lastEpisodeRowWritten && Objects.equals(string(row.get("id")), state.loadedId)) {
            String stamp = Rows.timestamp(now.wallMs());
            Rows.StoredRow stored = stamp == null ? null : lastEpisodeRow(row, stamp);
            if (stored != null) {
                out.add(new EngineCommand.WriteRow(stored));
                state.lastEpisodeRowWritten = true;
            }
        }
        writeRestore();
    }

    /**
     * {@code cp_last_episode} as the ENGINE writes it (plan §5.2): the page's
     * {@code lastEpisodeRow} VERBATIM, in the page's key order, with {@code updated_at}
     * stamped when the item plays (replacing a stale stamp in place, as
     * {@code {...row, updated_at}} does). A row with no non-empty string id writes nothing.
     * Pinned byte for byte by {@code manager-episode/last-episode-row-*}.
     */
    public static Rows.StoredRow lastEpisodeRow(JsonNode row, String updatedAt) {
        if (!(row instanceof JsonNode.Obj obj)) return null;
        String id = string(row.get("id"));
        if (id == null || id.isEmpty()) return null;
        List<JsonNode.Member> members = new ArrayList<>(obj.members());
        int at = -1;
        for (int i = 0; i < members.size(); i++) {
            if (members.get(i).key().equals("updated_at")) {
                at = i;
                break;
            }
        }
        JsonNode.Member stamp = JsonNode.member("updated_at", str(updatedAt));
        if (at >= 0) {
            members.set(at, stamp);
        } else {
            members.add(stamp);
        }
        return new Rows.StoredRow(Rows.LAST_EPISODE_KEY, JSWriter.stringify(new JsonNode.Obj(members)));
    }

    // ---- deck events

    private void onDeck(DeckEvent event) {
        switch (event) {
            case DeckEvent.Ready e -> onReady(e.token());
            case DeckEvent.Failed e -> onLoadFailure(e.token(), e.message(), StopCause.ERROR);
            case DeckEvent.DeadlineExceeded e ->
                    onLoadFailure(e.token(), "no ready inside " + e.afterMs() + " ms", StopCause.LOAD_DEADLINE);
            case DeckEvent.Ended e -> onEnded(e.token());
            case DeckEvent.TimeControl e -> onTimeControl(e.token(), e.status());
            case DeckEvent.PausedUncommanded e -> onUncommandedPause(e.token());
            case DeckEvent.Stalled e -> {
                if (isLoadedToken(e.token())) state.buffering = true;
            }
            case DeckEvent.DurationLoaded e -> diag("deck", m("kind", str("duration")), m("token", num(e.token())),
                    m("durationSec", Rows.finiteOrNull(e.durationSec())));
            case DeckEvent.NotReady e -> diag("deck", m("kind", str("not-ready")), m("token", num(e.token())),
                    m("attempt", num(e.attempt())), m("cause", str(e.cause())));
            case DeckEvent.Refused e -> diag("deck", m("kind", str("refused")), m("command", str(e.command())),
                    m("reason", str(e.reason())));
            case DeckEvent.Seeked e -> {}
            case DeckEvent.PrepareWindow e -> {
                if (isLoadedToken(e.token())) warmNextSegment();
            }
            case DeckEvent.Prepared e -> {
                // Only the load in flight is described; a stale report is dropped.
                if (state.pendingLoad != null && state.pendingLoad.token() == e.token()) {
                    state.deckPrepare = new DeckPrepareReport(e.token(), e.hit(), e.stages());
                }
            }
        }
    }

    private boolean isLoadedToken(int token) {
        return state.loadedToken != null && state.loadedToken == token;
    }

    /**
     * A load landed. Only the load that owns the deck continues (corner case #19): a
     * superseded one is logged and plays nothing, stamps nothing.
     */
    private void onReady(int token) {
        PendingLoad pending = state.pendingLoad;
        if (pending == null || pending.token() != token) {
            diag("deck", m("kind", str("superseded")), m("token", num(token)));
            return;
        }
        // THE LISTENER CAN MOVE DURING A RENDERED BRIDGE'S LOAD (audit round 3, player-core-2):
        // the bridge plays only if the machine is still transitioning to it.
        if (pending.bridge() && !stillOn(pending)) {
            state.pendingLoad = null;
            diag("bridge", m("kind", str("landed-after-leaving")), m("token", num(token)));
            return;
        }
        state.pendingLoad = null;
        state.loadedId = pending.itemId();
        state.loadedToken = token;
        state.startingHop = null;
        // A new load owns the deck: the last one's stall is not this one's.
        clearStallLatch();
        // A deck item holds the playhead now: a spoken line it replaced is over.
        endSpokenLine();
        if (pending.bridge()) {
            // A rendered bridge plays the moment it lands (`_playTransitionBridge`).
            startPlayback();
            return;
        }
        EngineItem item = config.forayTapeEnabled() ? find(pending.itemId()) : null;
        if (item == null) {
            dispatch(PlayerEvent.ITEM_LOADED);
            return;
        }
        landed(item, token);
    }

    /** What follows a load that landed (a deck's {@code ready}, or a spoken line's {@code started}): ADR-0007's gate, then the beat. */
    private void landed(EngineItem item, int token) {
        // ADR-0007's rung 3 runs HERE and nowhere earlier: the first moment the duration of the
        // copy the listener actually received exists. An APPROXIMATE copy is never audible.
        SeekPolicy.LoadGate gate = SeekPolicy.segmentLoadGate(item.needsDriftCheck(), item.daiSuspected(),
                item.referenceDurationSec(), item.adPadSec(), deck.durationSec, state.forayIsLocalFile, state.forayAllowAdPad);
        if (!gate.ok()) {
            refuseAtLoad(item, gate.reason() != null ? gate.reason() : "");
            return;
        }
        if (gate.note() != null) diag("gate", m("kind", str("noted")), m("item", str(item.id)));
        // The seam beat is spent HERE, between a loaded-and-positioned asset and the
        // `itemLoaded` that arms the out-point and starts it. A load that FAILED never reaches
        // this line: an error never waits out a beat.
        awaitSeamGap(token);
    }

    /**
     * A load (or the item it loaded) failed. A failure nobody is waiting on any more is not
     * the CURRENT item failing; otherwise the cause row, the page's error ({@code chain-start}
     * for a hop, C-6), then the reducer's error (idle, pause).
     */
    private void onLoadFailure(int token, String message, StopCause cause) {
        PendingLoad pending = state.pendingLoad;
        boolean isPending = pending != null && pending.token() == token;
        boolean isHeld = pending == null && isLoadedToken(token);
        if (!isPending && !isHeld) {
            diag("deck", m("kind", str("superseded-failure")), m("token", num(token)));
            return;
        }
        if (fallBackToScript(token, isPending, cause)) return;
        if (pending != null && pending.bridge() && pending.token() == token) {
            // A bridge that will not load never stalls the queue (corner case #12).
            state.pendingLoad = null;
            diag("bridge", m("kind", str("load-failed")), m("item", str(pending.itemId())));
            advancePastBridgeFailure();
            return;
        }
        String itemId = pending != null ? pending.itemId() : state.loadedId != null ? state.loadedId : "?";
        state.pendingLoad = null;
        stopRow(cause, null);
        // Drop the beat's deadline with the item it belonged to: a failed seam reports at once.
        endSeamGap("loadFailed");
        if (state.startingHop != null) {
            state.startingHop = null;
            out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("chain-start", message)));
        } else {
            out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("load", message)));
        }
        dispatch(new PlayerEvent.Error("loadItem(" + itemId + ") failed: " + message));
    }

    /**
     * §14 (queue-manager.js, Phase 2; founder rulings D1-D11, 2026-09-28): a RENDERED narration
     * line whose FILE fails is read aloud from its script instead, in all three places a file can
     * fail ({@code load}, {@code bridge}, {@code playing}), only while the machine is still ON that
     * line. The spoken line gets a FRESH token, so a late report about the failed file is dropped
     * as {@code superseded-failure}. A line with no script, and a clip, fail exactly as before.
     */
    private boolean fallBackToScript(int token, boolean isPending, StopCause cause) {
        if (!config.forayTapeEnabled()) return false;
        String itemId;
        String at;
        if (isPending) {
            PendingLoad pending = state.pendingLoad;
            if (pending == null || pending.token() != token || pending.spokenSeq() != null) return false;
            itemId = pending.itemId();
            at = pending.bridge() ? "bridge" : "load";
        } else {
            if (state.narration != null) return false;
            itemId = state.loadedId;
            at = "playing";
        }
        if (itemId == null) return false;
        EngineItem item = find(itemId);
        EngineItem focus = focusItem();
        if (item == null || !item.canSpeakInstead() || focus == null || !focus.id.equals(item.id)) return false;
        boolean onIt = switch (at) {
            case "load" -> state.player instanceof PlayerQueueState.LoadingItem;
            case "bridge" -> state.player instanceof PlayerQueueState.Transitioning;
            default -> state.player instanceof PlayerQueueState.Playing || state.player instanceof PlayerQueueState.Transitioning;
        };
        if (!onIt) return false;
        diag("narration", m("kind", str("fallback")), m("reason", str(cause == StopCause.LOAD_DEADLINE ? "timeout" : "failed")),
                m("at", str(at)));
        // A file that failed mid-line: silence the deck under it first.
        if (at.equals("playing")) deckCommand(DeckCommand.PAUSE);
        state.lastToken += 1;
        // `load` lands like any loaded line; a bridge, and a line already playing, play on.
        speakLine(item, state.lastToken, !at.equals("load"), true);
        return true;
    }

    /** {@code _handleBackendItemEnded}: the item ran out. */
    private void onEnded(int token) {
        if (!isLoadedToken(token)) {
            diag("deck", m("kind", str("stale-ended")), m("token", num(token)));
            return;
        }
        itemEnded();
    }

    /**
     * {@code _handleBackendItemEnded}: the item the playhead is on ended (the deck's
     * {@code ended}, or a spoken line's {@code didFinish} or deadline). Resolve what "next"
     * means, then feed exactly one {@code itemEnded}: the queue's next item, or the next
     * continuation hop when {@code autoAdvance} is on, or the end.
     */
    private void itemEnded() {
        // The stall latch belongs to the item that ended.
        clearStallLatch();
        switch (state.player) {
            case PlayerQueueState.Transitioning t -> {
                Next next = nextItem(cursor(), true);
                // A bridge marks its own seam, so no beat; but narration -> segment DOES get the
                // jingle (§13): the founder's "between podcasts" mark comes after the line.
                if (next != null) armInterlude(state.currentItem(), next.item());
                dispatch(new PlayerEvent.ItemEnded(next == null ? null : next.item().ref(), false));
            }
            case PlayerQueueState.Playing p -> {
                // THE OUT-POINT AND A NATURAL END ARE ONE END: the deck reports either as
                // `ended`, and every transition after it is identical.
                Next next = nextItem(cursor(), false);
                if (next != null) {
                    boolean bridged = next.item().kind == PlayerItemKind.TTS;
                    EngineItem from = state.currentItem();
                    if (config.forayTapeEnabled() && from != null) {
                        // Stamp the beat BEFORE dispatching: `itemEnded` issues the next load in
                        // this same turn, and the whole point is for that load to be inside it.
                        armSeamGap(from, next.item(), bridged);
                        // And the jingle in the same instant (§13), after the beat so its deadline
                        // is the floor.
                        armInterlude(from, next.item());
                        // The span runs from the out-point until the next item is audible.
                        if (state.backgrounded) {
                            beginGrace(next.item().id.equals(state.preparedItemId) ? GraceReason.SEAM : GraceReason.PREPARE_MISS);
                        }
                    }
                    dispatch(new PlayerEvent.ItemEnded(next.item().ref(), bridged));
                    // A silent seam (a beat with no jingle in it) may render digital silence (off).
                    startSilence();
                    return;
                }
                if (state.autoAdvance && state.forayId == null && !state.chain.isEmpty()) {
                    dispatch(new PlayerEvent.ItemEnded(null, false));
                    begin(new DeferredIntent.WalkHop(state.chain.get(0)), Source.AUTOADVANCE);
                    return;
                }
                if (state.autoAdvance && state.forayId == null) {
                    diag("continuation", m("kind", str("chain-exhausted")));
                }
                stopRow(state.forayId != null ? StopCause.FINAL_END : StopCause.ENDED, null);
                dispatch(new PlayerEvent.ItemEnded(null, false));
                markForayFinished();
                applySession(SessionPolicy.transition(state.session,
                        new SessionPolicy.Input.Simple(SessionPolicy.InputKind.FINAL_END), state.holdPolicy));
            }
            default -> diag("deck", m("kind", str("ended-ignored")), m("state", str(state.stateType())));
        }
    }

    private void onTimeControl(int token, DeckEvent.TimeControlStatus status) {
        if (!isLoadedToken(token)) return;
        switch (status) {
            case PLAYING -> {
                state.buffering = false;
                if (state.grace != null) endGrace(GraceOutcome.PLAYING);
            }
            case WAITING -> {
                if (BUFFERING_WHILE_WAITING) state.buffering = true;
            }
            case PAUSED -> {}
        }
    }

    /**
     * Observe, don't believe (plan §4.3 Q-9): the deck stopped and nobody here asked it to.
     * Within 500 ms of a route going away it is the route's; otherwise the system's; either
     * way the machine is corrected towards paused, never the reverse.
     */
    private void onUncommandedPause(int token) {
        if (!isLoadedToken(token)) return;
        state.lastUncommandedPauseAtMono = now.monoMs();
        deck.audible = false;
        boolean routeAttributed = false;
        if (state.lastRouteLostAtMono != null) {
            double gap = now.monoMs() - state.lastRouteLostAtMono;
            routeAttributed = gap >= 0 && gap <= ROUTE_ATTRIBUTION_MS;
        }
        reconcile(true, routeAttributed);
    }

    /**
     * {@code reconcileWithBackend(why)}: correct the machine against what the deck is doing.
     * Only ever towards paused from {@code playing} (it never calls play); towards
     * {@code playing} from {@code interrupted} only on the deck's own word that THIS item is
     * audible ({@code elementResumed} carries no play).
     */
    private void reconcile(boolean unexplainedPause, boolean routeAttributed) {
        if (state.player instanceof PlayerQueueState.Interrupted interrupted) {
            EngineItem current = state.currentItem();
            if (state.narration != null || !audibleNow() || current == null || !current.id.equals(state.loadedId)
                    || !interrupted.item().id().equals(current.id)) {
                return;
            }
            dispatch(PlayerEvent.ELEMENT_RESUMED);
            return;
        }
        if (!(state.player instanceof PlayerQueueState.Playing)) return;
        // A spoken line is "playing" with nothing in the deck producing it: the deck's silence
        // says nothing about it.
        if (state.narration != null) return;
        if (deck.audible) return;
        if (deck.ended) {
            diag("reconcile", m("kind", str("skipped-ended")));
            return;
        }
        stopRow(routeAttributed ? StopCause.ROUTE_CHANGE : StopCause.SYSTEM_PAUSE, null);
        // The OS took the audio; the listener did not press anything.
        state.pausedByListener = false;
        // WHO took it decides whether a should-resume may bring it back (#263, corner case #13).
        if (routeAttributed || !unexplainedPause) state.pausedByRoute = true;
        dispatch(PlayerEvent.INTERRUPTION_BEGAN);
    }

    // ---- the audio session's notifications

    private void onSession(SessionEvent event) {
        switch (event) {
            case SessionEvent.InterruptionBegan e -> onInterruptionBegan(e.reason());
            case SessionEvent.InterruptionEnded e -> onInterruptionEnded(e.shouldResume());
            case SessionEvent.Route e -> onRoute(e.change());
            case SessionEvent.MediaServicesReset e -> onMediaServicesReset();
        }
    }

    /**
     * Interruptions by REASON (plan §4.4): a muted built-in mic and a stale
     * {@code appWasSuspended} are rows, not stops; anything else takes the session and
     * pauses, with its cause row first. A SPOKEN line the synthesiser says is still speaking
     * makes the event late, and nothing is touched.
     */
    private void onInterruptionBegan(String raw) {
        if (state.narration != null && state.isPlaying() && now.narrator() == NarratorReading.SPEAKING) {
            diag("session", m("kind", str("interruption")), m("phase", str("began")), m("late", str("narration-speaking")));
            return;
        }
        Vocabulary.InterruptionReason reason = SessionPolicy.interruptionReason(raw);
        boolean running = state.isRunning() || audibleNow();
        SessionPolicy.Transition transition = SessionPolicy.transition(state.session,
                new SessionPolicy.Input.InterruptionBegan(reason, running, state.activatedInProcess), state.holdPolicy);
        diag("session", m("kind", str("interruption")), m("phase", str("began")), m("reason", str(reason.token)),
                m("running", JsonNode.bool(running)));
        if (transition.row() == SessionPolicy.Row.MIC_MUTED || transition.row() == SessionPolicy.Row.STALE_SUSPENSION) {
            applySession(transition);
            return;
        }
        cutSeamGap("interruption");
        stopRow(StopCause.INTERRUPTION, null);
        applySession(transition);
        dispatch(PlayerEvent.INTERRUPTION_BEGAN);
        releaseSeamGap();
    }

    /**
     * {@code interruptionEnded(shouldResume)}: ONLY AN INTERRUPTION THE OS CAUSED IS RESUMED
     * (not a listener's pause, not a lost route), and the resume is request/response:
     * activate, then the in-place load that steps back INTERRUPTION_REWIND_SEC, holding grace
     * until the deck plays.
     */
    private void onInterruptionEnded(boolean shouldResume) {
        boolean resume = shouldResume && !state.pausedByListener && !state.pausedByRoute;
        if (shouldResume && !resume) {
            diag("session", m("kind", str("interruption")), m("phase", str("ended")), m("resumed", JsonNode.FALSE),
                    m("why", str(state.pausedByRoute ? "route-lost" : "listener-paused")));
        }
        boolean wasPlaying = state.player instanceof PlayerQueueState.Interrupted i && i.wasPlaying();
        SessionPolicy.Transition transition = SessionPolicy.transition(state.session,
                new SessionPolicy.Input.InterruptionEnded(resume, wasPlaying), state.holdPolicy);
        boolean resuming = resume && wasPlaying;
        if (transition.actions().contains(SessionPolicy.Action.ACTIVATE)) {
            if (resuming) {
                beginGrace(GraceReason.INTERRUPTION_RESUME);
                spanRow(DeferredIntent.INTERRUPTION_RESUME);
            }
            requestActivation(DeferredIntent.INTERRUPTION_RESUME, Source.SESSION);
            return;
        }
        applySession(transition);
        if (resuming && state.session != SessionPolicy.Phase.ACTIVE) {
            // Released while paused (hold policy none): the resume activates like any other play.
            begin(DeferredIntent.INTERRUPTION_RESUME, Source.AUTORESUME);
            return;
        }
        if (resuming) {
            beginGrace(GraceReason.INTERRUPTION_RESUME);
            spanRow(DeferredIntent.INTERRUPTION_RESUME);
        }
        dispatch(new PlayerEvent.InterruptionEnded(resume), LoadOffsets.rewinding(resume));
    }

    /**
     * {@code routeChanged(...)} (corner case #13): a lost route pauses and is not resumable by
     * a later call; a route reappearing resumes only a car this engine has seen before, never
     * headphones being plugged in.
     */
    private void onRoute(RouteChange change) {
        if (change.isCarRoute() && change.routeName() != null) state.knownCarRoutes.add(change.routeName());
        diag("session", m("kind", str("route")), m("oldDeviceUnavailable", JsonNode.bool(change.oldDeviceUnavailable())),
                m("port", change.portType() == null ? JsonNode.NULL : str(change.portType())));
        if (change.oldDeviceUnavailable()) {
            state.lastRouteLostAtMono = now.monoMs();
            state.pausedByRoute = true;
            Double paused = state.lastUncommandedPauseAtMono;
            if (paused != null && now.monoMs() - paused >= 0 && now.monoMs() - paused <= ROUTE_ATTRIBUTION_MS) {
                // The deck's pause came first and was reconciled as the system's; the route is why.
                diag("session", m("kind", str("route-attributed")), m("to", str("pause")));
            }
            // A beat that outlived a lost route would start audio into a dead route.
            cutSeamGap("routeLost");
            stopRow(StopCause.ROUTE_CHANGE, null);
            dispatch(new PlayerEvent.RouteChanged(true));
            releaseSeamGap();
            // The clock stops with the route: write the Foray's position NOW.
            persistForay(true);
        } else {
            dispatch(new PlayerEvent.RouteChanged(false));
        }
        if (change.oldDeviceUnavailable() || change.routeName() == null || !state.knownCarRoutes.contains(change.routeName())
                || state.currentItem() == null) {
            return;
        }
        if (!(state.player instanceof PlayerQueueState.Interrupted i) || !i.wasPlaying()) return;
        diag("session", m("kind", str("route-resume")), m("knownCar", JsonNode.TRUE));
        begin(DeferredIntent.ROUTE_RESUME, Source.AUTORESUME);
    }

    /**
     * Media services were reset: the session is gone and every player object with it.
     * Re-apply the category, rebuild, and land paused and NOT resumable: the deck holds
     * nothing, so the next play rebuilds from the saved position.
     */
    private void onMediaServicesReset() {
        SessionPolicy.Transition transition = SessionPolicy.transition(state.session,
                new SessionPolicy.Input.Simple(SessionPolicy.InputKind.MEDIA_SERVICES_RESET), state.holdPolicy);
        stopRow(StopCause.MEDIA_SERVICES_RESET, null);
        applySession(transition);
        dispatch(PlayerEvent.INTERRUPTION_BEGAN);
        dispatch(new PlayerEvent.InterruptionEnded(false));
        deckCommand(DeckCommand.UNLOAD);
        state.loadedId = null;
        state.loadedToken = null;
        state.pendingLoad = null;
    }

    // ---- lifecycle and timers

    private void onLifecycle(LifecycleEvent event) {
        switch (event) {
            case LifecycleEvent.ColdLaunch e -> {
                // `restoreColdLaunchState`: queue and position from local state, before any
                // network call (corner case #15). The offset rides on the load.
                state.queue = new ArrayList<>(e.queue());
                state.currentIndex = -1;
                state.closed = false;
                if (e.index() < 0 || e.index() >= e.queue().size()) {
                    diag("restore", m("kind", str("bad-index")));
                    return;
                }
                state.currentIndex = e.index();
                if (e.autoplay()) begin(DeferredIntent.COLD_PLAY, Source.RESTORE);
            }
            case LifecycleEvent.Background e -> {
                state.backgrounded = true;
                flushPosition();
            }
            case LifecycleEvent.Terminating e -> flushPosition();
            case LifecycleEvent.Foreground e -> {
                state.backgrounded = false;
                reconcile(false, false);
            }
            case LifecycleEvent.Teardown e -> teardown();
        }
    }

    private void onTimer(EngineTimer timer) {
        switch (timer) {
            case POSITION_TICK -> {
                persistIfDue();
                persistForay(false);
            }
            case SEAM_BEAT -> {
                state.seamTimerArmed = false;
                finishSeamGap();
            }
            case NARRATION_TICK -> {
                state.narrationTickArmed = false;
                narrationTick();
            }
            case SILENCE_CAP -> {
                // INTERLUDE_CEILING_SEC from the out-point: past it only grace covers.
                if (!state.silenceActive) return;
                state.silenceActive = false;
                out.add(EngineCommand.SILENCE_STOP);
                diag("silence", m("kind", str("capped")));
            }
            case GRACE_EXPIRED -> {
                if (state.grace == null) return;
                // The deterministic outcome (plan §4.4): end the span, say so, and pause, as the
                // listener's own pause would.
                endGrace(GraceOutcome.EXPIRED);
                stopRow(StopCause.GRACE_EXPIRED, null);
                state.pausedByListener = true;
                dispatch(PlayerEvent.INTERRUPTION_BEGAN);
                applySession(SessionPolicy.transition(state.session, new SessionPolicy.Input.Simple(SessionPolicy.InputKind.PAUSE),
                        state.holdPolicy));
            }
            case HOLD_EXPIRED -> {
                state.holdTimerArmed = false;
                applySession(SessionPolicy.transition(state.session, new SessionPolicy.Input.HoldExpired(state.isRunning()),
                        state.holdPolicy));
            }
        }
    }

    // ---- continuation (plan §5.5)

    /**
     * Walk one hop: log it ({@code advanceLog}, acked by the page), tell the page, and play
     * its item as a playEpisode would, with its own {@code lastEpisodeRow}. The outgoing
     * episode's position is saved first unless it simply ran out.
     */
    private void walk(EngineContract.Hop hop, Source source) {
        int at = state.chain.indexOf(hop);
        if (at >= 0) state.chain.subList(0, at + 1).clear();
        EngineItem item = EngineItem.of(hop.node().get("item"));
        if (item == null) {
            diag("continuation", m("kind", str("hop-unplayable")), m("nextId", str(hop.nextId())));
            out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("chain-start",
                    "hop " + hop.nextId() + " carries no playable item")));
            return;
        }
        if (state.player instanceof PlayerQueueState.Playing || state.player instanceof PlayerQueueState.Interrupted) {
            persistPosition();
        }
        state.lastAdvanceSeq += 1;
        AdvanceEntry entry = new AdvanceEntry(state.lastAdvanceSeq, hop, now.wallMs());
        state.advanceLog.add(entry);
        while (state.advanceLog.size() > ADVANCE_LOG_CAP) state.advanceLog.remove(0);
        out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Advanced(entry)));
        diag("continuation", m("kind", str("advanced")), m("source", str(source.token)), m("planSeq", num(hop.planSeq())),
                m("hopSeq", num(hop.hopSeq())));
        state.queue = new ArrayList<>(Collections.singletonList(item));
        state.currentIndex = 0;
        state.forayId = null;
        state.lastEpisodeRow = hop.node().get("lastEpisodeRow");
        state.lastEpisodeRowWritten = false;
        state.startingHop = hop;
        state.pausedByListener = false;
        state.pausedByRoute = false;
        dispatch(new PlayerEvent.Play(item.ref()));
        writeRestore();
    }

    // ---- positions, events and the restore record

    /**
     * {@code _persistPosition}: the playhead the DECK holds for the current item. A segment
     * has no resume point worth keeping; a spoken line has no position; an item the deck does
     * not hold has no playhead to write (#689), and one is never fabricated.
     */
    private void persistPosition() {
        EngineItem item = state.currentItem();
        if (item == null || item.bounds() != null) return;
        // A spoken line has nothing in the deck: the deck's playhead is left over from the item
        // before it, and an utterance has no position.
        if (state.narration != null && item.id.equals(state.loadedId)) return;
        if (!item.id.equals(state.loadedId)) {
            diag("position", m("kind", str("refused")), m("item", str(item.id)),
                    m("about", state.loadedId == null ? JsonNode.NULL : str(state.loadedId)));
            return;
        }
        Double seconds = deck.positionSec;
        if (seconds == null || !Rows.isFinite(seconds)) return;
        String stamp = Rows.timestamp(now.wallMs());
        if (stamp == null) return;
        Rows.StoredRow row = Rows.position(item.id, seconds, deck.durationSec, stamp);
        if (row == null) return;
        Double duration = deck.durationSec != null && Rows.isFinite(deck.durationSec) ? deck.durationSec : null;
        out.add(new EngineCommand.WritePosition(new EngineCommand.PositionWrite(item.id, seconds, duration, row)));
        state.positions.put(item.id, new ResumeRules.StoredPosition(seconds, duration));
        state.lastPersisted = new ResumeRules.LastWrite(item.id, seconds);
        ResumeRules.PositionEvent event = ResumeRules.positionEvent(state.eventMarks.get(item.id), seconds, duration);
        if (event != null) {
            state.eventMarks.put(item.id, event.mark());
            appendEvent(item.id, event.seconds(), event.duration());
        }
        writeRestore();
    }

    /**
     * client.js {@code flushPositions} (corner case #17, #689): leaving the foreground or
     * being terminated writes the playhead NOW, playing or paused, and the Foray's row with it.
     * The store writes it synchronously (A-27), so the row is stored before the handler returns.
     */
    private void flushPosition() {
        if (state.currentItem() == null) return;
        persistPosition();
        persistForay(true);
    }

    /** {@code _persistIfDue}: the periodic write, while playing, when the playhead has moved enough. */
    private void persistIfDue() {
        if (!(state.player instanceof PlayerQueueState.Playing)) return;
        EngineItem item = state.currentItem();
        if (item == null || item.bounds() != null || !item.id.equals(state.loadedId) || state.narration != null) return;
        if (!ResumeRules.positionTickDue(state.lastPersisted, item.id, deck.positionSec)) return;
        persistPosition();
    }

    private void appendEvent(String episodeId, double seconds, Double duration) {
        state.lastEventSeq += 1;
        PendingEvent event = new PendingEvent(state.lastEventSeq, "position", episodeId, seconds, duration, now.wallMs());
        state.pendingEvents.add(event);
        while (state.pendingEvents.size() > PENDING_EVENTS_CAP) state.pendingEvents.remove(0);
        out.add(new EngineCommand.AppendEvent(event));
    }

    /** The engine-private restore record (plan §4.5): what a cold launch needs to paint and to play without the page. */
    private void writeRestore() {
        if (state.queue.isEmpty()) return;
        String stamp = Rows.timestamp(now.wallMs());
        if (stamp == null) return;
        EngineItem current = state.currentItem();
        double offset = 0;
        ResumeRules.StoredPosition saved = current == null ? null : state.positions.get(current.id);
        if (current != null && current.id.equals(state.loadedId) && deck.positionSec != null && Rows.isFinite(deck.positionSec)) {
            offset = deck.positionSec;
        } else if (saved != null) {
            offset = saved.seconds();
        }
        List<JsonNode> queue = new ArrayList<>();
        for (EngineItem item : state.queue) queue.add(item.node);
        List<JsonNode> advances = new ArrayList<>();
        for (AdvanceEntry entry : state.advanceLog) advances.add(entry.node());
        List<JsonNode> events = new ArrayList<>();
        for (PendingEvent event : state.pendingEvents) events.add(event.node());
        RestoreRecord record = new RestoreRecord(state.forayId != null ? RestoreRecord.Mode.FORAY : RestoreRecord.Mode.EPISODE,
                queue, Math.max(0, state.currentIndex), offset, state.forayId, state.rate, state.voiceId, advances, events, stamp,
                config.build());
        out.add(new EngineCommand.WriteRestore(record));
    }

    // ---- grace, the session, timers, rows

    private void beginGrace(GraceReason reason) {
        if (state.grace != null) return;
        state.grace = reason;
        out.add(new EngineCommand.GraceBegin(reason));
    }

    private void endGrace(GraceOutcome outcome) {
        if (state.grace == null) return;
        state.grace = null;
        out.add(new EngineCommand.GraceEnd(outcome));
    }

    /** Apply a {@link SessionPolicy} transition: the phase, its actions as commands, and its row. */
    private void applySession(SessionPolicy.Transition transition) {
        state.session = transition.phase();
        for (SessionPolicy.Action action : transition.actions()) {
            switch (action) {
                case DEACTIVATE -> out.add(new EngineCommand.SessionDeactivate(false));
                case DEACTIVATE_NOTIFY -> out.add(new EngineCommand.SessionDeactivate(true));
                case REAPPLY_CATEGORY -> out.add(EngineCommand.SESSION_REAPPLY_CATEGORY);
                case REBUILD -> out.add(EngineCommand.SESSION_REBUILD);
                case COMMAND_FAILED -> out.add(new EngineCommand.CommandFailed(
                        transition.reason() != null ? transition.reason() : SessionPolicy.sessionFailedReason(null)));
                // Only `begin` and `onInterruptionEnded` ask, through requestActivation.
                case ACTIVATE -> {}
            }
        }
        if (transition.row() != null) diag("session", m("kind", str(transition.row().token)));
    }

    /** {@code pauseHoldPolicy = until(m)}: a paused, active session is released after m minutes (plan §4.4). */
    private void armHoldTimerIfPaused() {
        if (!state.holdPolicy.isUntil() || state.session != SessionPolicy.Phase.ACTIVE || state.isRunning() || state.holdTimerArmed) {
            return;
        }
        state.holdTimerArmed = true;
        out.add(new EngineCommand.TimerArm(EngineTimer.HOLD_EXPIRED, state.holdPolicy.minutes() * 60_000.0, false));
    }

    private void cancelHoldTimer() {
        if (!state.holdTimerArmed) return;
        state.holdTimerArmed = false;
        out.add(new EngineCommand.TimerCancel(EngineTimer.HOLD_EXPIRED));
    }

    /**
     * EVERY STOP PATH WRITES ITS CAUSE FIRST, before the command that silences anything, so a
     * Copy pasted after a drive says why the audio stopped. Only when something was running
     * or audible: an {@code appWasSuspended} on a paused player is not a stop (plan §4.4).
     */
    private void stopRow(StopCause cause, Source source) {
        if (!state.isRunning() && !audibleNow()) return;
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(m("cause", str(cause.token)));
        if (source != null) fields.add(m("source", str(source.token)));
        EngineItem current = state.currentItem();
        fields.add(m("item", current == null ? JsonNode.NULL : str(current.id)));
        fields.add(m("positionSec", Rows.finiteOrNull(deck.positionSec)));
        fields.add(m("state", str(state.stateType())));
        out.add(new EngineCommand.Diag(new DiagEntry("stop", fields)));
    }

    private void diag(String kind, JsonNode.Member... fields) {
        out.add(new EngineCommand.Diag(new DiagEntry(kind, Arrays.asList(fields))));
    }

    private void diag(String kind, List<JsonNode.Member> fields) {
        out.add(new EngineCommand.Diag(new DiagEntry(kind, fields)));
    }

    private void refuse(Refusal refusal) {
        out.add(new EngineCommand.CommandFailed(refusal.token));
    }

    /** Emit a deck command and keep the turn's view of the deck in step. */
    private void deckCommand(DeckCommand command) {
        out.add(new EngineCommand.Deck(command));
        switch (command) {
            case DeckCommand.Load c -> {
                deck.positionSec = c.startSec();
                deck.audible = false;
                deck.ended = false;
                deckMovedThisTurn = true;
            }
            case DeckCommand.Play c -> {
                deck.audible = true;
                deckMovedThisTurn = true;
            }
            case DeckCommand.Pause c -> {
                deck.audible = false;
                deckMovedThisTurn = true;
            }
            case DeckCommand.Seek c -> deck.positionSec = c.toSec();
            case DeckCommand.Unload c -> {
                deck = DeckReading.idle();
                deckMovedThisTurn = true;
            }
            case DeckCommand.SetRate c -> {}
            case DeckCommand.SetOutPoint c -> {}
            case DeckCommand.Prepare c -> {}
        }
    }

    /** {@code elementIsAudible}: the deck's own answer, as the turn has left it. */
    private boolean audibleNow() {
        return deck.audible && !deck.ended;
    }

    /**
     * After every turn: the position timer runs exactly while playing; grace ends the moment
     * the intent does (a pause, a stop, a failure), or when the deck was already audible and
     * nothing new was asked of it; the hold timer never outlives a play.
     */
    private void settleTurn() {
        boolean playing = state.isPlaying();
        if (playing && !state.positionTimerArmed) {
            state.positionTimerArmed = true;
            out.add(new EngineCommand.TimerArm(EngineTimer.POSITION_TICK, ResumeRules.POSITION_INTERVAL_MS, true));
        } else if (!playing && state.positionTimerArmed) {
            state.positionTimerArmed = false;
            out.add(new EngineCommand.TimerCancel(EngineTimer.POSITION_TICK));
        }
        if (state.grace != null && state.pendingActivation == null) {
            if (!state.isRunning()) {
                endGrace(GraceOutcome.NOT_RUNNING);
            } else if (playing && now.deck().audible && !now.deck().ended && !deckMovedThisTurn) {
                endGrace(GraceOutcome.PLAYING);
            }
        }
        if (state.isRunning()) cancelHoldTimer();
    }

    // ---- Forays (A-40; the Swift NE-30s)

    /**
     * A Foray the ENGINE was handed ({@code playForay}): its transport runs on the Foray clock.
     * A queue loaded through the manager's own surface (a parity scenario's {@code playForay})
     * keeps the manager's transport.
     */
    private boolean forayTransport() {
        return config.forayTapeEnabled() && state.forayId != null;
    }

    /** The queue as the Foray clock reads it. */
    private List<ForayItem> forayItems() {
        List<ForayItem> items = new ArrayList<>(state.queue.size());
        for (EngineItem item : state.queue) items.add(item.forayItem());
        return items;
    }

    /**
     * Where the listener is on the Foray clock (client.js {@code forayPlayhead}): the deck's
     * playhead once it holds the item, the second a load in flight will land on, else unknown
     * (null), which a write never guesses.
     */
    private Double forayPositionSec(EngineItem item) {
        Double playhead;
        SpokenLine line = state.narration;
        if (line != null && line.itemId.equals(item.id) && item.id.equals(state.loadedId)) {
            // A spoken line's clock is wall time since it started (L-03).
            playhead = line.elapsedSec(now.monoMs());
        } else if (item.id.equals(state.loadedId)) {
            playhead = deck.positionSec;
        } else if (state.pendingLoad != null && state.pendingLoad.itemId().equals(item.id)) {
            playhead = state.pendingLoad.startSec();
        } else {
            playhead = null;
        }
        if (playhead == null || !Double.isFinite(playhead)) return null;
        return ForayClock.forayElapsed(forayItems(), (double) state.currentIndex, playhead);
    }

    /**
     * {@code playForay {forayId, title, items, buildReport, startElapsedSec?, isLocalFile,
     * allowAdPad, voiceId}} (plan §5.2). The page built the queue (A-1); the engine RE-VALIDATES
     * its structure (J-4) and refuses it whole, before anything is audible, when any item is not
     * what {@code buildForayQueue} guarantees. A resume point on the Foray clock lands inside its
     * clip ({@code segmentAtElapsed}, {@code sourceOffsetFor}).
     */
    private void playForay(EngineContract.Command.PlayForay args, Source source) {
        List<EngineItem> items = new ArrayList<>();
        for (JsonNode node : args.items()) {
            EngineItem item = EngineItem.of(node);
            if (item != null) items.add(item);
        }
        List<ForayItem> built = new ArrayList<>();
        for (EngineItem item : items) built.add(item.forayItem());
        StructuralCheck.Verdict verdict = StructuralCheck.check(built);
        if (items.size() != args.items().size() || !verdict.ok()) {
            diag("foray", m("kind", str("refused-structure")), m("problems", num(verdict.problems().size())));
            refuse(Refusal.REFUSED_STRUCTURE);
            return;
        }
        // LEAVING IS A FLUSH: whatever was playing writes where it got to.
        flushPosition();
        state.queue = items;
        state.currentIndex = -1;
        state.forayId = args.forayId();
        state.forayTitle = args.title();
        state.forayIsLocalFile = args.isLocalFile();
        state.forayAllowAdPad = args.allowAdPad();
        state.lastEpisodeRow = null;
        state.lastEpisodeRowWritten = false;
        state.startingHop = null;
        state.closed = false;
        state.preparedItemId = null;
        state.skippedSegments = 0;
        state.forayFinishedWritten = false;
        state.forayThrottle.clear(args.forayId());
        Double elapsed = args.startElapsedSec();
        if (elapsed != null) {
            ForayClock.Position at = ForayClock.segmentAtElapsed(forayItems(), elapsed);
            if (at != null && at.index() >= 0 && at.index() < items.size()) {
                Double offset = TransportPolicy.sourceOffset(items.get(at.index()).transportItem(), at.into());
                playIndex(at.index(), offset, source);
                return;
            }
        }
        playIndex(0, null, source);
    }

    /**
     * A scrub on the Foray clock ({@code seekTo} in a Foray): which clip it lands in and where,
     * then {@code scrubTarget}: another clip, or a Foray with nothing loaded, is a load at the
     * offset; the same clip is a seek. A spoken line has no offset to seek to.
     */
    private void forayScrub(double elapsed, Source source) {
        ForayClock.Position at = ForayClock.segmentAtElapsed(forayItems(), elapsed);
        if (at == null || at.index() < 0 || at.index() >= state.queue.size()) {
            refuse(Refusal.NOT_LOADED);
            return;
        }
        EngineItem item = state.queue.get(at.index());
        TransportPolicy.Scrub scrub = TransportPolicy.scrubTarget(at.index(), at.into(), item.transportItem(),
                (double) state.currentIndex, state.stateType());
        if (scrub.reload()) {
            playIndex(at.index(), scrub.offset(), source);
            return;
        }
        if (scrub.offset() == null) return;
        cutSeamGap("seek");
        dispatch(new PlayerEvent.Seek(scrub.offset(), true));
        releaseSeamGap();
    }

    /**
     * A ↺15 / 30↻ nudge in a Foray: a step on the Foray clock, stopped short of the total
     * ({@code skipTarget(foray: true)}), then an ordinary scrub.
     */
    private void forayNudge(double deltaSec, Source source) {
        EngineItem item = state.currentItem();
        if (item == null) {
            refuse(Refusal.NOT_LOADED);
            return;
        }
        Double position = forayPositionSec(item);
        if (position == null) {
            List<Double> starts = ForayClock.segmentStarts(forayItems());
            position = starts.get(Math.max(0, state.currentIndex));
        }
        Double target = TransportPolicy.skipTarget(true, position, deltaSec, ForayClock.forayRuntimeSec(forayItems()));
        if (target == null) return;
        forayScrub(target, source);
    }

    /**
     * {@code _warmNextSegment}: the deck says the boundary is the prefetch lead away. Name the
     * item that boundary will advance to and its in-point, so the standby deck can load it while
     * this one is still audible. Only a running item approaches a boundary, and only the
     * transitions that get a beat are warmed (the beat's own rule, CALLED, so the two cannot
     * drift): a Foray's last item prepares nothing.
     */
    private void warmNextSegment() {
        if (!config.forayTapeEnabled() || !(state.player instanceof PlayerQueueState.Playing)) return;
        EngineItem from = state.currentItem();
        if (from == null) return;
        Next next = nextItem(cursor(), false);
        if (next == null) {
            diag("prepare", m("kind", str("none")));
            return;
        }
        double sec = SeamGap.gapSec(from.seam(), next.item().seam(), next.item().kind == PlayerItemKind.TTS, SeamGap.AUTO_ADVANCE,
                config.seamGapSec());
        if (!(sec > 0)) {
            diag("prepare", m("kind", str("skipped")), m("item", str(next.item().id)));
            return;
        }
        state.preparedItemId = next.item().id;
        ItemBounds bounds = next.item().bounds();
        deckCommand(new DeckCommand.Prepare(next.item().id, next.item().audioUrl, bounds != null ? bounds.startSec() : 0,
                DeckDeadlineClass.of(next.item())));
    }

    // ---- the seam beat (queue-manager.js §10)

    /** {@code _setGapDeadline}: the one writer of the deadline, so the {@code beat} row can never disagree with {@code inSeamGap}. */
    private void setGapDeadline(Double until) {
        boolean was = state.gapUntilMono != null;
        state.gapUntilMono = until;
        if (until == null) state.gapArmedAtMono = null;
        if (was != (until != null)) diag("beat", m("kind", str(until != null ? "begin" : "end")));
    }

    /**
     * {@code _armSeamGap(from, to, bridged)}: at the moment the out-point (or a natural end)
     * fires, decide whether this transition is a seam and stamp the ABSOLUTE deadline. The beat
     * is wall clock: it does not scale with the listener's rate.
     */
    private void armSeamGap(EngineItem from, EngineItem to, boolean bridged) {
        double sec = SeamGap.gapSec(from.seam(), to.seam(), bridged, SeamGap.AUTO_ADVANCE, config.seamGapSec());
        if (!(sec > 0)) return;
        setGapDeadline(now.monoMs() + sec * 1000);
        state.gapArmedAtMono = now.monoMs();
        state.gapAskedMs = sec * 1000;
    }

    /**
     * {@code _awaitSeamGap(seq)}: hold what remains of the beat, then start the item, if this
     * load still owns the player. Nothing remaining starts it now: a slow load costs
     * max(gap, load), never gap + load.
     */
    private void awaitSeamGap(int token) {
        double remaining = seamGapRemainingMs(now.monoMs());
        if (remaining <= 0) {
            Double armedAt = state.gapArmedAtMono;
            // A jingle still claiming to sound once the whole deadline is spent loses to the tape.
            stopInterlude("spent");
            setGapDeadline(null);
            seamLanded(armedAt);
            return;
        }
        state.gapParkedToken = token;
        state.gapCut = false;
        state.seamTimerArmed = true;
        out.add(new EngineCommand.TimerArm(EngineTimer.SEAM_BEAT, remaining, false));
    }

    /**
     * The parked wait's {@code finish}: the beat ran out, or the action that cut it has issued
     * its own load. Idempotent. A newer load means this one is abandoned quietly; otherwise
     * {@code itemLoaded}, which the reducer reads by state.
     */
    private void finishSeamGap() {
        Integer token = state.gapParkedToken;
        if (token == null) return;
        state.gapParkedToken = null;
        if (state.seamTimerArmed) {
            state.seamTimerArmed = false;
            out.add(new EngineCommand.TimerCancel(EngineTimer.SEAM_BEAT));
        }
        state.gapCut = false;
        Double armedAt = state.gapArmedAtMono;
        // §13: the deadline ran out with the jingle still sounding (the ceiling): the jingle loses.
        stopInterlude("ceiling");
        setGapDeadline(null);
        if (state.lastToken != token) {
            diag("beat", m("kind", str("superseded")));
            return;
        }
        seamLanded(armedAt);
    }

    /** The load the beat held becomes audible: the packed {@code seam} row when it was a real seam, then {@code itemLoaded}. */
    private void seamLanded(Double armedAt) {
        // The deck pair's own report on this load, when it sent one, is the truth about the
        // standby deck (a prepare ASKED is not a prepare HIT).
        DeckPrepareReport report = state.deckPrepare != null && state.loadedToken != null
                && state.deckPrepare.token() == state.loadedToken ? state.deckPrepare : null;
        state.deckPrepare = null;
        if (armedAt != null) {
            boolean prepared = report != null ? report.hit()
                    : state.preparedItemId != null && state.preparedItemId.equals(state.loadedId);
            List<Vocabulary.Stage> stages = new ArrayList<>();
            if (report != null) {
                stages.addAll(report.stages());
                stages.add(Vocabulary.Stage.PLAY);
            } else {
                stages.add(Vocabulary.Stage.READY);
                stages.add(Vocabulary.Stage.PLAY);
            }
            Double bg = now.bgRemainingMs();
            SeamRow row = new SeamRow(now.monoMs() - armedAt, state.gapAskedMs, prepared, state.grace != null,
                    bg == null ? null : roundHalfAwayFromZero(bg), stages);
            out.add(new EngineCommand.Diag(row.entry()));
        }
        stopSilence("landed");
        dispatch(PlayerEvent.ITEM_LOADED);
    }

    /**
     * {@code _cutSeamGap(why)}: EVERY transport action ends a running beat. The clock stops now;
     * the parked wait is left parked until {@code releaseSeamGap}, after the action's own load.
     */
    private void cutSeamGap(String why) {
        // §13: a jingle is the beat with sound in it, so whatever cuts the beat silences it.
        stopInterlude(why);
        stopSilence(why);
        setGapDeadline(null);
        if (state.gapParkedToken == null || state.gapCut) return;
        state.gapCut = true;
        if (state.seamTimerArmed) {
            state.seamTimerArmed = false;
            out.add(new EngineCommand.TimerCancel(EngineTimer.SEAM_BEAT));
        }
        diag("beat", m("kind", str("cut")), m("why", str(why)));
    }

    /**
     * {@code _releaseSeamGap}: let a cut wait go, now that {@code lastToken} tells the truth. A
     * parked activation's action has not run yet: its answer releases it.
     */
    private void releaseSeamGap() {
        if (state.gapParkedToken == null || !state.gapCut || state.pendingActivation != null) return;
        finishSeamGap();
    }

    /** {@code _endSeamGap(why)}: cut and release, for the paths that end a seam without being a transport action. */
    private void endSeamGap(String why) {
        cutSeamGap(why);
        releaseSeamGap();
    }

    // ---- ADR-0007 at load, and rendered bridges

    /** The ladder refused the copy in hand: the segment is never audible. A {@code skipped} event and row, and the Foray moves on. */
    private void refuseAtLoad(EngineItem item, String reason) {
        state.skippedSegments += 1;
        int index = indexOf(item.id);
        if (index < 0) index = state.currentIndex;
        diag("skip", m("kind", str("ladder")), m("item", str(item.id)), m("index", num(index)));
        out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Skipped(item.id, index, reason)));
        skipUnplayableSegment();
    }

    /**
     * {@code _skipUnplayableSegment}: still {@code loadingItem}, so {@code skipToNext} replaces
     * the in-flight target. With something left the beat's deadline is KEPT (the replacement
     * spends what remains of it); with nothing left the Foray ends instead of looping.
     */
    private void skipUnplayableSegment() {
        Next next = nextItem(cursor(), false);
        if (next != null) {
            state.targetIndex = next.index();
        } else {
            endSeamGap("queueExhausted");
            stopRow(StopCause.FINAL_END, null);
        }
        dispatch(new PlayerEvent.SkipToNext(next == null ? null : next.item().ref()));
        if (next == null && state.stateType().equals("ended")) {
            markForayFinished();
            applySession(SessionPolicy.transition(state.session,
                    new SessionPolicy.Input.Simple(SessionPolicy.InputKind.FINAL_END), state.holdPolicy));
        }
    }

    /**
     * {@code _playTransitionBridge}: the reducer is {@code transitioning} onto a narration
     * bridge. A RENDERED one (a file) plays on the deck from 0 the moment it lands; a SPOKEN one
     * is handed to the synthesiser. One that is missing, or fails to load or to speak, is
     * stepped over so the queue never stalls.
     */
    private void playTransitionBridge() {
        if (!(state.player instanceof PlayerQueueState.Transitioning transitioning)) {
            diag("bridge", m("kind", str("without-transitioning")));
            return;
        }
        int index = indexOf(transitioning.to().id());
        if (index < 0) {
            advancePastBridgeFailure();
            return;
        }
        EngineItem bridge = state.queue.get(index);
        state.currentIndex = index;
        state.lastToken += 1;
        int token = state.lastToken;
        if (bridge.isSynthNarration()) {
            speakLine(bridge, token, true, false);
            return;
        }
        state.pendingLoad = new PendingLoad(token, bridge.id, 0, true, null, false);
        deckCommand(new DeckCommand.Load(token, bridge.id, bridge.audioUrl, 0, false, DeckDeadlineClass.of(bridge)));
    }

    /** {@code _advancePastBridgeFailure}: the item after the bridge, bridges skipped. */
    private void advancePastBridgeFailure() {
        Next next = nextItem(cursor(), true);
        dispatch(new PlayerEvent.ItemEnded(next == null ? null : next.item().ref(), false));
    }

    // ---- the narrating overlay (queue-manager.js §7 and L-03/L-05)

    /** The multiplier a line is uttered at: {@code NARRATION_RATE} (1x, OQ-3), unless it follows the listener. */
    private double utteranceRate() {
        return config.narrationFollowsListenerRate() ? state.rate : EngineConstants.QueueManager.NARRATION_RATE;
    }

    /**
     * {@code _loadItem} for a script-only line. RE-ENTERING A PAUSED UTTERANCE IS A RESUME, NOT
     * A RESTART (L-05): a re-entry into the line the playhead is already on, with the line
     * paused and no restart asked for, speaks nothing and lets {@code startPlayback} continue
     * the same utterance.
     */
    private void loadSpokenLine(EngineItem item, int token, boolean restart) {
        SpokenLine line = state.narration;
        if (!restart && item.id.equals(state.loadedId) && line != null && line.itemId.equals(item.id) && line.paused) {
            state.pendingLoad = null;
            diag("narration", m("kind", str("resuming-in-place")));
            landed(item, token);
            return;
        }
        speakLine(item, token, false, false);
    }

    /**
     * {@code _speakNarration}: ask the synthesiser for utterance {@code seq}. Like a deck load it
     * is a request now and an answer later ({@code started} or {@code failed} for that seq), and
     * the playhead moves only on {@code started}.
     */
    private void speakLine(EngineItem item, int token, boolean bridge, boolean fallback) {
        state.speakSeq += 1;
        int seq = state.speakSeq;
        state.pendingLoad = new PendingLoad(token, item.id, 0, bridge, seq, fallback);
        // The audible-start backstop (plan §4.4), as `startPlayback`'s.
        if (state.session != SessionPolicy.Phase.ACTIVE) {
            diag("fault", m("kind", str("no-session")), m("at", str("narration")), m("session", str(state.session.token)));
            onLoadFailure(token, "no active session for narration", StopCause.ERROR);
            return;
        }
        String script = string(item.node.get("script"));
        out.add(new EngineCommand.Narration(new NarrationCommand.Speak(seq, script == null ? "" : script, state.voiceId,
                utteranceRate())));
    }

    private void onNarrator(NarratorEvent event) {
        if (!config.forayTapeEnabled()) return;
        switch (event) {
            case NarratorEvent.Started e -> narrationStarted(e.seq(), e.voiceFallback());
            case NarratorEvent.Failed e -> {
                PendingLoad pending = state.pendingLoad;
                if (pending == null || pending.spokenSeq() == null || pending.spokenSeq() != e.seq()) {
                    diag("narration", m("kind", str("superseded-failure")), m("seq", num(e.seq())));
                    return;
                }
                // A failed speak is not a voice-fallback report.
                state.lastVoiceFallback = null;
                // The existing "a load failed" path: a bridge is stepped over, a line the
                // listener asked for is the page's error.
                onLoadFailure(pending.token(), "foray-tts: speak refused", StopCause.ERROR);
            }
            case NarratorEvent.Finished e -> finishLine(e.seq(), "finished");
            case NarratorEvent.Cancelled e -> {
                // A stop, a replacement, or the session taken from under the line: NEVER an
                // advance (L-05, "stop never advances").
                diag("narration", m("kind", str("cancelled")),
                        m("current", JsonNode.bool(state.narration != null && state.narration.seq == e.seq())));
            }
            case NarratorEvent.Resumed e -> narrationResumed(e.seq(), e.answer());
        }
    }

    /**
     * The synthesiser accepted utterance {@code seq}: the line IS the playhead now. A
     * {@code _loadItem} line then takes the gate and the beat like any landed load; a bridge is
     * already {@code transitioning} and plays on.
     */
    private void narrationStarted(int seq, boolean voiceFallback) {
        PendingLoad pending = state.pendingLoad;
        EngineItem item = pending != null && pending.spokenSeq() != null && pending.spokenSeq() == seq ? find(pending.itemId()) : null;
        if (item == null) {
            // SUPERSEDED WHILE speak() WAS IN FLIGHT (audit round 3, player-core-4/7): silence it,
            // unless a newer speak() already replaced it. A repeated `started` for the line
            // already playing is not a stale one.
            if (state.narration == null || state.narration.seq != seq) abandonSpeech(seq);
            diag("narration", m("kind", str("superseded")), m("seq", num(seq)));
            return;
        }
        // THE LISTENER CAN MOVE WHILE THE LINE'S speak() IS IN FLIGHT: the line starts only if
        // the machine is still loading or transitioning to it.
        if (!stillOn(pending)) {
            state.pendingLoad = null;
            abandonSpeech(seq);
            diag("narration", m("kind", str("left-while-speaking")), m("seq", num(seq)));
            return;
        }
        state.pendingLoad = null;
        state.lastVoiceFallback = voiceFallback;
        state.loadedId = pending.itemId();
        state.loadedToken = pending.token();
        state.startingHop = null;
        // A spoken line is the playhead: no deck stall describes it.
        clearStallLatch();
        state.narration = new SpokenLine(seq, item.id, now.monoMs());
        // §14: remembered only for a rendered line spoken INSTEAD of its file.
        state.fallbackSpokenId = pending.fallback() ? item.id : null;
        startNarrationTicker();
        if (voiceFallback) diag("narration", m("kind", str("voice-fallback")));
        // The line is audible: a span covering its start is over.
        if (state.grace != null) endGrace(GraceOutcome.PLAYING);
        if (pending.bridge()) return;
        landed(item, pending.token());
    }

    /**
     * THE STALL LATCH IS PER ITEM (client.js {@code setNowPlaying}): {@code buffering} is set
     * by a {@code stalled} and cleared only by that deck's {@code playing}, so whatever plays
     * next reports its own.
     */
    private void clearStallLatch() {
        if (!state.buffering) return;
        state.buffering = false;
        diag("deck", m("kind", str("stall-cleared")));
    }

    /**
     * Is the machine still on the line {@code pending} is speaking? Still {@code loadingItem}
     * for a line it loads, still {@code transitioning} for a bridge, and {@code playing} for a
     * rendered line read from its script after its file failed while sounding (§14).
     */
    private boolean stillOn(PendingLoad pending) {
        EngineItem focus = focusItem();
        if (focus == null || !focus.id.equals(pending.itemId())) return false;
        return switch (state.player) {
            case PlayerQueueState.LoadingItem l -> !pending.bridge();
            case PlayerQueueState.Transitioning t -> pending.bridge();
            case PlayerQueueState.Playing p -> pending.bridge() && pending.fallback();
            default -> false;
        };
    }

    /**
     * {@code _abandonSpeech(mine)}: a speak() whose line the player has left is told to stop,
     * unless a NEWER speak() has been issued since, which already replaced it.
     */
    private void abandonSpeech(int seq) {
        if (seq != state.speakSeq) return;
        out.add(new EngineCommand.Narration(new NarrationCommand.Stop(seq)));
    }

    /**
     * {@code _endSynthNarration}: a deck item holds the playhead. A line that did not finish is
     * dropped, so the synthesiser never keeps an utterance nobody will continue.
     */
    private void endSpokenLine() {
        SpokenLine line = state.narration;
        if (line == null) return;
        state.narration = null;
        state.fallbackSpokenId = null;
        stopNarrationTicker();
        if (!line.finished) out.add(new EngineCommand.Narration(new NarrationCommand.Discard(line.seq)));
    }

    /**
     * {@code _onTtsFinished}: advance past the line EXACTLY ONCE. The event must name the line
     * the playhead is on, and each line advances at most once, by {@code didFinish} or by its
     * deadline. Returns whether it advanced.
     */
    private boolean finishLine(int seq, String why) {
        SpokenLine line = state.narration;
        if (line == null) {
            diag("narration", m("kind", str("stray-end")), m("why", str(why)));
            return false;
        }
        if (line.seq != seq) {
            diag("narration", m("kind", str("stale-end")), m("why", str(why)));
            return false;
        }
        if (state.advancedSpeakSeq != null && state.advancedSpeakSeq == seq) {
            diag("narration", m("kind", str("duplicate-end")), m("why", str(why)));
            return false;
        }
        state.advancedSpeakSeq = seq;
        if (why.equals("finished")) line.finished = true;
        stopNarrationTicker();
        diag("narration", m("kind", str("ended")), m("why", str(why)));
        // Grace at narration end: the synthesiser has stopped rendering and the next item is not
        // audible yet.
        if (state.backgrounded && state.isRunning()) beginGrace(GraceReason.NARRATION_HANDOVER);
        itemEnded();
        return true;
    }

    /** {@code _pauseNarration}: hold the line at a word; its clock freezes. Idempotent, because the reducer is not. */
    private void pauseNarration() {
        SpokenLine line = state.narration;
        if (narrationStopping || line == null || line.paused) return;
        line.paused = true;
        line.pausedAtMono = now.monoMs();
        stopNarrationTicker();
        out.add(new EngineCommand.Narration(new NarrationCommand.Pause(line.seq)));
    }

    /**
     * The synthesiser's answer to {@code resume(seq)}: the clock continues from where it froze,
     * restarts with a line re-spoken from its first word, or (refused) stays frozen with the
     * line paused, so the next play tries the resume again.
     */
    private void narrationResumed(int seq, NarrationResumeAnswer answer) {
        SpokenLine line = state.narration;
        if (line == null || line.seq != seq || !line.paused) {
            diag("narration", m("kind", str("resume-stale")), m("seq", num(seq)));
            return;
        }
        switch (answer) {
            case NarrationResumeAnswer.Refused r -> {
                diag("narration", m("kind", str("resume-refused")));
                if (state.grace != null) endGrace(GraceOutcome.NOT_RUNNING);
                return;
            }
            case NarrationResumeAnswer.FromStart f -> line.startedAtMono = now.monoMs();
            case NarrationResumeAnswer.Continued c -> line.startedAtMono += frozenFor(line);
            case NarrationResumeAnswer.NoAnswer n -> line.startedAtMono += frozenFor(line);
        }
        line.paused = false;
        line.pausedAtMono = null;
        startNarrationTicker();
        if (state.grace != null) endGrace(GraceOutcome.PLAYING);
    }

    private double frozenFor(SpokenLine line) {
        return line.pausedAtMono == null ? 0 : Math.max(0, now.monoMs() - line.pausedAtMono);
    }

    /** {@code _stopNarration}: silence the line at once. The line stays the playhead; its clock is no longer paused. */
    private void stopNarration() {
        SpokenLine line = state.narration;
        if (line == null) return;
        line.paused = false;
        line.pausedAtMono = null;
        stopNarrationTicker();
        out.add(new EngineCommand.Narration(new NarrationCommand.Stop(line.seq)));
    }

    /** {@code _startNarrationTicker}: one pulse {@code NARRATION_TICK_MS} out, re-armed by each pulse, only while a surface listens. */
    private void startNarrationTicker() {
        stopNarrationTicker();
        SpokenLine line = state.narration;
        if (!config.narrationPulse() || line == null) return;
        double afterMs = EngineConstants.QueueManager.NARRATION_TICK_MS;
        line.tickDueAtMono = now.monoMs() + afterMs;
        state.narrationTickArmed = true;
        out.add(new EngineCommand.TimerArm(EngineTimer.NARRATION_TICK, afterMs, false));
    }

    private void stopNarrationTicker() {
        if (!state.narrationTickArmed) return;
        state.narrationTickArmed = false;
        out.add(new EngineCommand.TimerCancel(EngineTimer.NARRATION_TICK));
    }

    /**
     * {@code _tickNarration}. The pulse repaints the surface. A pulse that lands
     * {@code NARRATION_SUSPEND_GAP_MS} late means the process was SUSPENDED: the slept time never
     * counts towards the deadline and the synthesiser is asked. Past the deadline the line is
     * finished, once, through the same guards; a pulse that cannot advance keeps the ticker alive.
     */
    private void narrationTick() {
        SpokenLine line = state.narration;
        if (line == null) return;
        double late = line.tickDueAtMono == null ? 0 : now.monoMs() - line.tickDueAtMono;
        out.add(new EngineCommand.NarrationPulse(line.elapsedSec(now.monoMs())));
        if (late > EngineConstants.QueueManager.NARRATION_SUSPEND_GAP_MS) {
            diag("narration", m("kind", str("suspended")), m("lateMs", num(roundHalfAwayFromZero(late))));
            line.startedAtMono += late;
            startNarrationTicker();
            reconcileNarrationInterrupted("narration.suspended");
            return;
        }
        double deadline = narrationDeadlineSec(state.currentItem(), utteranceRate());
        if (deadline > 0 && line.elapsedSec(now.monoMs()) > deadline) {
            diag("narration", m("kind", str("deadline")), m("limitSec", num(roundHalfAwayFromZero(deadline))));
            if (finishLine(line.seq, "deadline")) return;
            SpokenLine current = state.narration;
            if (current == null || (state.advancedSpeakSeq != null && state.advancedSpeakSeq == current.seq)) return;
        }
        startNarrationTicker();
    }

    /**
     * {@code narrationDeadlineSec(item, rate)}: the line's runtime at the speed it is SPOKEN at
     * (stretched only when slower than 1x) times {@code NARRATION_DEADLINE_FACTOR}, plus the
     * margin. Zero (no deadline) for a line that carries no runtime.
     */
    public static double narrationDeadlineSec(EngineItem item, double rate) {
        Double runtime = item == null ? null : item.durationSec;
        if (runtime == null || !Double.isFinite(runtime) || !(runtime > 0)) return 0;
        double slow = Double.isFinite(rate) && rate > 0 && rate < 1 ? 1 / rate : 1;
        return runtime * slow * EngineConstants.QueueManager.NARRATION_DEADLINE_FACTOR
                + EngineConstants.QueueManager.NARRATION_DEADLINE_MARGIN_SEC;
    }

    /**
     * {@code _reconcileNarrationInterrupted}: there is no element to ask, so the SYNTHESISER is
     * asked. Still speaking: nothing is touched. Anything else is the session taken from under
     * the line: {@code interrupted}, the clock frozen by the pause, never an advance.
     */
    private void reconcileNarrationInterrupted(String why) {
        if (now.narrator() == NarratorReading.SPEAKING) {
            diag("reconcile", m("kind", str("skipped-narration-speaking")), m("why", str(why)));
            return;
        }
        if (!state.isPlaying()) return;
        diag("reconcile", m("kind", str("narration-interrupted")), m("why", str(why)), m("tts", str(now.narrator().token)));
        stopRow(StopCause.SYSTEM_PAUSE, null);
        state.pausedByListener = false;
        cutSeamGap("reconcile");
        dispatch(PlayerEvent.INTERRUPTION_BEGAN);
        releaseSeamGap();
    }

    // ---- the interlude jingle (queue-manager.js §13)

    /**
     * {@code _armInterlude(from, to)}: at the same instant as the beat and after it, start the
     * jingle and stretch the deadline to its ceiling, so the jingle ABSORBS the next segment's
     * load. The rule is {@link Interlude#eligible}; the clock is the beat's.
     */
    private void armInterlude(EngineItem from, EngineItem to) {
        if (!config.forayTapeEnabled() || !config.interludeAvailable() || !state.interludeEnabled || to == null) return;
        if (!Interlude.eligible(from == null ? null : from.forayItem().interlude(), to.forayItem().interlude())) {
            diag("interlude", m("kind", str("skipped")));
            return;
        }
        // The audible-start invariant: nothing sounds without the session.
        if (state.session != SessionPolicy.Phase.ACTIVE) {
            diag("fault", m("kind", str("no-session")), m("at", str("interlude")));
            return;
        }
        out.add(new EngineCommand.Interlude(InterludeCommand.START));
        state.inInterlude = true;
        state.beatUntilMono = state.gapUntilMono;
        setGapDeadline(Math.max(state.gapUntilMono != null ? state.gapUntilMono : 0, now.monoMs() + Interlude.CEILING_SEC * 1000));
        diag("interlude", m("kind", str("started")));
    }

    /**
     * {@code _onInterludeEnded(reason)}: shrink the seam back to the beat's own deadline. A wait
     * parked on the ceiling finishes now if the beat is spent, or is re-timed to what the beat
     * still owes; a load not yet landed just holds the remainder when it does.
     */
    private void onInterlude(InterludeEvent event) {
        switch (event) {
            case InterludeEvent.Ended e -> {
                if (!state.inInterlude) {
                    diag("interlude", m("kind", str("stray-end")));
                    return;
                }
                state.inInterlude = false;
                Double beatUntil = state.beatUntilMono;
                state.beatUntilMono = null;
                diag("interlude", m("kind", str("ended")), m("why", str(isDiagToken(e.reason()) ? e.reason() : "other")));
                double remaining = beatUntil == null ? 0 : Math.max(0, beatUntil - now.monoMs());
                if (state.gapParkedToken != null && !state.gapCut) {
                    if (state.seamTimerArmed) {
                        state.seamTimerArmed = false;
                        out.add(new EngineCommand.TimerCancel(EngineTimer.SEAM_BEAT));
                    }
                    if (remaining <= 0) {
                        finishSeamGap();
                        return;
                    }
                    setGapDeadline(beatUntil);
                    state.seamTimerArmed = true;
                    out.add(new EngineCommand.TimerArm(EngineTimer.SEAM_BEAT, remaining, false));
                    return;
                }
                if (state.gapCut) return; // parked; `releaseSeamGap` owns it
                setGapDeadline(remaining > 0 ? beatUntil : null);
            }
        }
    }

    /** {@code _stopInterlude(why)}: silence a sounding jingle without reporting an end. Idempotent. */
    private void stopInterlude(String why) {
        if (!state.inInterlude) return;
        state.inInterlude = false;
        state.beatUntilMono = null;
        out.add(new EngineCommand.Interlude(InterludeCommand.STOP));
        diag("interlude", m("kind", str("cut")), m("why", str(why)));
    }

    // ---- the silence node (flagged OFF)

    /**
     * Digital silence across a silent seam, so the process keeps rendering while the next load
     * happens. Hard-capped at {@code INTERLUDE_CEILING_SEC} from the out-point.
     */
    private void startSilence() {
        if (!config.forayTapeEnabled() || !config.silenceNodeEnabled() || state.silenceActive || !state.inSeamGap()
                || state.inInterlude) {
            return;
        }
        double sec = Interlude.silenceNodeSec(0.0, state.isRunning(), state.session == SessionPolicy.Phase.ACTIVE);
        if (!(sec > 0)) {
            diag("silence", m("kind", str("refused")));
            return;
        }
        state.silenceActive = true;
        out.add(new EngineCommand.SilenceStart(sec * 1000));
        out.add(new EngineCommand.TimerArm(EngineTimer.SILENCE_CAP, sec * 1000, false));
    }

    private void stopSilence(String why) {
        if (!state.silenceActive) return;
        state.silenceActive = false;
        out.add(new EngineCommand.TimerCancel(EngineTimer.SILENCE_CAP));
        out.add(EngineCommand.SILENCE_STOP);
        diag("silence", m("kind", str("stopped")), m("why", str(why)));
    }

    // ---- teardown (the page's `dispose()`)

    /**
     * The engine itself goes away: the line is stopped, the beat's clock and the jingle are cut,
     * the parked wait is DROPPED (never released: nothing may start after this), the deck and the
     * jingle player are released, every timer and grace span ends, and the core answers nothing
     * more. The reducer's state is left as it was.
     */
    private void teardown() {
        if (state.narration != null) stopNarration();
        cutSeamGap("dispose");
        state.gapParkedToken = null;
        state.gapCut = false;
        state.pendingLoad = null;
        state.pendingActivation = null;
        deckCommand(DeckCommand.UNLOAD);
        if (config.forayTapeEnabled() && config.interludeAvailable()) out.add(new EngineCommand.Interlude(InterludeCommand.RELEASE));
        if (state.positionTimerArmed) {
            state.positionTimerArmed = false;
            out.add(new EngineCommand.TimerCancel(EngineTimer.POSITION_TICK));
        }
        cancelHoldTimer();
        if (state.grace != null) endGrace(GraceOutcome.RELINQUISHED);
        diag("mode", m("kind", str("teardown")));
        state.tornDown = true;
    }

    // ---- cp_foray (client.js `persistForayProgress`)

    /**
     * The Foray's resume row. {@code force} is the set of moments a resume point becomes the
     * thing read back next time (a pause, a close, the app leaving the foreground); otherwise it
     * is the position tick, throttled to one write per 5 s of Foray clock. An unknown playhead
     * writes NOTHING: an unknown position must never overwrite a known one.
     */
    private void persistForay(boolean force) {
        if (!forayTransport()) return;
        String forayId = state.forayId;
        EngineItem item = state.currentItem();
        if (forayId == null || item == null || state.stateType().equals("ended") || !item.id.equals(state.loadedId)) return;
        Double elapsed = forayPositionSec(item);
        String stamp = Rows.timestamp(now.wallMs());
        if (elapsed == null || stamp == null) return;
        List<ForayItem> items = forayItems();
        List<Double> starts = ForayClock.segmentStarts(items);
        double start = state.currentIndex >= 0 && state.currentIndex < starts.size() ? starts.get(state.currentIndex) : 0;
        Rows.ForayProgressInput input = new Rows.ForayProgressInput(forayId, state.forayTitle, elapsed,
                ForayClock.forayRuntimeSec(items), (double) state.currentIndex, string(item.node.get("segment_id")),
                Math.max(0, elapsed - start));
        Rows.StoredRow row = state.forayThrottle.due(input, force, stamp);
        if (row == null) return;
        out.add(new EngineCommand.WriteRow(row));
        state.forayThrottle.recorded(forayId, elapsed, true);
    }

    /** Reaching the end MARKS the row finished, once: a finished Foray says "Played", never "0 min left". */
    private void markForayFinished() {
        if (!forayTransport() || state.forayFinishedWritten || state.forayId == null || state.queue.isEmpty()) return;
        String stamp = Rows.timestamp(now.wallMs());
        if (stamp == null) return;
        EngineItem last = state.queue.get(state.queue.size() - 1);
        List<ForayItem> items = forayItems();
        double total = ForayClock.forayRuntimeSec(items);
        Rows.ForayProgressInput input = new Rows.ForayProgressInput(state.forayId, state.forayTitle, total, total,
                (double) (state.queue.size() - 1), string(last.node.get("segment_id")), ForayClock.itemRuntimeSec(last.forayItem()));
        Rows.StoredRow row = state.forayThrottle.due(input, true, stamp);
        if (row == null) return;
        out.add(new EngineCommand.WriteRow(row));
        state.forayThrottle.recorded(state.forayId, total, true);
        state.forayFinishedWritten = true;
    }

    // ---- queue lookups

    /** {@code _cursor()}: the in-flight skip target if one is pending, else what is loaded. */
    private int cursor() {
        return state.targetIndex != null ? state.targetIndex : state.currentIndex;
    }

    /** A queue position and its item. */
    private record Next(int index, EngineItem item) {}

    /** {@code _nextItem(from, skipBridges)}. */
    private Next nextItem(int from, boolean skipBridges) {
        for (int index = from + 1; index < state.queue.size(); index++) {
            EngineItem item = state.queue.get(index);
            if (skipBridges && item.kind == PlayerItemKind.TTS) continue;
            return new Next(index, item);
        }
        return null;
    }

    private EngineItem find(String id) {
        for (EngineItem item : state.queue) if (item.id.equals(id)) return item;
        return null;
    }

    private int indexOf(String id) {
        for (int i = 0; i < state.queue.size(); i++) if (state.queue.get(i).id.equals(id)) return i;
        return -1;
    }

    // ---- small helpers

    /**
     * The offsets one transport action arms for the load it causes, spent by that load
     * ({@code _forceNextOffset}, {@code _startOffsetNext}, {@code _rewindNextResume}). A turn
     * is synchronous, so an offset can never leak into another action's load.
     */
    private record LoadOffsets(Double forced, Double explicit, boolean rewind) {
        static final LoadOffsets NONE = new LoadOffsets(null, null, false);

        static LoadOffsets forcedAt(double seconds) {
            return new LoadOffsets(seconds, null, false);
        }

        static LoadOffsets explicitAt(Double seconds) {
            return new LoadOffsets(null, seconds, false);
        }

        static LoadOffsets rewinding(boolean rewind) {
            return new LoadOffsets(null, null, rewind);
        }
    }

    /** DiagGate {@code isToken}: 1..64 of {@code [0-9A-Za-z._:-]}, the shape a free token must have to be a row's value. */
    static boolean isDiagToken(String text) {
        if (text == null || text.isEmpty() || text.codePointCount(0, text.length()) > DIAG_TOKEN_MAX) return false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '_'
                    || c == ':' || c == '-';
            if (!ok) return false;
        }
        return true;
    }

    /** Swift's {@code rounded()}: to nearest, a tie away from zero. */
    static double roundHalfAwayFromZero(double x) {
        if (Double.isNaN(x) || Double.isInfinite(x)) return x;
        double magnitude = Math.abs(x);
        double down = Math.floor(magnitude);
        double result = magnitude - down >= 0.5 ? down + 1 : down;
        return Math.copySign(result, x);
    }

    private static List<JsonNode.Member> concat(List<JsonNode.Member> a, List<JsonNode.Member> b) {
        List<JsonNode.Member> all = new ArrayList<>(a);
        all.addAll(b);
        return all;
    }

    private static JsonNode.Member m(String key, JsonNode value) {
        return JsonNode.member(key, value);
    }

    private static JsonNode str(String value) {
        return JsonNode.str(value);
    }

    private static JsonNode num(double value) {
        return JsonNode.num(value);
    }

    private static String string(JsonNode value) {
        return value == null ? null : value.stringValue();
    }
}

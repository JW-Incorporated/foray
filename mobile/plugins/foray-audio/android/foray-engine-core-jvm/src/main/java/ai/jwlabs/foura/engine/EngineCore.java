package ai.jwlabs.foura.engine;

import ai.jwlabs.foura.engine.EngineCommand.AdvanceEntry;
import ai.jwlabs.foura.engine.EngineCommand.DiagEntry;
import ai.jwlabs.foura.engine.EngineCommand.GraceOutcome;
import ai.jwlabs.foura.engine.EngineCommand.GraceReason;
import ai.jwlabs.foura.engine.EngineCommand.PendingEvent;
import ai.jwlabs.foura.engine.EngineContract.Refusal;
import ai.jwlabs.foura.engine.EngineInput.LifecycleEvent;
import ai.jwlabs.foura.engine.EngineInput.QueueInput;
import ai.jwlabs.foura.engine.EngineInput.RemotePress;
import ai.jwlabs.foura.engine.EngineInput.RouteChange;
import ai.jwlabs.foura.engine.EngineInput.SessionEvent;
import ai.jwlabs.foura.engine.EngineInput.SessionResult;
import ai.jwlabs.foura.engine.EngineState.DeferredIntent;
import ai.jwlabs.foura.engine.EngineState.PendingActivation;
import ai.jwlabs.foura.engine.EngineState.PendingLoad;
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
 * THE ENGINE'S FUNCTIONAL CORE for episodes (card A-24; docs/native-engine-plan.md §4.2):
 * {@code handle(input, now) -> [EngineCommand]}, pure, on one owned state. The JVM twin of
 * {@code EngineCore} in ForayEngineCore (Engine/EngineCore.swift, NE-14s), and like it the
 * port of {@code PlayerQueueManager} (player/queue-manager.js) around the reducer A-23
 * brought to parity, with the three things the web manager does not own and the native
 * engine does: the audio session ({@link SessionPolicy}), grace spans, and the deck as a
 * request and a response instead of a promise. The {@code manager-episode} fixtures the
 * JS records are its contract: the same steps, driven through this core by the JVM
 * scenario driver, must produce the same op log.
 *
 * <p>THE EPISODE SUBSET, AND WHERE THE REST GOES. The Swift core carries the Foray tape
 * (the seam beat, ADR-0007's load-time ladder, rendered bridges, {@code cp_foray}) behind
 * {@code forayTapeEnabled}, and the narrating overlay and the jingle beside it. With the
 * tape OFF every one of those paths is a no-op or unreachable, and that is exactly the
 * core ported here: A-40 adds the tape and A-41 the overlay, each at the call sites the
 * Swift core names ({@code cutSeamGap} / {@code releaseSeamGap} around every transport
 * action, {@code persistForay} at a pause, the bridge and spoken-line branches of
 * {@code load}, {@code onReady} and {@code onLoadFailure}). Rebuilding a core from the
 * restore record is A-27's.
 *
 * <p>WHY IT IS SYNCHRONOUS WHERE THE JS AWAITS. An effect that has to wait (a load) is a
 * command now and an input later ({@code ready(token)}), and everything else in a turn
 * happens in order, with nothing interleaved.
 *
 * <p>THE AUDIBLE-START INVARIANT (plan §4.4) is structural: every play-ish intent goes
 * through {@code begin}, which asks {@link SessionPolicy}; an intent that needs the
 * session emits {@code sessionActivate} and PARKS until the host feeds the answer back in
 * the same turn, so a failed activation ends in {@code commandFailed} with nothing
 * audible. {@code startPlayback} refuses outright without an active session, as the
 * backstop the {@code session-invariant} rule checks every scenario turn against.
 *
 * <p>A relinquished or torn-down core is terminal: {@link #handle} returns nothing.
 *
 * <p>NOT THREAD-SAFE, BY DESIGN: the host feeds it on one thread, as iOS feeds it on main.
 */
public final class EngineCore {
    /** Plan §4.3: an uncommanded pause within this long of a route going away (either order) is the route's. */
    public static final double ROUTE_ATTRIBUTION_MS = 500;
    /**
     * P-14, the stall display (plan §4.3; #866): the surface shows {@code buffering} from the
     * moment the deck reports waiting (a {@code deck kind=time-control status=waiting} row) until
     * it reports playing again, with no debounce. PROVISIONAL (card NE-38), and Swift's
     * {@code EngineCore.bufferingWhileWaiting} knob, which this mirrors so a verdict that flips
     * one platform flips both (code-health-3 R3-07); false would show a stall as playing.
     */
    public static final boolean BUFFERING_WHILE_WAITING = true; // MEASURE: verdict=rate-latch (NE-38e). Rows: deck kind=time-control status=waiting reason=, nowplaying via=rate.
    /** {@code REMOTE_DUPLICATE_WINDOW_MS}: a second press of the same command inside it is recorded as {@code dupCandidate}. */
    public static final double REMOTE_DUPLICATE_WINDOW_MS = 500;
    /** The {@code pendingEvents} log is bounded (plan §5.5): a page that never attaches must not grow it without limit. */
    public static final int PENDING_EVENTS_CAP = 512;
    /** Walked hops the page has not acked; the chain the page sends is K = 8 long. */
    public static final int ADVANCE_LOG_CAP = 64;

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

    public EngineCore(EngineConfig config, Map<String, ResumeRules.StoredPosition> positions) {
        this.config = Objects.requireNonNull(config, "config");
        state = new EngineState();
        state.holdPolicy = config.holdPolicy();
        state.rate = PlaybackRate.normalize(config.rate());
        state.positions = new HashMap<>(positions);
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
     * {@code canNext} (plan §5.5): the queue has a next item (a narration line counts,
     * NE-39n: Next lands on it), or the continuation chain is non-empty, REGARDLESS of
     * {@code autoAdvance}. A Foray never chains.
     */
    public boolean canNext() {
        return nextItem(cursor(), false) != null || (state.forayId == null && !state.chain.isEmpty());
    }

    /** Previous restarts the item in place, so it exists whenever one does. */
    public boolean canPrevious() {
        return state.currentItem() != null;
    }

    /**
     * The Snapshot v1 fields (plan §5.3) that decide which remote commands work, fed to
     * {@link MediaMapping#commandAvailability}. {@code mode} is {@code none} when nothing is
     * current or the listener closed the player.
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

    /**
     * {@code mediaSessionView}'s input for the current EPISODE, as the page's
     * {@code episodeMediaView} gathers it (player/client.js), or null when there is nothing
     * to show. The playhead and duration are the deck's while it holds this item, else the
     * position the next play will start from; {@code playing} is the transport running, and
     * a load in flight is {@code buffering}. The Foray view is A-40's.
     */
    public MediaMapping.View mediaView(DeckReading reading) {
        EngineItem item = state.currentItem();
        if (state.closed || item == null) return null;
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
        view.item = new MediaMapping.Item(string(item.node.get("kind")), string(item.node.get("title")),
                string(item.node.get("show")));
        view.showArtworkUrl = string(item.node.get("artwork_url"));
        view.durationSec = duration;
        view.positionSec = position;
        view.playbackRate = state.rate;
        view.buffering = state.buffering || loading;
        view.playing = state.isRunning();
        view.inSeamGap = false;
        view.ended = state.stateType().equals("ended");
        view.foray = false;
        return view;
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
                state.lastEpisodeRow = c.lastEpisodeRow();
                state.lastEpisodeRowWritten = false;
                state.startingHop = null;
                playIndex(0, c.startSec(), source);
            }
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
            case EngineContract.Command.SeekBy c -> seekBy(c.deltaSec(), source);
            case EngineContract.Command.SeekTo c -> seekTo(c.sec(), source);
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
            // Whether the page is looking is the host bridge's; nothing in the core reads it (CH3-23, R4-07).
            case EngineContract.Command.SetPageVisible c -> {}
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
            case QueueInput.PlayIndex q -> playIndex(q.index(), q.startSec(), q.source());
            case QueueInput.SetRate q -> setRate(q.rate());
            // The manager's own `seek`: straight to the reducer, which holds it for a load in
            // flight and refuses it with nothing loaded.
            case QueueInput.Seek q -> dispatch(new PlayerEvent.Seek(q.sec(), q.precise()));
        }
    }

    // ---- transport

    private void playIndex(int index, Double startSec, Source source) {
        if (index < 0 || index >= state.queue.size()) {
            refuse(Refusal.NOT_LOADED);
            return;
        }
        begin(new DeferredIntent.PlayIndex(index, startSec), source);
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
        if (state.isRunning()) {
            dispatch(new PlayerEvent.Play(item.ref()));
        } else {
            begin(DeferredIntent.RESUME, source);
        }
    }

    /**
     * {@code pause()}. THE POSTCONDITION IS SILENCE (#689 report 3): the reducer's
     * {@code interruptionBegan} is idempotent and emits no pause from {@code interrupted}, so
     * a deck audible while the machine says paused is paused here, by the deck's own word.
     */
    private void pause(Source source) {
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

    /**
     * Next: the queue's next item, a narration line included (NE-39n, ported here with the
     * Next half of A-64), else the first continuation hop. The JS reference is
     * queue-manager.js {@code _skipToNext}; from a clip whose next item is a line, Next lands
     * on the line; from a line, on the item after it.
     */
    private void next(Source source) {
        if (nextItem(cursor(), false) != null) {
            begin(DeferredIntent.SKIP_NEXT, source);
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
     * {@code previousHop} is the page's call and arrives as a playEpisode. The Foray clock's
     * "the clip before" is A-40's.
     */
    private void previous(Source source) {
        if (state.currentItem() == null) {
            refuse(Refusal.NO_PREVIOUS);
            return;
        }
        begin(DeferredIntent.SKIP_PREVIOUS, source);
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
        dispatch(new PlayerEvent.Seek(target, false));
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
        state.pausedByListener = true;
        stopRow(persist ? StopCause.CLOSE : StopCause.DATA_DELETION, source);
        // CLOSING IS A FLUSH (audit round 2, player-3): the reducer's stop saves nothing, so
        // the playhead is written first. A data deletion writes nothing.
        if (persist) flushPosition();
        state.closed = true;
        suppressSave = !persist;
        dispatch(PlayerEvent.STOP);
        suppressSave = false;
        // THE POSTCONDITION OF STOP IS SILENCE TOO (audit round 3, player-core-7; Swift
        // `stop(persist:)`, code-health-3 R3-02): from `interrupted` or `loadingItem` the
        // reducer's stop emits no pause, because it believes nothing is audible, and in the #689
        // drift the deck is. `pause()`'s rule, by the deck's own word, never the reverse.
        if (audibleNow()) {
            diag("pause", m("kind", str("forced")), m("why", str("the deck was audible while the machine said stopped")));
            deckCommand(DeckCommand.PAUSE);
        }
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
    }

    /**
     * {@code setRate(rate)}: snapped onto the ladder, remembered, and handed to the deck at
     * once (it holds it and re-applies it on every play). A snapped value says so.
     */
    private void setRate(Double requested) {
        PlaybackRate.Snap snap = PlaybackRate.snap(requested);
        if (snap.snapped()) {
            diag("rate", m("kind", str("snapped")), m("requested", Rows.finiteOrNull(requested)),
                    m("applied", num(snap.applied())));
        }
        state.rate = snap.applied();
        deckCommand(new DeckCommand.SetRate(snap.applied()));
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
        stopRow(StopCause.RELINQUISH, source);
        if (state.isRunning()) {
            state.pausedByListener = true;
            dispatch(PlayerEvent.INTERRUPTION_BEGAN);
        } else {
            persistPosition();
        }
        if (audibleNow()) deckCommand(DeckCommand.PAUSE);
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
                // THE STEP IS OURS (code-health-3 CH3-20, R3-08): a skip's interval on the press is the head
                // unit's, and no host forwards it (EnginePlayer's seekBack/seekForward send none), so the step
                // is always SeekSteps, the JS rule and Swift's. Pinned by native-episode/*-head-units-interval*.
                case SKIP_FORWARD -> seekBy(steps.forwardSec(), Source.REMOTE);
                case SKIP_BACKWARD -> seekBy(-steps.backwardSec(), Source.REMOTE);
                case CHANGE_PLAYBACK_POSITION -> {
                    if (press.value() == null) {
                        refuse(Refusal.NOT_LOADED);
                    } else {
                        seekTo(press.value(), Source.REMOTE);
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
     * backgrounded, an interruption resume, a cold play, and a continuation hop loading in the
     * background. (Swift's route resume is A-61's to port, with {@code RouteResume}.)
     */
    private GraceReason graceReason(DeferredIntent intent, Source source) {
        return switch (intent) {
            case DeferredIntent.InterruptionResume i -> GraceReason.INTERRUPTION_RESUME;
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
            return;
        }
        state.activatedInProcess = true;
        cancelHoldTimer();
        run(parked.intent(), parked.source());
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
                // The next item, a line included (NE-39n; `next(source)`).
                Next next = nextItem(cursor(), false);
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
                // "Restart" must mean zero, or the save the reducer emits first would make the
                // reload resume exactly where the press left. From idle (a failed load) or
                // ended the reducer has no item in focus, so name the item this engine holds
                // and it takes its fresh-play branch (player-core-1; fixture
                // manager-episode/previous-after-a-failed-load-reloads-the-clip).
                if (state.player instanceof PlayerQueueState.Idle || state.player instanceof PlayerQueueState.Ended) {
                    EngineItem held = state.currentItem();
                    if (held == null) return;
                    dispatch(new PlayerEvent.SkipToPrevious(held.ref()), LoadOffsets.forcedAt(0));
                } else {
                    dispatch(new PlayerEvent.SkipToPrevious(null), LoadOffsets.forcedAt(0));
                }
            }
            case DeferredIntent.InterruptionResume i -> dispatch(new PlayerEvent.InterruptionEnded(true), LoadOffsets.rewinding(true));
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
            case PlayerEffect.PausePlayback e -> deckCommand(DeckCommand.PAUSE);
            case PlayerEffect.SavePosition e -> {
                if (!suppressSave) persistPosition();
            }
            case PlayerEffect.SeekTo e -> deckCommand(new DeckCommand.Seek(e.seconds()));
            case PlayerEffect.SeekRejected e -> diag("seek", m("kind", str("rejected")), m("reason", str(e.reason())));
            case PlayerEffect.SetOutPoint e -> deckCommand(new DeckCommand.SetOutPoint(e.seconds()));
            case PlayerEffect.ResetRateForTTS e -> {
                // Founder ruling D2, 2026-09-28: a RENDERED line plays at the LISTENER's rate; a
                // SPOKEN line has no deck under it. Decided by the item this effect is for.
                EngineItem target = focusItem();
                if (target != null && target.isSynthNarration()) return;
                deckCommand(new DeckCommand.SetRate(state.rate));
            }
            case PlayerEffect.RestoreRate e -> deckCommand(new DeckCommand.SetRate(state.rate));
            // Without the Foray tape every bridge is stepped over the way a bridge that failed to
            // load is: a missing line never stalls the queue (corner case #12). A-40 plays them.
            case PlayerEffect.PlayTransitionTTS e -> advancePastBridgeFailure();
            case PlayerEffect.EmitTelemetry e -> {}
        }
    }

    /**
     * {@code _loadItem(ref)}: where the load starts, decided in the JS order, then one
     * {@code load} with a fresh token. The index moves NOW (after the outgoing save already
     * ran); the loaded id moves only when {@code ready} comes back.
     */
    private void load(QueueItemRef ref, LoadOffsets offsets) {
        load(ref, offsets, null);
    }

    /**
     * {@code url} replaces the item's own {@code audio_url} for this one load: the stream a
     * downloaded copy that will not open falls back to ({@link #fallBackToStream}, CH3-12).
     */
    private void load(QueueItemRef ref, LoadOffsets offsets, String url) {
        EngineItem item = find(ref.id());
        if (item == null) {
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
        String opened = url != null ? url : item.audioUrl;
        state.pendingLoad = new PendingLoad(token, item.id, startSec, opened);
        deckCommand(new DeckCommand.Load(token, item.id, opened, startSec, bounds != null, bounds != null));
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
     * and says so, whatever path got here. A play that did start stamps the page's
     * {@code lastEpisodeRow} (it "actually plays" now) and the restore record.
     */
    private void startPlayback() {
        if (state.session != SessionPolicy.Phase.ACTIVE) {
            diag("fault", m("kind", str("no-session")), m("session", str(state.session.token)));
            out.add(new EngineCommand.CommandFailed(Refusal.SESSION_FAILED_OTHER.token));
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
        state.pendingLoad = null;
        state.loadedId = pending.itemId();
        state.loadedToken = token;
        state.startingHop = null;
        // A new load owns the deck: the last one's stall is not this one's.
        clearStallLatch();
        dispatch(PlayerEvent.ITEM_LOADED);
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
        // CH3-12: a downloaded copy that will not open streams instead.
        if (isPending && fallBackToStream(pending, message, cause)) return;
        String itemId = pending != null ? pending.itemId() : state.loadedId != null ? state.loadedId : "?";
        state.pendingLoad = null;
        stopRow(cause, null);
        if (state.startingHop != null) {
            state.startingHop = null;
            out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("chain-start", message)));
        } else {
            out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("load", message)));
        }
        dispatch(new PlayerEvent.Error("loadItem(" + itemId + ") failed: " + message));
    }

    /**
     * CH3-12 (R4-03; Swift's {@code fallBackToStream}): a DOWNLOADED copy that will not open
     * (the file was removed, or an app update moved it) is loaded again from its stream, at
     * the same second, once. The page sends a downloaded item with the file in
     * {@code audio_url} and the stream kept as {@code source_audio_url}; the page's own
     * fallback cannot run while it sleeps, and the failure can land then (a car press after a
     * cold restore, a hop the engine walked). Only a load that opened a {@code file:} URL falls
     * back, and only onto a non-empty {@code source_audio_url}: the fallback's load opened the
     * stream, so its failure is the caller's stop, as today. Offline is not the core's to
     * know: the stream runs into its own deadline. No stop row (a fallback is not a stop); the
     * page still hears {@code error} code {@code load}, so it marks the download missing. Not
     * a fixture: the JS manager has no such rule (player/parity/exclusions.json), so both cores
     * pin it with identically named unit tests.
     */
    private boolean fallBackToStream(PendingLoad pending, String message, StopCause cause) {
        if (pending.url() == null || !pending.url().startsWith("file:")) return false;
        EngineItem item = find(pending.itemId());
        String stream = item == null ? null : string(item.node.get("source_audio_url"));
        if (stream == null || stream.isEmpty()) return false;
        // `why`, not `cause`: this row is not a stop.
        diag("deck", m("kind", str("stream-fallback")), m("token", num(pending.token())), m("why", str(cause.token)));
        state.pendingLoad = null;
        out.add(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("load", message)));
        load(item.ref(), LoadOffsets.explicitAt(pending.startSec()), stream);
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
     * {@code _handleBackendItemEnded}: resolve what "next" means, then feed exactly one
     * {@code itemEnded}: the queue's next item, or the next continuation hop when
     * {@code autoAdvance} is on, or the end.
     */
    private void itemEnded() {
        // The stall latch belongs to the item that ended.
        clearStallLatch();
        switch (state.player) {
            case PlayerQueueState.Transitioning t -> {
                Next next = nextItem(cursor(), true);
                dispatch(new PlayerEvent.ItemEnded(next == null ? null : next.item().ref(), false));
            }
            case PlayerQueueState.Playing p -> {
                // THE OUT-POINT AND A NATURAL END ARE ONE END: the deck reports either as
                // `ended`, and every transition after it is identical.
                Next next = nextItem(cursor(), false);
                if (next != null) {
                    boolean bridged = next.item().kind == PlayerItemKind.TTS;
                    dispatch(new PlayerEvent.ItemEnded(next.item().ref(), bridged));
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
            if (!audibleNow() || current == null || !current.id.equals(state.loadedId) || !interrupted.item().id().equals(current.id)) {
                return;
            }
            dispatch(PlayerEvent.ELEMENT_RESUMED);
            return;
        }
        if (!(state.player instanceof PlayerQueueState.Playing)) return;
        if (deck.audible) return;
        if (deck.ended) {
            diag("reconcile", m("kind", str("skipped-ended")));
            return;
        }
        stopRow(routeAttributed ? StopCause.ROUTE_CHANGE : StopCause.SYSTEM_PAUSE, null);
        // The OS took the audio; the listener did not press anything.
        state.pausedByListener = false;
        // WHO took it decides whether a should-resume may bring it back: a foreground
        // reconcile finding the deck stopped is the #263 route case, which corner case #13
        // says never resumes by itself.
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
     * pauses, with its cause row first.
     */
    private void onInterruptionBegan(String raw) {
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
        stopRow(StopCause.INTERRUPTION, null);
        // The call explains the deck's uncommanded pause (CH3-02 review; Swift onInterruptionBegan):
        // a route loss after this (an A2DP -> HFP flap inside ROUTE_ATTRIBUTION_MS) lands inside the
        // interruption and is not attributed that pause; the call's should-resume decides.
        state.lastUncommandedPauseAtMono = null;
        applySession(transition);
        dispatch(PlayerEvent.INTERRUPTION_BEGAN);
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
     * a later call; a route reappearing resumes NOTHING, the JS rule ({@code queue-manager.js}
     * {@code routeChanged}). Swift's route policy is {@code RouteResume} (the {@code route-resume}
     * family and RouteResumeTests: a known route resumes only what the route itself paused,
     * never the listener's own pause); the JVM has none until A-61 ports it. The known-car
     * resume this core carried, with no listener-pause guard, was the rule DECISIONS 2026-09-25
     * Q5 deleted (code-health-3 R3-01).
     *
     * <p>ONLY A LOSS THAT PAUSED SOMETHING IS NON-RESUMABLE (CH3-02, R2-02; Swift {@code onRoute},
     * {@code queue-manager.js} {@code routeChanged}): the machine was playing, bridging or loading,
     * or the loss is why the deck already paused (attributed below). A loss inside an OS
     * interruption (a car's A2DP -> HFP -> A2DP flap while a call rings) paused nothing; the call
     * did, and its should-resume decides (code-health-3 founder question 2, default).
     */
    private void onRoute(RouteChange change) {
        diag("session", m("kind", str("route")), m("oldDeviceUnavailable", JsonNode.bool(change.oldDeviceUnavailable())),
                m("port", change.portType() == null ? JsonNode.NULL : str(change.portType())));
        if (change.oldDeviceUnavailable()) {
            state.lastRouteLostAtMono = now.monoMs();
            boolean pausesSomething = state.player instanceof PlayerQueueState.Playing
                    || state.player instanceof PlayerQueueState.Transitioning
                    || state.player instanceof PlayerQueueState.LoadingItem;
            Double paused = state.lastUncommandedPauseAtMono;
            if (paused != null && now.monoMs() - paused >= 0 && now.monoMs() - paused <= ROUTE_ATTRIBUTION_MS) {
                // The deck's pause came first and was reconciled as the system's; the route is why.
                diag("session", m("kind", str("route-attributed")), m("to", str("pause")));
                pausesSomething = true;
            }
            // Non-resumable when it paused something: a later call's should-resume must not undo it.
            if (pausesSomething) state.pausedByRoute = true;
            stopRow(StopCause.ROUTE_CHANGE, null);
            dispatch(new PlayerEvent.RouteChanged(true));
        } else {
            dispatch(new PlayerEvent.RouteChanged(false));
        }
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
            case POSITION_TICK -> persistIfDue();
            case GRACE_EXPIRED -> {
                if (state.grace == null) return;
                // The deterministic outcome (plan §4.4): end the span, say so, and pause, as the
                // listener's own pause would.
                stopRow(StopCause.GRACE_EXPIRED, null);
                endGrace(GraceOutcome.EXPIRED);
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
     * has no resume point worth keeping; an item the deck does not hold has no playhead to
     * write (#689), and one is never fabricated.
     */
    private void persistPosition() {
        EngineItem item = state.currentItem();
        if (item == null || item.bounds() != null) return;
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
     * being terminated writes the playhead NOW, playing or paused. The store writes it
     * synchronously (A-27), so the row is stored before the handler returns.
     */
    private void flushPosition() {
        if (state.currentItem() == null) return;
        persistPosition();
    }

    /** {@code _persistIfDue}: the periodic write, while playing, when the playhead has moved enough. */
    private void persistIfDue() {
        if (!(state.player instanceof PlayerQueueState.Playing)) return;
        EngineItem item = state.currentItem();
        if (item == null || item.bounds() != null || !item.id.equals(state.loadedId)) return;
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

    // ---- teardown (the page's `dispose()`)

    /**
     * The engine itself goes away: the deck is released, every timer and grace span ends, and
     * the core answers nothing more. The reducer's state is left as it was.
     */
    private void teardown() {
        // D-5 (NE-40; Swift `teardown()`, code-health-3 R3-04): the engine going away while it
        // plays is the audio handed back, so the cause is `relinquish`, written first.
        stopRow(StopCause.RELINQUISH, null);
        state.pendingLoad = null;
        state.pendingActivation = null;
        deckCommand(DeckCommand.UNLOAD);
        if (state.positionTimerArmed) {
            state.positionTimerArmed = false;
            out.add(new EngineCommand.TimerCancel(EngineTimer.POSITION_TICK));
        }
        cancelHoldTimer();
        if (state.grace != null) endGrace(GraceOutcome.RELINQUISHED);
        diag("mode", m("kind", str("teardown")));
        state.tornDown = true;
    }

    /** {@code _advancePastBridgeFailure}: the item after the bridge, bridges skipped. */
    private void advancePastBridgeFailure() {
        Next next = nextItem(cursor(), true);
        dispatch(new PlayerEvent.ItemEnded(next == null ? null : next.item().ref(), false));
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

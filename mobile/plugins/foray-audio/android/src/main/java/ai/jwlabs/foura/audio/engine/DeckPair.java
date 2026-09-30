package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckPolicy;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.IntConsumer;

/**
 * THE FORAY TAPE'S SHAPE ON ANDROID (card A-40, docs/plans/android-assessment.md §5.5): two decks,
 * at most one audible, the standby one prepared at the next segment's in-point while the other
 * plays. The JVM twin of the iOS {@code DeckPair} (ForayAudioPlugin/Engine/DeckPair.swift, NE-32),
 * over two {@link ExoDeck}s (two ExoPlayers) in production.
 *
 * <h2>WHY A DECK PAIR AND NOT A CLIPPED PLAYLIST</h2>
 *
 * The card offered both: one ExoPlayer with a gapless playlist of {@code MediaItem}s clipped by
 * {@code ClippingConfiguration}, or two decks. The pair is chosen, and A-62 builds on it:
 * <ul>
 *   <li>THE OUT-POINT STAYS THE ONE A-25 PROVED NEVER EARLY. Each deck is an {@link ExoDeck}, whose
 *       out-point (a {@code PlayerMessage} at the boundary on the PLAYBACK position, and the
 *       watchdog) the {@code outpoint} family and ExoDeckMeasurementTest hold never early. A
 *       clipped playlist would move the stop into {@code ClippingMediaSource}, which is fixed when
 *       the source is built: the core arms the out-point AFTER the load ({@code setOutPoint}), a
 *       rate or a scrub moves it, and changing a clip re-prepares the source and throws its buffer
 *       away.</li>
 *   <li>THE CORE'S CONTRACT IS ALREADY A PAIR'S. The core loads one item at a time with a token
 *       and asks the deck for a {@code prepare} when the playing deck opens the prefetch window;
 *       the {@code prepare} family (and A-4's three handed-over seams) pin exactly this
 *       shape. A playlist would have to translate "load this, now" back into playlist surgery.</li>
 *   <li>THE SAME AS iOS: NE-32's pair, its policy ({@link DeckPolicy#prefetchDecision},
 *       {@link DeckPolicy#warmPromotion}, {@link DeckPolicy#handoverSteps}) and its rows, so a
 *       seam reads the same on both platforms.</li>
 * </ul>
 *
 * <h2>IT SITS BEHIND THE SAME SEAM AS ONE DECK</h2>
 *
 * The core speaks {@link DeckCommand}s to "the deck" and hears {@link DeckEvent}s; the pair routes
 * them:
 * <ul>
 *   <li>{@code prepare(item, url, in-point)} (the core's answer to the playing deck's
 *       {@code prepareWindow}) loads the STANDBY deck through ExoDeck's own readiness-gated
 *       pipeline, paused at the in-point. Its events never reach the core; they only move the warm
 *       load's state and its stage list. Whether to warm at all is
 *       {@link DeckPolicy#prefetchDecision}.</li>
 *   <li>{@code load} at the boundary asks {@link DeckPolicy#warmPromotion}: a warm deck that is
 *       ready, holds the same source at the same in-point, can play now and has not drifted is
 *       PROMOTED by the handover ({@link DeckPolicy#handoverSteps}, in its order), and the core hears
 *       {@code prepared(hit: true)}, the duration and {@code ready} at once. Anything else is a
 *       MISS: the warm load is forgotten, {@code prepared(hit: false)} names the stages it
 *       reached, and the load runs as an ordinary load on the deck that holds the player role.</li>
 *   <li>everything else goes to the deck that holds the player role; a rate goes to BOTH.</li>
 * </ul>
 *
 * <h2>NEVER TWO AUDIBLE, AND ONE FOCUS HOLDER</h2>
 *
 * The roles swap only after the outgoing deck has been paused AND reads not audible; if it still
 * reads audible the handover is refused and the load degrades to an ordinary one. No step of the
 * handover plays: the core's own {@code play} follows the load, after the seam beat. Both players
 * handle audio focus (Media3), so the incoming deck's play requests focus and the paused outgoing
 * one loses it, with no moment in which the app holds none; {@link Config#onActiveChanged} tells
 * the service which player is now the one whose focus changes are the engine's.
 *
 * <h2>STAND-DOWN</h2>
 *
 * An uncommanded pause of the playing deck while a warm load is IN FLIGHT stands warming down for
 * good ({@link DeckPolicy#unexplainedPauseAction}): the one window in which a second player could
 * have taken the output. From then on the pair is one deck with a spare.
 *
 * <p>ONE THREAD: every call on the decks' looper, as every {@link DeckDriving}.
 */
public final class DeckPair implements DeckDriving {
    /** What the pair is configured with. */
    public static final class Config {
        /** The ring's structured rows ({@code prepare} rows). Default: none. */
        public Consumer<EngineCommand.DiagEntry> diag = entry -> {};
        /** Told the index of the deck that holds the player role after every handover. Default: nothing. */
        public IntConsumer onActiveChanged = index -> {};
    }

    /** A load held warm on the standby deck. */
    private static final class WarmLoad {
        DeckPolicy.Warm warm;
        /** The standby deck's own token for it: negative, never one of the core's (which count up from 1). */
        final int token;
        final List<Vocabulary.Stage> stages = new ArrayList<>();
        boolean prerolled;

        WarmLoad(DeckPolicy.Warm warm, int token) {
            this.warm = warm;
            this.token = token;
        }

        /** Not yet ready and not failed: the window {@code unexplainedPauseAction} names. */
        boolean inFlight() {
            return !warm.ready() && !warm.failed();
        }
    }

    /** Bound on {@link #handoverLog()}. */
    private static final int LOG_CAP = 128;

    private final PairableDeck[] decks;
    private final Config config;
    private DeckDriving.Listener listener;
    private int activeIndex = 0;
    /** Whose events reach the core; -1 only inside a handover, between detach-outgoing and attach-incoming. */
    private int forwarding = 0;
    private boolean available = true;
    private double rate = 1;
    private WarmLoad warmLoad;
    private int nextWarmToken = -1;
    private boolean invalidated;
    private int swaps;
    private final List<String> handoverLog = new ArrayList<>();

    public DeckPair(PairableDeck first, PairableDeck second, Config config) {
        decks = new PairableDeck[] {first, second};
        this.config = config == null ? new Config() : config;
        for (int i = 0; i < 2; i++) {
            final int index = i;
            decks[i].setListener(event -> deckEvent(index, event));
        }
        decks[activeIndex].setPrepareWindowAvailable(true);
        decks[1 - activeIndex].setPrepareWindowAvailable(false);
    }

    /** The deck holding the player role (0 or 1). */
    public int activeIndex() {
        return activeIndex;
    }

    /** How many handovers completed. */
    public int swaps() {
        return swaps;
    }

    /** False once warming has stood down (or the pair was invalidated). */
    public boolean available() {
        return available;
    }

    /** Every handover step and every promotion verdict, in order (bounded). */
    public List<String> handoverLog() {
        return Collections.unmodifiableList(new ArrayList<>(handoverLog));
    }

    private int standbyIndex() {
        return 1 - activeIndex;
    }

    @Override
    public void setListener(DeckDriving.Listener listener) {
        this.listener = invalidated ? null : listener;
    }

    /** The deck holding the player role is the one the core reads. */
    @Override
    public DeckReading reading() {
        return decks[activeIndex].reading();
    }

    @Override
    public void send(DeckCommand command) {
        if (invalidated) return;
        switch (command) {
            case DeckCommand.Load c -> load(c);
            case DeckCommand.Prepare c -> prepare(c.itemId(), c.url(), c.startSec());
            case DeckCommand.SetRate c -> {
                // Both decks: the standby primes at the rate it will play at.
                if (c.rate() > 0 && Double.isFinite(c.rate())) rate = c.rate();
                decks[activeIndex].send(command);
                decks[standbyIndex()].send(command);
            }
            case DeckCommand.Unload c -> {
                // The core unloads at a relinquish or a media-services reset: a release, the one
                // discard that frees the warm buffer too.
                decks[activeIndex].send(command);
                if ((warmLoad != null || decks[standbyIndex()].loadedUrl() != null) && DeckPolicy.discardFreesBuffer("release")) {
                    decks[standbyIndex()].send(DeckCommand.UNLOAD);
                }
                warmLoad = null;
            }
            case DeckCommand.Play c -> decks[activeIndex].send(command);
            case DeckCommand.Pause c -> decks[activeIndex].send(command);
            case DeckCommand.Seek c -> decks[activeIndex].send(command);
            case DeckCommand.SetOutPoint c -> decks[activeIndex].send(command);
        }
    }

    @Override
    public void invalidate() {
        if (invalidated) return;
        invalidated = true;
        available = false;
        warmLoad = null;
        listener = null;
        for (PairableDeck deck : decks) {
            deck.setListener(null);
            deck.invalidate();
        }
    }

    // ---- prepare

    private void prepare(String itemId, String url, double startSec) {
        double offset = DeckPolicy.warmOffset(startSec);
        DeckPolicy.PrefetchDecision decision = DeckPolicy.prefetchDecision(available, url, decks[activeIndex].loadedUrl(),
                warmLoad == null ? null : warmLoad.warm, offset);
        row("prefetch", JsonNode.member("decision", JsonNode.str(decision.token)));
        if (decision != DeckPolicy.PrefetchDecision.START || url == null) return;
        // A warm load being replaced is forgotten; the standby's next load replaces its item.
        int token = nextWarmToken;
        nextWarmToken -= 1;
        WarmLoad held = new WarmLoad(new DeckPolicy.Warm(itemId, url, offset, false, false), token);
        held.stages.add(Vocabulary.Stage.ATTACH);
        warmLoad = held;
        PairableDeck standby = decks[standbyIndex()];
        standby.setPrepareWindowAvailable(false);
        standby.send(new DeckCommand.SetRate(rate));
        // Precise timing: a prepared item is the next SEGMENT of a Foray (P-7: precise for bounded
        // segments). A precise source promoted for an approximate ask is never worse.
        standby.send(new DeckCommand.Load(token, itemId, url, offset, true));
    }

    // ---- load: promote or degrade

    private void load(DeckCommand.Load command) {
        WarmLoad held = warmLoad;
        if (held == null) {
            decks[activeIndex].send(command);
            return;
        }
        // At a boundary the warm load is spent either way: promoted, or forgotten.
        warmLoad = null;
        PairableDeck standby = decks[standbyIndex()];
        DeckPolicy.Promotion promotion = DeckPolicy.warmPromotion(held.warm, command.url(), DeckPolicy.warmOffset(command.startSec()),
                standby.isReady(), standby.reading().positionSec);
        log("promotion:" + promotion.token);
        if (promotion == DeckPolicy.Promotion.PROMOTE && handover(command.token())) {
            row("promote", JsonNode.member("token", JsonNode.num(command.token())));
            DeckReading incoming = decks[activeIndex].reading();
            emit(new DeckEvent.Prepared(command.token(), true, held.stages));
            emit(new DeckEvent.DurationLoaded(command.token(), incoming.durationSec));
            emit(new DeckEvent.Ready(command.token(), incoming.positionSec != null ? incoming.positionSec : held.warm.offsetSec(),
                    held.prerolled, 0));
            return;
        }
        row("miss", JsonNode.member("reason", JsonNode.str(promotion == DeckPolicy.Promotion.PROMOTE ? "handover-refused"
                : promotion.token)), JsonNode.member("token", JsonNode.num(command.token())));
        // Only the load of the item that was prepared is described: a skip elsewhere was never a prepare to miss.
        if (held.warm.url().equals(command.url())) emit(new DeckEvent.Prepared(command.token(), false, held.stages));
        decks[activeIndex].send(command);
    }

    /** {@link DeckPolicy#handoverSteps}, in order. False, with the roles unchanged, when the outgoing deck will not confirm paused. */
    private boolean handover(int token) {
        int outgoingIndex = activeIndex;
        PairableDeck outgoing = decks[outgoingIndex];
        PairableDeck incoming = decks[standbyIndex()];
        for (DeckPolicy.HandoverStep step : DeckPolicy.handoverSteps()) {
            switch (step) {
                case DETACH_OUTGOING -> forwarding = -1;
                case PAUSE_OUTGOING -> {
                    // Always commanded: it also ends the outgoing deck's intent to play, so its stop
                    // can never read as an uncommanded pause.
                    outgoing.send(DeckCommand.PAUSE);
                    if (outgoing.reading().audible) {
                        forwarding = outgoingIndex;
                        log("handover:refused-outgoing-audible");
                        return false;
                    }
                }
                case SWAP_ROLES -> activeIndex = standbyIndex();
                case ATTACH_INCOMING -> forwarding = activeIndex;
                case ADOPT_IDENTITY -> incoming.adopt(token);
                // The decks carry no duck (the engine ducks nothing).
                case CARRY_VOLUME -> {}
                case CARRY_RATE -> incoming.send(new DeckCommand.SetRate(rate));
            }
            log("handover:" + step.token);
        }
        outgoing.setPrepareWindowAvailable(false);
        incoming.setPrepareWindowAvailable(available);
        swaps += 1;
        config.onActiveChanged.accept(activeIndex);
        return true;
    }

    // ---- events

    private void deckEvent(int index, DeckEvent event) {
        if (invalidated) return;
        if (index == forwarding) {
            if (event instanceof DeckEvent.PausedUncommanded) {
                DeckPolicy.UnexplainedPause action = DeckPolicy.unexplainedPauseAction(false, false,
                        warmLoad != null && warmLoad.inFlight());
                if (action == DeckPolicy.UnexplainedPause.STAND_DOWN) standDown();
            }
            emit(event);
            return;
        }
        // The standby deck: only its warm load's events count, and none of them reaches the core
        // (the outgoing deck's late events, under the core's old token, are dropped here too).
        WarmLoad held = warmLoad;
        Integer eventToken = DeckEvent.tokenOf(event);
        if (index != standbyIndex() || held == null || eventToken == null || eventToken != held.token) return;
        switch (event) {
            case DeckEvent.DurationLoaded e -> held.stages.add(Vocabulary.Stage.DURATION);
            case DeckEvent.NotReady e -> {
                held.stages.add(Vocabulary.Stage.NOT_READY);
                held.stages.add(e.attempt() < 2 ? Vocabulary.Stage.RETRY : Vocabulary.Stage.ORDINARY_LOAD);
            }
            case DeckEvent.Ready e -> {
                held.stages.add(Vocabulary.Stage.READINESS);
                held.stages.add(Vocabulary.Stage.SEEK);
                if (e.prerolled()) held.stages.add(Vocabulary.Stage.PREROLL);
                held.stages.add(Vocabulary.Stage.READY);
                held.prerolled = e.prerolled();
                // Ready only AT the in-point (never on readiness for the head).
                boolean settled = DeckPolicy.warmSettled(held.warm.offsetSec(), e.landedSec(), true);
                held.warm = new DeckPolicy.Warm(held.warm.itemId(), held.warm.url(), held.warm.offsetSec(), settled, held.warm.failed());
                row(settled ? "warm-ready" : "warm-unsettled", JsonNode.member("prerolled", JsonNode.bool(e.prerolled())));
            }
            case DeckEvent.Failed e -> {
                held.warm = new DeckPolicy.Warm(held.warm.itemId(), held.warm.url(), held.warm.offsetSec(), held.warm.ready(), true);
                row("warm-failed");
            }
            case DeckEvent.DeadlineExceeded e -> {
                held.stages.add(Vocabulary.Stage.DEADLINE);
                held.warm = new DeckPolicy.Warm(held.warm.itemId(), held.warm.url(), held.warm.offsetSec(), held.warm.ready(), true);
                row("warm-deadline");
            }
            default -> {}
        }
    }

    private void standDown() {
        available = false;
        warmLoad = null;
        for (PairableDeck deck : decks) deck.setPrepareWindowAvailable(false);
        row("stand-down");
        log("stand-down");
    }

    // ---- helpers

    private void emit(DeckEvent event) {
        DeckDriving.Listener target = listener;
        if (target != null && !invalidated) target.onEvent(event);
    }

    private void row(String kind, JsonNode.Member... fields) {
        List<JsonNode.Member> members = new ArrayList<>();
        members.add(JsonNode.member("kind", JsonNode.str(kind)));
        Collections.addAll(members, fields);
        config.diag.accept(new EngineCommand.DiagEntry("prepare", members));
    }

    private void log(String entry) {
        handoverLog.add(entry);
        while (handoverLog.size() > LOG_CAP) handoverLog.remove(0);
    }
}

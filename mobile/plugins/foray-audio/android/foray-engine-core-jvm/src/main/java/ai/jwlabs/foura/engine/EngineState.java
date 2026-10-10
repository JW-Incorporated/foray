package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The engine's composite state (docs/native-engine-plan.md §4.2): the six reducer states
 * plus everything the JS manager keeps beside its reducer, as one value. The JVM twin of
 * {@code EngineState} in ForayEngineCore (Engine/EngineState.swift, NE-14s), the episode
 * subset: the Foray tape's fields (the seam beat, the load-time ladder, {@code cp_foray})
 * arrive with A-40 and the narrating overlay's with A-41.
 *
 * <p>Every field the JS manager has is named after it, so the port can be read against
 * {@code player/queue-manager.js} line for line.
 *
 * <p>OWNED BY ONE CORE. Swift's is a value; this is a mutable object that
 * {@link EngineCore} alone writes. {@link EngineCore#state()} hands it out for READING (a
 * test, the parity driver, the host's surface); nothing outside the core may write it.
 */
public final class EngineState {
    /** The reducer: what the transport believes. */
    public PlayerQueueState player = PlayerQueueState.IDLE;

    // ---- the queue, and the loaded/target split

    public List<EngineItem> queue = new ArrayList<>();
    /**
     * {@code currentIndex}: what is LOADED (or being loaded). {@code savePosition} writes
     * against it, so it moves only when a load starts, never at the skip.
     */
    public int currentIndex = -1;
    /**
     * {@code _targetIndex}: where a skip is HEADING before its load starts, so two fast skips
     * advance two items while the outgoing episode's playhead is still saved against the
     * right id. Null when no skip is in flight.
     */
    public Integer targetIndex;
    /** {@code _loadedId}: the item the deck actually HOLDS, set only when its load lands. */
    public String loadedId;
    /** The token of the load the deck holds. */
    public Integer loadedToken;
    /** The load in flight that owns the deck; a {@code ready} for any other token is superseded (corner case #19). */
    public PendingLoad pendingLoad;
    public int lastToken = 0;

    // ---- the audio session (plan §4.4)

    public SessionPolicy.Phase session = SessionPolicy.Phase.INACTIVE;
    public SessionPolicy.HoldPolicy holdPolicy = SessionPolicy.HoldPolicy.DEFAULT;
    /** Whether THIS process activated the session (a stale {@code appWasSuspended} is told apart by it). */
    public boolean activatedInProcess = false;
    /** An intent parked for the activation it asked for, answered in the same turn. */
    public PendingActivation pendingActivation;
    public int lastRequestId = 0;
    public boolean holdTimerArmed = false;

    // ---- who paused, and why (the manager's flags)

    /** {@code _pausedByListener}: the last pause was a press or a stop, so an OS should-resume must not bring it back. */
    public boolean pausedByListener = false;
    /** {@code _pausedByRoute}: a route went away (corner case #13); only a new play clears it (the listener's, or a continuation hop). */
    public boolean pausedByRoute = false;
    /** For the 500 ms route attribution of an uncommanded pause (plan §4.3). */
    public Double lastRouteLostAtMono;
    public Double lastUncommandedPauseAtMono;

    // ---- rate and position

    /** {@code _rate}: the listener's speed, always on the ladder. */
    public double rate = PlaybackRate.DEFAULT_RATE;
    /** A seek written down while nothing is loaded ({@code SEEK.PEND}): the next play's own start. */
    public Double pendingStartSec;
    /** The stored {@code cp_pos:} rows the engine owns, read for a cold resume. */
    public Map<String, ResumeRules.StoredPosition> positions = new HashMap<>();
    /** {@code _lastPersisted}: what the periodic writer measures its delta from. */
    public ResumeRules.LastWrite lastPersisted;
    /** PositionStore's {@code _lastEmitted}: the once-a-minute event mark per item. */
    public Map<String, Double> eventMarks = new HashMap<>();
    public List<EngineCommand.PendingEvent> pendingEvents = new ArrayList<>();
    public int lastEventSeq = 0;
    public boolean positionTimerArmed = false;
    public boolean buffering = false;

    // ---- continuation (plan §5.5)

    public boolean autoAdvance = false;
    public Integer planSeq;
    public List<EngineContract.Hop> chain = new ArrayList<>();
    public EngineContract.Hop previousHop;
    public List<EngineCommand.AdvanceEntry> advanceLog = new ArrayList<>();
    public int lastAdvanceSeq = 0;
    /** The hop whose item is loading now, so a failed start is {@code chain-start}. */
    public EngineContract.Hop startingHop;

    // ---- rows the page reads back

    /** {@code lastEpisodeRow} as the page sent it, stored verbatim plus {@code updated_at} when its item actually plays. */
    public JsonNode lastEpisodeRow;
    public boolean lastEpisodeRowWritten = false;
    /** The Foray being played; always null until the Foray tape (A-40). */
    public String forayId;
    /**
     * The listener closed the player, or deleted their data: the snapshot's {@code mode} is
     * {@code none} from then until something is played or loaded again, the one moment Now
     * Playing clears and every remote command is disabled (plan §4.5).
     */
    public boolean closed = false;

    // ---- preferences the narrating overlay reads (A-41 speaks with them)

    /** {@code _voice}: the listener's narration voice, or null for the synthesiser's own pick. Kept in the restore record. */
    public String voiceId;
    /** {@code _interludeEnabled}: the listener's {@code cp_interlude}. */
    public boolean interludeEnabled = true;

    // ---- the app around the engine

    public boolean backgrounded = false;
    /** The open grace span's reason, from begin to end; null when none is open. */
    public EngineCommand.GraceReason grace;
    /** The last remote press, for {@code dupCandidate} (recorded, never dropped). */
    public LastRemote lastRemote;
    /** {@code _disposed}: the engine was torn down; the core answers nothing more. */
    public boolean tornDown = false;

    /** The item {@code currentIndex} points at, or null. */
    public EngineItem currentItem() {
        return currentIndex >= 0 && currentIndex < queue.size() ? queue.get(currentIndex) : null;
    }

    /** Whether the transport believes something is (or is about to be) audible: playing, loadingItem, transitioning. */
    public boolean isRunning() {
        return player instanceof PlayerQueueState.Playing || player instanceof PlayerQueueState.LoadingItem
                || player instanceof PlayerQueueState.Transitioning;
    }

    /** The reducer says {@code playing}. */
    public boolean isPlaying() {
        return player instanceof PlayerQueueState.Playing;
    }

    /** The reducer state's {@code type}, as the JS names it. */
    public String stateType() {
        return typeName(player);
    }

    public static String typeName(PlayerQueueState state) {
        return switch (state) {
            case PlayerQueueState.Idle s -> "idle";
            case PlayerQueueState.LoadingItem s -> "loadingItem";
            case PlayerQueueState.Playing s -> "playing";
            case PlayerQueueState.Transitioning s -> "transitioning";
            case PlayerQueueState.Interrupted s -> "interrupted";
            case PlayerQueueState.Ended s -> "ended";
        };
    }

    /**
     * A load in flight, and the second it was asked to land on: until the deck holds the
     * item, that is where the listener is (client.js {@code episodePositionSec}'s
     * {@code loadingStart}, audit round 2 p-impatient-1). A rendered bridge and a spoken
     * line load differently; they arrive with A-40 and A-41. {@code url} is the URL this
     * deck load opened: a {@code file:} URL that fails is retried once on the item's stream
     * ({@code fallBackToStream}, CH3-12), whose own load opened the stream, so its failure
     * is the stop.
     */
    public record PendingLoad(int token, String itemId, double startSec, String url) {}

    /** A play-ish intent waiting for its activation's answer. */
    public record PendingActivation(int requestId, DeferredIntent intent, Vocabulary.Source source) {}

    /** What runs once the session is active. */
    public sealed interface DeferredIntent permits DeferredIntent.PlayIndex, DeferredIntent.Resume, DeferredIntent.SkipNext,
            DeferredIntent.SkipPrevious, DeferredIntent.InterruptionResume, DeferredIntent.ColdPlay,
            DeferredIntent.WalkHop, DeferredIntent.Audition {
        record PlayIndex(int index, Double startSec) implements DeferredIntent {}

        record Resume() implements DeferredIntent {}

        record SkipNext() implements DeferredIntent {}

        record SkipPrevious() implements DeferredIntent {}

        record InterruptionResume() implements DeferredIntent {}

        record ColdPlay() implements DeferredIntent {}

        record WalkHop(EngineContract.Hop hop) implements DeferredIntent {}

        record Audition(String text, String voiceId) implements DeferredIntent {}

        DeferredIntent RESUME = new Resume();
        DeferredIntent SKIP_NEXT = new SkipNext();
        DeferredIntent SKIP_PREVIOUS = new SkipPrevious();
        DeferredIntent INTERRUPTION_RESUME = new InterruptionResume();
        DeferredIntent COLD_PLAY = new ColdPlay();
    }

    public record LastRemote(MediaMapping.RemoteCommand command, double atMono) {}
}

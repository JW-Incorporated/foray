package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The engine's composite state (docs/native-engine-plan.md §4.2): the six reducer states
 * plus everything the JS manager keeps beside its reducer, as one value. The JVM twin of
 * {@code EngineState} in ForayEngineCore (Engine/EngineState.swift, NE-14s): the episode
 * fields (A-24), and the Foray tape's (the seam beat, the load-time ladder, {@code cp_foray})
 * and the narrating overlay's and the jingle's (A-40).
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
    /** {@code _pausedByRoute}: a route went away (corner case #13); only a press or a known car route clears it. */
    public boolean pausedByRoute = false;

    // ---- route resume (A-61, the Swift NE-38rs state; player/route-resume.js)

    /**
     * The routes our audio has been heard through (salted SHA-256 keys, least recently used
     * first), seeded from {@code EngineConfig.knownRoutes} and persisted by the host in
     * {@code ForayEngine.knownRoutes} whenever it changes.
     */
    public RouteResume.KnownRoutes knownRoutes = new RouteResume.KnownRoutes();
    /** route-resume.js's reducer: what last paused us, which route was lost and when (wall clock), and whether the engine means to be playing. */
    public RouteResume.State routeResume = new RouteResume.State(false);
    /**
     * The reducer as it was before an uncommanded pause was blamed on the system, so a route loss
     * that follows within the 500 ms attribution window is still the loss of a PLAYING route
     * (plan §4.3: either order).
     */
    public RouteResumeSnapshot routeResumeBeforePause;
    /** The route the deck became audible through, and when: it is known once heard for {@code RouteResume.KNOWN_AFTER_MS}. */
    public HeardRoute heardRoute;
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
    /** The Foray being played (A-40), null for an episode. */
    public String forayId;
    /**
     * The listener closed the player, or deleted their data: the snapshot's {@code mode} is
     * {@code none} from then until something is played or loaded again, the one moment Now
     * Playing clears and every remote command is disabled (plan §4.5).
     */
    public boolean closed = false;

    // ---- the Foray tape (A-40, the Swift NE-30s)

    /**
     * {@code _gapUntil}: the seam beat's ABSOLUTE deadline on the monotonic clock, stamped at the
     * out-point, so the next load runs INSIDE the beat. Non-null exactly while a beat is running.
     */
    public Double gapUntilMono;
    /** When the beat was armed (the out-point) and the gap it asked for, for the packed seam row. */
    public Double gapArmedAtMono;
    public double gapAskedMs = 0;
    /** {@code _gapFinish}: the load whose {@code itemLoaded} waits out the beat's remainder, by its token. */
    public Integer gapParkedToken;
    /** {@code _gapCut}: a transport action cut the beat; the parked wait is released after its own load. */
    public boolean gapCut = false;
    public boolean seamTimerArmed = false;
    /** {@code _forayOptions}: what the load-time ladder reads. */
    public boolean forayIsLocalFile = false;
    public boolean forayAllowAdPad = false;
    /** The Foray's title, for its {@code cp_foray} row and the lock screen. */
    public String forayTitle;
    /** The item the standby deck was last asked to prepare. */
    public String preparedItemId;
    /** The deck pair's report on the load in flight ({@code prepared}), for the packed seam row. */
    public DeckPrepareReport deckPrepare;
    /**
     * A-62 (NE-45s): the seam an item's end crossed, until the next item is audible
     * ({@code EngineCore.packSeamRow}); null between seams and after a transport action cut one.
     */
    public SeamMark seamMark;
    /** Segments ADR-0007's ladder refused at load (the snapshot's {@code skippedSegments}). */
    public int skippedSegments = 0;
    /** The {@code cp_foray} write throttle. */
    public ForayProgressRules.WriteThrottle forayThrottle = new ForayProgressRules.WriteThrottle();
    /** A finished Foray's row is marked once. */
    public boolean forayFinishedWritten = false;

    /** {@code inSeamGap}: a beat is running. */
    public boolean inSeamGap() {
        return gapUntilMono != null;
    }

    // ---- the narrating overlay and the jingle (A-40's core rules; the host's synthesiser is A-41's)

    /** {@code _voice}: the listener's narration voice, or null for the synthesiser's own pick. Kept in the restore record. */
    public String voiceId;
    /** Whether the last line spoke in another voice than asked (V-01); null until one spoke, and after a failed speak. */
    public Boolean lastVoiceFallback;
    /** The spoken line the loaded item IS, from the synthesiser accepting it until a deck item's load lands. */
    public SpokenLine narration;
    /** Section 14: the id of the RENDERED line being spoken from its script because its file failed. */
    public String fallbackSpokenId;
    /** The last utterance {@code seq} stamped ({@code _speakSeq}). */
    public int speakSeq = 0;
    /** {@code _advancedSpeakSeq}: the utterance already advanced past (each line advances at most once). */
    public Integer advancedSpeakSeq;
    public boolean narrationTickArmed = false;
    /** A speed tap that landed while a spoken line was audible (corner case #18); the deck gets it when the line ends. */
    public Double pendingRate;
    /** {@code _interludeEnabled}: the listener's {@code cp_interlude}. */
    public boolean interludeEnabled = true;
    /** {@code _interludeActive}: the jingle is sounding (a subset of {@code inSeamGap}). */
    public boolean inInterlude = false;
    /** {@code _beatUntil}: the BEAT's own deadline while the jingle stretches it. */
    public Double beatUntilMono;
    /** The silence node is running (flagged off). */
    public boolean silenceActive = false;

    /** {@code isNarrationPlayhead}: a spoken line is the playhead. */
    public boolean isNarrationPlayhead() {
        return narration != null;
    }

    // ---- the app around the engine

    public boolean backgrounded = false;
    public boolean pageVisible = true;
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
     * {@code loadingStart}, audit round 2 p-impatient-1).
     *
     * <p>{@code bridge}: a rendered narration bridge, which plays the moment it lands with no
     * {@code itemLoaded}. {@code spokenSeq}: a SPOKEN line, whose {@code started} / {@code failed}
     * for that utterance is this load landing or failing (null for a deck load). {@code fallback}:
     * a rendered line read from its script because its file failed (section 14).
     */
    public record PendingLoad(int token, String itemId, double startSec, boolean bridge, Integer spokenSeq, boolean fallback) {
        public PendingLoad(int token, String itemId, double startSec) {
            this(token, itemId, startSec, false, null, false);
        }
    }

    /**
     * A spoken line the playhead is on: queue-manager.js {@code _loadedIsSynth},
     * {@code _narrationStartedAtMs}, {@code _narrationPaused} and {@code _narrationPausedAtMs}
     * as one value. Its clock is WALL time since the line started, frozen while it is paused
     * and shifted forward by the pause on resume. Mutable; the core alone writes it.
     */
    public static final class SpokenLine {
        public final int seq;
        public final String itemId;
        public double startedAtMono;
        public boolean paused;
        public Double pausedAtMono;
        /** When the pulse armed last was due, to tell a suspended process from a busy one. */
        public Double tickDueAtMono;
        /** The synthesiser said {@code didFinish} for it. */
        public boolean finished;

        public SpokenLine(int seq, String itemId, double startedAtMono) {
            this.seq = seq;
            this.itemId = itemId;
            this.startedAtMono = startedAtMono;
        }

        /** {@code narrationElapsedSec} at {@code monoMs}. */
        public double elapsedSec(double monoMs) {
            double at = paused ? (pausedAtMono != null ? pausedAtMono : monoMs) : monoMs;
            return Math.max(0, (at - startedAtMono) / 1000);
        }
    }

    /** What the deck pair said about one load ({@code prepared}). */
    public record DeckPrepareReport(int token, boolean hit, List<Vocabulary.Stage> stages) {}

    /**
     * A-62 (NE-45s): a seam in flight, from the item's end to the next one's audible start: what it
     * joins, which item it is waiting for, when it began, and the deck pair's verdict on that item's
     * load once there is one (null until then).
     */
    public record SeamMark(SeamRow.ItemKind from, SeamRow.ItemKind to, String toItemId, double endedAtMono, SeamRow.Prepare prepare) {
        public SeamMark withPrepare(SeamRow.Prepare verdict) {
            return new SeamMark(from, to, toItemId, endedAtMono, verdict);
        }
    }

    /** A play-ish intent waiting for its activation's answer. */
    public record PendingActivation(int requestId, DeferredIntent intent, Vocabulary.Source source) {}

    /** What runs once the session is active. */
    public sealed interface DeferredIntent permits DeferredIntent.PlayIndex, DeferredIntent.Resume, DeferredIntent.SkipNext,
            DeferredIntent.SkipPrevious, DeferredIntent.InterruptionResume, DeferredIntent.RouteResume, DeferredIntent.ColdPlay,
            DeferredIntent.WalkHop, DeferredIntent.Audition {
        record PlayIndex(int index, Double startSec) implements DeferredIntent {}

        record Resume() implements DeferredIntent {}

        record SkipNext() implements DeferredIntent {}

        record SkipPrevious() implements DeferredIntent {}

        record InterruptionResume() implements DeferredIntent {}

        record RouteResume() implements DeferredIntent {}

        record ColdPlay() implements DeferredIntent {}

        record WalkHop(EngineContract.Hop hop) implements DeferredIntent {}

        record Audition(String text, String voiceId) implements DeferredIntent {}

        DeferredIntent RESUME = new Resume();
        DeferredIntent SKIP_NEXT = new SkipNext();
        DeferredIntent SKIP_PREVIOUS = new SkipPrevious();
        DeferredIntent INTERRUPTION_RESUME = new InterruptionResume();
        DeferredIntent ROUTE_RESUME = new RouteResume();
        DeferredIntent COLD_PLAY = new ColdPlay();
    }

    public record LastRemote(MediaMapping.RemoteCommand command, double atMono) {}

    /** A-61 (NE-38rs): {@code routeResume} before a system-blamed pause, and when. */
    public record RouteResumeSnapshot(RouteResume.State state, double atMono) {}

    /**
     * A-61 (NE-38rs): the route a playing deck is heard through (its hashed key), from when, and
     * until when if the deck stopped (a pause, a stall, the system).
     */
    public record HeardRoute(String key, double sinceMono, Double untilMono) {
        /** How long it was heard, at {@code monoMs}. */
        public double heardMs(double monoMs) {
            return (untilMono != null ? untilMono : monoMs) - sinceMono;
        }
    }
}

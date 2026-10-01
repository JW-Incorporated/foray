package ai.jwlabs.foura.engine;

/**
 * What the deck observed: raw facts plus the load token, no policy. The JVM twin of
 * {@code DeckEvent} in ForayEngineCore (Engine/DeckVocabulary.swift, NE-14s). Every event
 * carries the token of the load it belongs to, so a superseded load's late callback is
 * recognisably stale.
 *
 * <p>{@code prepareWindow} and {@code prepared} are the deck pair's (A-40): the boundary is the
 * prefetch lead away, and what the standby deck did for a load.
 */
public sealed interface DeckEvent permits DeckEvent.DurationLoaded, DeckEvent.Ready, DeckEvent.NotReady,
        DeckEvent.DeadlineExceeded, DeckEvent.Failed, DeckEvent.Refused, DeckEvent.TimeControl, DeckEvent.PausedUncommanded,
        DeckEvent.Seeked, DeckEvent.Stalled, DeckEvent.Ended, DeckEvent.PrepareWindow, DeckEvent.Prepared {

    /** {@code timeControlStatus} as the core reads it (waiting is buffering). */
    enum TimeControlStatus {
        PAUSED("paused"),
        WAITING("waiting"),
        PLAYING("playing");

        public final String token;

        TimeControlStatus(String token) {
            this.token = token;
        }
    }

    /** The asset's duration loaded (null when indefinite). */
    record DurationLoaded(int token, Double durationSec) implements DeckEvent {}

    /** Seeked with zero tolerance and prerolled: {@code play} is legal from here. */
    record Ready(int token, double landedSec, boolean prerolled, int elapsedMs) implements DeckEvent {}

    /** An interrupted seek or an unfinished preroll; the deck retries itself. */
    record NotReady(int token, int attempt, String cause) implements DeckEvent {}

    /**
     * The load did not become ready inside its deadline (P-13). {@code cause} is the deck's
     * reading of WHY (A-64, mirrors NE-39n): {@code timeout} unless a load error it saw by then
     * says the server answered or the network was gone ({@link NarrationFallbackCauseReading}).
     */
    record DeadlineExceeded(int token, int afterMs, Vocabulary.NarrationFallbackCause cause) implements DeckEvent {
        public DeadlineExceeded {
            if (cause == null) cause = Vocabulary.NarrationFallbackCause.TIMEOUT;
        }

        /** A deadline with no reading of its own: {@code timeout}. */
        public DeadlineExceeded(int token, int afterMs) {
            this(token, afterMs, Vocabulary.NarrationFallbackCause.TIMEOUT);
        }
    }

    /**
     * The item failed. {@code cause} is the deck's mapping of the failure (Media3's
     * {@code PlaybackException} code, its source's HTTP status) to a closed token (A-64, mirrors
     * NE-39n; ExoDeck.fallbackCause through {@link NarrationFallbackCauseReading}); the core writes
     * it on a {@code narration kind=fallback} row and nowhere else.
     */
    record Failed(int token, String message, Vocabulary.NarrationFallbackCause cause) implements DeckEvent {
        public Failed {
            if (cause == null) cause = Vocabulary.NarrationFallbackCause.OTHER;
        }

        /** A failure with no reading of its own: {@code other}. */
        public Failed(int token, String message) {
            this(token, message, Vocabulary.NarrationFallbackCause.OTHER);
        }
    }

    /** A command the deck would not run ({@code play} before {@code ready}). */
    record Refused(String command, String reason) implements DeckEvent {}

    record TimeControl(int token, TimeControlStatus status, String waitingReason) implements DeckEvent {}

    /** The player stopped while the deck intended to play, not at the item's end: the reconcile input. */
    record PausedUncommanded(int token, double atSec) implements DeckEvent {}

    record Seeked(int token, double landedSec, boolean finished) implements DeckEvent {}

    record Stalled(int token) implements DeckEvent {}

    /** The item played to its end (or to its out-point): one end, one path. */
    record Ended(int token) implements DeckEvent {}

    /** The playing deck's out-point is the prefetch lead away: the core may ask for a {@code prepare}. */
    record PrepareWindow(int token) implements DeckEvent {}

    /**
     * What the standby deck did for the load {@code token}: {@code hit} when its warm load was
     * promoted, and the stages it reached. Sent before that load's {@code ready} (or instead of
     * nothing, on a miss); the packed seam row reports it.
     */
    record Prepared(int token, boolean hit, java.util.List<Vocabulary.Stage> stages) implements DeckEvent {
        public Prepared {
            stages = java.util.Collections.unmodifiableList(new java.util.ArrayList<>(stages));
        }
    }

    /** The load token an event carries, or null ({@code refused} carries none). */
    static Integer tokenOf(DeckEvent event) {
        return switch (event) {
            case DurationLoaded e -> e.token();
            case Ready e -> e.token();
            case NotReady e -> e.token();
            case DeadlineExceeded e -> e.token();
            case Failed e -> e.token();
            case Refused e -> null;
            case TimeControl e -> e.token();
            case PausedUncommanded e -> e.token();
            case Seeked e -> e.token();
            case Stalled e -> e.token();
            case Ended e -> e.token();
            case PrepareWindow e -> e.token();
            case Prepared e -> e.token();
        };
    }
}

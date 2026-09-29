package ai.jwlabs.foura.engine;

/**
 * What the deck observed: raw facts plus the load token, no policy. The JVM twin of
 * {@code DeckEvent} in ForayEngineCore (Engine/DeckVocabulary.swift, NE-14s). Every event
 * carries the token of the load it belongs to, so a superseded load's late callback is
 * recognisably stale.
 *
 * <p>{@code prepareWindow} and {@code prepared} (the standby deck's reports) arrive with
 * the Foray tape (A-40).
 */
public sealed interface DeckEvent permits DeckEvent.DurationLoaded, DeckEvent.Ready, DeckEvent.NotReady,
        DeckEvent.DeadlineExceeded, DeckEvent.Failed, DeckEvent.Refused, DeckEvent.TimeControl, DeckEvent.PausedUncommanded,
        DeckEvent.Seeked, DeckEvent.Stalled, DeckEvent.Ended {

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

    /** The load did not become ready inside its deadline. */
    record DeadlineExceeded(int token, int afterMs) implements DeckEvent {}

    record Failed(int token, String message) implements DeckEvent {}

    /** A command the deck would not run ({@code play} before {@code ready}). */
    record Refused(String command, String reason) implements DeckEvent {}

    record TimeControl(int token, TimeControlStatus status, String waitingReason) implements DeckEvent {}

    /** The player stopped while the deck intended to play, not at the item's end: the reconcile input. */
    record PausedUncommanded(int token, double atSec) implements DeckEvent {}

    record Seeked(int token, double landedSec, boolean finished) implements DeckEvent {}

    record Stalled(int token) implements DeckEvent {}

    /** The item played to its end (or to its out-point): one end, one path. */
    record Ended(int token) implements DeckEvent {}
}

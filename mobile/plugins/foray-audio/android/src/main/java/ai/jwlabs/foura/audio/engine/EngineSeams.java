package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.Rows;

/**
 * Everything {@link ForayEngineHost} touches outside the core, as interfaces (card A-26,
 * docs/plans/android-assessment.md §5.4): the JVM twin of the iOS {@code EngineSeams}
 * (ForayAudioPlugin/Engine/Seams.swift, NE-15h), cut down to what an Android episode needs.
 *
 * <p>The production conformers are the service's ({@code ForayPlaybackService}): the
 * {@link ExoDeck}, a {@link HandlerTiming} on the main looper, an {@link EngineLog}, and a session
 * that answers for the Media3 session. A test stands a recorder behind each one, so the host's
 * turn discipline runs on a plain JVM.
 *
 * <p>WHAT IS NOT HERE, AND WHERE IT GOES. iOS also has a background-task seam (grace spans
 * are UIKit background tasks), a remote-command registry (MPRemoteCommandCenter), a Now Playing
 * writer, a speaker, an interlude and a silence node. On Android: a grace span is a row only
 * (a mediaPlayback foreground service has no background budget to borrow); the remote surface
 * and Now Playing are ONE object, the Media3 session's player ({@link EnginePlayer}), which reads
 * the host's {@link ForayEngineHost.Surface} after every turn; speech, interludes and the tape
 * are A-40's and A-41's.
 */
public final class EngineSeams {
    /** What {@link Session#activate()} answered. {@code error} is a contract token or null. */
    public record Activation(boolean ok, String error, Double activateMs) {
        public static Activation granted() {
            return new Activation(true, null, null);
        }
    }

    /**
     * The audio session, as the core asks for it ({@code sessionActivate} and friends).
     *
     * <p>ON ANDROID THE SESSION IS NOT WHERE FOCUS IS REQUESTED. The deck's ExoPlayer is built
     * with {@code handleAudioFocus} on (the card), so Media3 requests AUDIOFOCUS_GAIN when the
     * deck plays and refuses to sound without it; what the host hears back is
     * {@link FocusMapping}'s interruptions. So {@code activate()} answers whether the Media3
     * session that owns the lock screen is alive, and the audible-start invariant holds twice
     * over: the core will not command a play without this answer, and Media3 will not start
     * one without focus.
     */
    public interface Session {
        Activation activate();

        void deactivate(boolean notifyOthers);

        void reapplyCategory();

        void rebuild();
    }

    /** One scheduled callback; cancelling one that already fired is harmless. */
    public interface Cancellable {
        void cancel();
    }

    /** The clocks and the timers, all on the host's one thread. */
    public interface Timing {
        /** Wall clock, epoch ms: what rows are stamped with. */
        double wallMs();

        /** Monotonic ms (elapsedRealtime): what spans and windows are measured with. */
        double monoMs();

        Cancellable schedule(double afterMs, boolean repeating, Runnable fire);
    }

    /**
     * Where the core's writes go. Until A-27 (EngineStore) every one is a row in the ring and
     * logcat, and nothing is persisted: the restore record, the position store and the
     * pending-event log are that card's.
     */
    public interface Output {
        void writePosition(EngineCommand.PositionWrite write);

        void writeRow(Rows.StoredRow row);

        void writeRestore(RestoreRecord record);

        void appendEvent(EngineCommand.PendingEvent event);

        void emit(EngineCommand.EngineEvent event);

        void diag(EngineCommand.DiagEntry entry);
    }

    public final DeckDriving deck;
    public final Session session;
    public final Timing timing;
    public final Output output;

    public EngineSeams(DeckDriving deck, Session session, Timing timing, Output output) {
        this.deck = java.util.Objects.requireNonNull(deck, "deck");
        this.session = java.util.Objects.requireNonNull(session, "session");
        this.timing = java.util.Objects.requireNonNull(timing, "timing");
        this.output = java.util.Objects.requireNonNull(output, "output");
    }
}

package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.RouteResume;
import ai.jwlabs.foura.engine.Rows;

/**
 * Everything {@link ForayEngineHost} touches outside the core, as interfaces (card A-26,
 * docs/plans/android-assessment.md §5.4): the JVM twin of the iOS {@code EngineSeams}
 * (ForayAudioPlugin/Engine/Seams.swift, NE-15h), cut down to what an Android episode needs.
 *
 * <p>The production conformers are the service's ({@code ForayPlaybackService}): the
 * {@link ExoDeck}, a {@link HandlerTiming} on the main looper, an {@link EngineStore} (over an
 * {@link EngineLog}), and a session that answers for the Media3 session. A test stands a recorder behind each one, so the host's
 * turn discipline runs on a plain JVM.
 *
 * <p>WHAT IS NOT HERE, AND WHERE IT GOES. iOS also has a background-task seam (grace spans
 * are UIKit background tasks), a remote-command registry (MPRemoteCommandCenter), a Now Playing
 * writer and a silence node. On Android: a grace span is a row only (a mediaPlayback foreground
 * service has no background budget to borrow); the remote surface and Now Playing are ONE object,
 * the Media3 session's player ({@link EnginePlayer}), which reads the host's
 * {@link ForayEngineHost.Surface} after every turn; the silence node stays off (its flag is off on
 * iOS too).
 *
 * <p>THE SPEAKER AND THE JINGLE (A-41), the iOS {@code Speaking} and {@code InterludePlaying}: the
 * service's are {@link SpeechNarrator} over Android {@code TextToSpeech} and {@link InterludePlayer}
 * over the bundled jingle. Both are OPTIONAL here: a host built without a speaker answers a spoken
 * line {@code failed} (the core steps over it, as the JS tape does with no TTS plugin), and one
 * without a jingle player builds its core with {@code interludeAvailable} off.
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
     * Where the core's writes go: {@link EngineStore} in the service (A-27: the shared position
     * rows and the restore record, committed before the write returns, and every write a row in
     * the ring), {@link EngineLog} alone in the host's plain-JVM tests.
     */
    public interface Output {
        void writePosition(EngineCommand.PositionWrite write);

        void writeRow(Rows.StoredRow row);

        void writeRestore(RestoreRecord record);

        void appendEvent(EngineCommand.PendingEvent event);

        void emit(EngineCommand.EngineEvent event);

        void diag(EngineCommand.DiagEntry entry);
    }

    /**
     * The engine's one synthesiser (A-41; the iOS {@code Speaking}): the voice picker's audition and
     * every line of a Foray's narration the core asks for, answered with the core's
     * {@link EngineInput.NarratorEvent}s keyed by the utterance {@code seq}. Every call is on the
     * host's thread, and so is every answer.
     */
    public interface Speaking {
        /**
         * Where the answers go: a line of narration's events, and the end of an AUDITION line (which
         * the core has no input for). Set at the host's start, cleared (null) at its teardown.
         */
        void setListener(SpeakingListener listener);

        /** The audition: audible, and the core emits it only after an activation (OQ-5). */
        void speak(String text, String voiceId);

        void stopSpeaking();

        /** Carry out one of the core's narration commands. An answer given at once is queued by the host behind the turn. */
        void narrate(EngineCommand.NarrationCommand command);

        /** Silence everything and let the synthesiser go (the host's teardown). */
        void release();
    }

    /** What a {@link Speaking} says, on the host's thread. */
    public interface SpeakingListener {
        void onNarratorEvent(EngineInput.NarratorEvent event);

        /** An audition line ended: {@code finished}, {@code cancelled} or {@code failed}. */
        void onAuditionEnded(String end);
    }

    /**
     * The seam's jingle (A-41; the iOS {@code InterludePlaying}): one short bundled asset at 1.0x.
     * The core decides WHEN; the conformer only plays it and says when it stopped sounding.
     */
    public interface InterludePlaying {
        /**
         * The jingle stopped sounding by itself, on the host's thread, at most once per accepted
         * {@link #start}: {@code ended}, {@code error} or {@code ceiling}. Never for a {@link #stop} or a
         * {@link #release}. Set at the host's start, cleared (null) at its teardown.
         */
        void setOnEnded(java.util.function.Consumer<String> onEnded);

        /** Start from the first frame. Audible: false (and a row) when the session is not active or the asset cannot play. */
        boolean start();

        /** Silence it without an end report (a transport action cut the beat). */
        void stop();

        /** Stop and let the player go (the engine's teardown). */
        void release();
    }

    /**
     * Where our audio goes now (A-61, the Swift {@code SessionControlling.currentRoute} of
     * NE-38rs), read for every input ({@code EngineNow.route}): the route a playing deck is heard
     * through, which is how a route becomes known. The service's is its {@code RouteWatcher}.
     */
    public interface RouteReading {
        /** The current output route, or null when the host cannot say. */
        EngineInput.RoutePort currentRoute();
    }

    /**
     * Where route resume's known set lives between launches (A-61, the Swift
     * {@code KnownRoutesStoring}): the engine-private key {@code ForayEngine.knownRoutes}
     * ({@link EngineStore}), never the page's file, with the install's salt beside the salted keys.
     * The host reads it once at construction and writes it whenever a turn changed the core's set;
     * null removes the key (an empty set, a data deletion).
     */
    public interface KnownRoutesStoring {
        RouteResume.Stored loadKnownRoutes();

        void saveKnownRoutes(RouteResume.Stored stored);
    }

    public final DeckDriving deck;
    public final Session session;
    public final Timing timing;
    public final Output output;
    /** The synthesiser, or null: a spoken line is then answered {@code failed} at once. */
    public final Speaking speaker;
    /** The jingle player, or null: the core is then built with {@code interludeAvailable} off. */
    public final InterludePlaying interlude;
    /** The current route (A-61), or null: no route ever becomes known, so none ever resumes. */
    public final RouteReading routes;
    /** The known routes' private key (A-61), or null (most tests): a fresh salt per engine, and nothing persisted. */
    public final KnownRoutesStoring knownRoutes;
    /**
     * The PREVIEW deck (A-66, mirrors NE-47's {@code EngineSeams.preview}): the voice picker's
     * rendered {@code preview.m4a} plays here, never on {@link #deck}, so a preview leaves the item a
     * paused Foray holds exactly where it was. The service's is an {@link ExoDeck} of its own whose
     * rows say {@code lane=preview}. Null (most tests): a preview's load is answered {@code failed}
     * at once, and the audition is spoken instead, as it was before it had a url.
     */
    public final DeckDriving preview;

    public EngineSeams(DeckDriving deck, Session session, Timing timing, Output output) {
        this(deck, session, timing, output, null, null);
    }

    public EngineSeams(DeckDriving deck, Session session, Timing timing, Output output, Speaking speaker, InterludePlaying interlude) {
        this(deck, session, timing, output, speaker, interlude, null, null);
    }

    public EngineSeams(DeckDriving deck, Session session, Timing timing, Output output, Speaking speaker, InterludePlaying interlude,
                       RouteReading routes, KnownRoutesStoring knownRoutes) {
        this(deck, session, timing, output, speaker, interlude, routes, knownRoutes, null);
    }

    public EngineSeams(DeckDriving deck, Session session, Timing timing, Output output, Speaking speaker, InterludePlaying interlude,
                       RouteReading routes, KnownRoutesStoring knownRoutes, DeckDriving preview) {
        this.deck = java.util.Objects.requireNonNull(deck, "deck");
        this.session = java.util.Objects.requireNonNull(session, "session");
        this.timing = java.util.Objects.requireNonNull(timing, "timing");
        this.output = java.util.Objects.requireNonNull(output, "output");
        this.speaker = speaker;
        this.interlude = interlude;
        this.routes = routes;
        this.knownRoutes = knownRoutes;
        this.preview = preview;
    }

    /** These seams with route resume's two (A-61). */
    public EngineSeams withRoutes(RouteReading routes, KnownRoutesStoring knownRoutes) {
        return new EngineSeams(deck, session, timing, output, speaker, interlude, routes, knownRoutes, preview);
    }

    /** These seams with the voice preview's deck (A-66). */
    public EngineSeams withPreview(DeckDriving preview) {
        return new EngineSeams(deck, session, timing, output, speaker, interlude, routes, knownRoutes, preview);
    }
}

package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * EVERYTHING {@link EngineCore#handle} ACCEPTS (docs/native-engine-plan.md §4.2): the JVM
 * twin of {@code EngineInput} and the types it carries in ForayEngineCore
 * (Engine/EngineInput.swift, NE-14s).
 *
 * <p>Every observation and every intent the engine acts on is one of these, and nothing
 * else reaches the core: the host (A-26's MediaSessionService) turns player listeners,
 * audio focus, media buttons, timers and the bridge into inputs, feeds them in on one
 * thread, and interprets what comes back. That single door is what lets a parity scenario
 * drive the same core the car drives.
 *
 * <p>The narrating overlay's inputs ({@code narrator}) and the jingle's ({@code interlude}) came
 * with the Foray tape (A-40), as the core's rules; the host's synthesiser and jingle player are
 * A-41's.
 */
public sealed interface EngineInput permits EngineInput.Command, EngineInput.Queue, EngineInput.Remote, EngineInput.Deck,
        EngineInput.SessionAnswer, EngineInput.Session, EngineInput.Lifecycle, EngineInput.Timer, EngineInput.Narrator,
        EngineInput.Interlude, EngineInput.Preview {

    /** A page command (engineSend), with where it came from. */
    record Command(EngineContract.Command command, Vocabulary.Source source) implements EngineInput {
        public Command {
            Objects.requireNonNull(command, "command");
            Objects.requireNonNull(source, "source");
        }
    }

    record Queue(QueueInput input) implements EngineInput {}

    record Remote(RemotePress press) implements EngineInput {}

    record Deck(DeckEvent event) implements EngineInput {}

    /** The answer to a {@code sessionActivate}, fed back in the same turn. */
    record SessionAnswer(SessionResult result) implements EngineInput {}

    record Session(SessionEvent event) implements EngineInput {}

    record Lifecycle(LifecycleEvent event) implements EngineInput {}

    record Timer(EngineTimer timer) implements EngineInput {}

    /** The synthesiser, about utterance {@code seq} (the identity the core stamped on {@code speak}). */
    record Narrator(NarratorEvent event) implements EngineInput {}

    /** The jingle player. */
    record Interlude(InterludeEvent event) implements EngineInput {}

    /**
     * The PREVIEW deck (NE-47, A-66): the voice picker's rendered {@code preview.m4a}, on a deck of
     * its own so a preview never touches the item the main deck holds. Its events speak the main
     * deck's vocabulary; the core reads only the load's answer ({@code ready}, {@code failed},
     * {@code deadlineExceeded}) and the file's {@code ended}, for the token it issued.
     */
    record Preview(DeckEvent event) implements EngineInput {}

    /** How the synthesiser answered {@code resume(seq)}. */
    sealed interface NarrationResumeAnswer permits NarrationResumeAnswer.Continued, NarrationResumeAnswer.FromStart,
            NarrationResumeAnswer.Refused, NarrationResumeAnswer.NoAnswer {
        record Continued() implements NarrationResumeAnswer {}

        /** The line is re-spoken from its first word: the clock restarts. */
        record FromStart() implements NarrationResumeAnswer {}

        record Refused(String reason) implements NarrationResumeAnswer {}

        /** A bridge with no transport: nothing said, the clock continues. */
        record NoAnswer() implements NarrationResumeAnswer {}

        NarrationResumeAnswer CONTINUED = new Continued();
        NarrationResumeAnswer FROM_START = new FromStart();
        NarrationResumeAnswer NO_ANSWER = new NoAnswer();
    }

    /** The narration bridge's reports (player/tts-bridge.js), keyed by utterance {@code seq}. */
    sealed interface NarratorEvent permits NarratorEvent.Started, NarratorEvent.Failed, NarratorEvent.Finished,
            NarratorEvent.Cancelled, NarratorEvent.Resumed {
        /** {@code speak} accepted: the line is the playhead. {@code voiceFallback}: another voice than asked. */
        record Started(int seq, boolean voiceFallback) implements NarratorEvent {}

        record Failed(int seq, String reason) implements NarratorEvent {}

        /** {@code didFinish}: the line ran out. */
        record Finished(int seq) implements NarratorEvent {}

        /** A stop, a replacement or the session taken from under it: never an advance. */
        record Cancelled(int seq) implements NarratorEvent {}

        record Resumed(int seq, NarrationResumeAnswer answer) implements NarratorEvent {}
    }

    /** The jingle player's report: it ended ({@code ended}, {@code refused}, ...). */
    sealed interface InterludeEvent permits InterludeEvent.Ended {
        record Ended(String reason) implements InterludeEvent {}
    }

    /**
     * The manager's own queue surface: a page-built queue and a play at an index. The
     * contract's {@code playEpisode} is this with a one-item queue, and a parity scenario's
     * {@code loadQueue} / {@code play(index)} / {@code setRate(anything)} arrive through it,
     * so the fixtures exercise the paths the contract commands take.
     */
    sealed interface QueueInput permits QueueInput.Load, QueueInput.PlayIndex, QueueInput.SetRate, QueueInput.Seek,
            QueueInput.LoadForay {
        /** {@code loadQueue(items)}: replace the queue; nothing loads or plays. */
        record Load(List<EngineItem> items) implements QueueInput {
            public Load {
                items = Collections.unmodifiableList(new ArrayList<>(items));
            }
        }

        /** {@code play(index, {startOffset})}; {@code startSec} null when absent. */
        record PlayIndex(int index, Double startSec, Vocabulary.Source source) implements QueueInput {}

        /** {@code setRate(rate)}: null stands for every value that is not a number, which snaps to 1x. */
        record SetRate(Double rate) implements QueueInput {}

        /** {@code seek(seconds, {precise})} in the source's own seconds. */
        record Seek(double sec, boolean precise) implements QueueInput {}

        /**
         * {@code setQueueFromForay(foray, opts)} with the page's build: the same replacement, plus
         * the options the load-time ladder reads.
         */
        record LoadForay(List<EngineItem> items, boolean isLocalFile, boolean allowAdPad) implements QueueInput {
            public LoadForay {
                items = Collections.unmodifiableList(new ArrayList<>(items));
            }
        }
    }

    /**
     * A press from the lock screen, the car or a headset. {@code value}: a scrub's target,
     * or a skip command's interval. {@code routePort}: the output route when it arrived.
     * {@code onMain}: false when the handler arrived off the engine's thread.
     */
    record RemotePress(MediaMapping.RemoteCommand command, Double value, String routePort, boolean onMain) {
        public RemotePress {
            Objects.requireNonNull(command, "command");
        }

        public RemotePress(MediaMapping.RemoteCommand command) {
            this(command, null, null, true);
        }

        public RemotePress(MediaMapping.RemoteCommand command, Double value) {
            this(command, value, null, true);
        }
    }

    /**
     * The answer to a {@code sessionActivate}: request and response in one turn (plan §4.2).
     * {@code error}: the failure token ({@code cannot-interrupt-others},
     * {@code cannot-start-playing}; anything else reads as {@code other}).
     */
    record SessionResult(int requestId, boolean ok, String error, Double activateMs) {}

    /**
     * A route change as the rules read it (the Swift {@code RouteChange} since NE-38rs; A-61). The
     * port is the one that MATTERS: the one that went away on a loss, the one that arrived
     * otherwise. {@code oldDeviceUnavailable}: headphones out, the car switched off.
     * {@code portType}: the port's type token (the {@code session} and {@code route} rows carry
     * it). {@code portUID}: what a known route is remembered by (on Android the device's address),
     * never its name; the core hashes it with the install's salt before anything keeps or writes
     * it, and it never reaches a row (plan §10, DiagGate). {@code routeClass}: car, bluetooth or
     * other, as the host read it (Android classes the device itself, car mode included); null
     * classes it by {@code portType} ({@link RouteResume#routeClass}, the iOS port names).
     */
    record RouteChange(boolean oldDeviceUnavailable, String portType, String portUID, RouteResume.RouteClass routeClass) {
        public RouteChange {
            if (routeClass == null) routeClass = RouteResume.routeClass(portType);
        }

        public RouteChange(boolean oldDeviceUnavailable, String portType, String portUID) {
            this(oldDeviceUnavailable, portType, portUID, null);
        }

        /** A route change that names no port (A-26's BECOMING_NOISY with nothing tracked). */
        public RouteChange(boolean oldDeviceUnavailable) {
            this(oldDeviceUnavailable, null, null, null);
        }
    }

    /**
     * Where our audio goes right now, as the host reads it for every input
     * ({@link EngineNow#route}): the route a playing deck is heard through, which is how a route
     * becomes known (NE-38rs, A-61). {@code uid} is hashed before it is kept; never a row.
     */
    record RoutePort(String portType, String uid) {
        public RoutePort {
            Objects.requireNonNull(portType, "portType");
        }
    }

    /** The audio session's notifications (plan §4.4; audio focus on Android, A-26). */
    sealed interface SessionEvent permits SessionEvent.InterruptionBegan, SessionEvent.InterruptionEnded,
            SessionEvent.Route, SessionEvent.MediaServicesReset {
        /** {@code reason}: the raw interruption reason; anything outside the closed vocabulary reads as unknown. */
        record InterruptionBegan(String reason) implements SessionEvent {}

        record InterruptionEnded(boolean shouldResume) implements SessionEvent {}

        record Route(RouteChange change) implements SessionEvent {}

        record MediaServicesReset() implements SessionEvent {}
    }

    /** The process and the app around the engine. */
    sealed interface LifecycleEvent permits LifecycleEvent.ColdLaunch, LifecycleEvent.Background, LifecycleEvent.Terminating,
            LifecycleEvent.Foreground, LifecycleEvent.Teardown {
        /**
         * A launch that restored a queue and a position BEFORE any network call (corner case
         * #15). {@code autoplay}: a car's play arriving for it (the cold path, plan §4.5).
         */
        record ColdLaunch(List<EngineItem> queue, int index, boolean autoplay) implements LifecycleEvent {
            public ColdLaunch {
                queue = Collections.unmodifiableList(new ArrayList<>(queue));
            }
        }

        /** The app left the foreground: the moment the position is flushed (#689). */
        record Background() implements LifecycleEvent {}

        /** The last chance to write the position, a courtesy the OS may not give. */
        record Terminating() implements LifecycleEvent {}

        /** The app came back: ask the deck what happened while nobody was listening (#263). */
        record Foreground() implements LifecycleEvent {}

        /**
         * The engine itself is being torn down (the page's {@code dispose()}): whatever is
         * sounding is silenced, the deck is released, every timer is cancelled, and the core
         * answers nothing from then on. The reducer's state is left as it was.
         */
        record Teardown() implements LifecycleEvent {}
    }
}

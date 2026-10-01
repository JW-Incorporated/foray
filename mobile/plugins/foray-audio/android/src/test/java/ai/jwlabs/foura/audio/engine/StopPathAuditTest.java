package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import ai.jwlabs.foura.audio.ForayPlaybackService;
import ai.jwlabs.foura.audio.RouteWatcher;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.audio.engine.InterludePlayerTest.FakeJingle;
import ai.jwlabs.foura.audio.engine.LateTimerHostTest.ClockedTiming;
import ai.jwlabs.foura.audio.engine.SpeechNarratorTest.FakeOutput;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckDeadlineClass;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import ai.jwlabs.foura.engine.Vocabulary.StopCause;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Looper;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.test.utils.FakeClock;
import androidx.media3.test.utils.TestExoPlayerBuilder;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAudioManager;
import org.robolectric.shadows.ShadowLooper;

/**
 * Card A-67, THE STOP-CAUSE AUDIT ON ANDROID (mirrors NE-40's D-5 audit): every way the Android
 * shell can stop the engine's audio writes a {@code stop} row with a named cause, BEFORE the host
 * silences anything (a deck pause or unload, the synthesiser's stop or pause, the jingle's stop, a
 * release). The JVM core's own table ({@code StopCauseTest} in foray-engine-core-jvm) covers every
 * {@code stopRow} call site; this one covers every ANDROID ADAPTER that reaches one, through the
 * real host ({@link ForayEngineHost}), the real {@link FocusMapping}, {@link RouteWatcher},
 * {@link SpeechNarrator}, {@link InterludePlayer} and {@link EnginePlayer} facade, fed exactly what
 * {@link ForayPlaybackService} feeds them:
 * <ul>
 *   <li>ExoPlayer's errors ({@code ExoDeck.onPlayerError} becomes {@code failed}; a real ExoPlayer
 *       below), the deck's P-13 deadline, and the deck's uncommanded pause;</li>
 *   <li>focus loss: permanent, transient, and a duck, which Media3 turns into a pause for speech
 *       (a real ExoPlayer and Robolectric's AudioManager below);</li>
 *   <li>BECOMING_NOISY, on the deck (Media3's receiver) and off it (the service's own receiver,
 *       during a spoken line or the seam's jingle);</li>
 *   <li>the route policy (the device callback's removal; a return after a listener's pause stays
 *       paused, so it is not a stop);</li>
 *   <li>the line deadline (a rendered line's P-13 deadline is a fallback, not a stop; a Foray's
 *       last spoken line past its deadline is its end);</li>
 *   <li>Doze (a seam's next load held past its deadline under grace, with the late-timer row
 *       first; a spoken line's pulse frozen past the suspension gap);</li>
 *   <li>{@code onTaskRemoved} (kept: no stop; not kept: Media3 pauses the facade, one pause row) and
 *       the service's stop ({@code onDestroy}: the host's teardown has the core write
 *       {@code stop cause=relinquish} first).</li>
 * </ul>
 *
 * <p>Two causes never happen on Android, each for a reason {@link #androidDisposition} names:
 * {@code grace-expired} (a mediaPlayback foreground service has no background budget; Android's
 * grace is rows, and nothing fires its expiry) and {@code media-services-reset} (Android has no
 * such signal). {@code seam-timeout} and {@code unknown} are never written anywhere.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
@OptIn(markerClass = UnstableApi.class)
public class StopPathAuditTest {
    static final String CAR_ADDRESS = "02:00:00:0A:67:01";
    static final RouteWatcher.Device SPEAKER = new RouteWatcher.Device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, 1, "");
    static final RouteWatcher.Device HEADSET = new RouteWatcher.Device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, 6701, CAR_ADDRESS);

    /** The real host over fakes for its outputs, wired as ForayPlaybackService wires it. */
    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final ClockedTiming timing = new ClockedTiming();
        final FakeOutput speech = new FakeOutput();
        final FakeJingle jingle = new FakeJingle();
        final List<String> lines = new ArrayList<>();
        /** For each {@code stop} line, how many silencing calls the host had made by then. */
        final List<Integer> silencedAtStopRow = new ArrayList<>();
        final EngineLog log = new EngineLog(() -> 0, this::onLine);
        final RouteWatcher watcher = new RouteWatcher(() -> false, () -> timing.mono);
        final FocusMapping focus = new FocusMapping();
        final SpeechNarrator narrator;
        final InterludePlayer interlude;
        final ForayEngineHost host;
        final EnginePlayer facade;

        Rig() {
            SpeechNarrator.Config sc = new SpeechNarrator.Config();
            sc.diag = log::diag;
            narrator = new SpeechNarrator(speech, sc);
            InterludePlayer.Config ic = new InterludePlayer.Config();
            ic.diag = log::diag;
            ic.timing = timing;
            ic.makeJingle = () -> jingle;
            interlude = new InterludePlayer(ic);
            watcher.seed(Arrays.asList(SPEAKER, HEADSET));
            EngineConfig config = new EngineConfig("test").withForayTape(true, false).withInterludeAvailable(true);
            host = new ForayEngineHost(new EngineSeams(deck, session, timing, log, narrator, interlude).withRoutes(watcher, null), config);
            Map<DeckDeadlineClass, Double> deadlines = new EnumMap<>(DeckDeadlineClass.class);
            deadlines.put(DeckDeadlineClass.CLIP, 20_000.0);
            deadlines.put(DeckDeadlineClass.LINE, 8_000.0);
            host.setLoadDeadlines(deadlines);
            host.start();
            facade = new EnginePlayer(Looper.getMainLooper(), new EnginePlayer.Engine() {
                @Override
                public ForayEngineHost.Surface surface() {
                    return host.freshSurface();
                }

                @Override
                public ForayEngineHost.Verdict remote(EngineInput.RemotePress press) {
                    return host.remote(press);
                }
            });
            host.setSurfaceListener(surface -> facade.refresh());
        }

        /** Where the path under audit starts: its lines, its stop rows, the silencing calls and the ring's rows before it. */
        int markLines;
        int markStops;
        int markSilenced;
        int markRing;

        /** Measure the path from here (a step calls it again after its own setup). */
        void mark() {
            markLines = lines.size();
            markStops = silencedAtStopRow.size();
            markSilenced = silenced();
            markRing = log.diagnosticRows().size();
        }

        private void onLine(String line) {
            lines.add(line);
            if (kindOf(line).equals("stop")) silencedAtStopRow.add(silenced());
        }

        /** Every call that silences something: a deck pause or unload, the synthesiser's stop, pause or release, the jingle's stop or release. */
        int silenced() {
            int n = deck.count(DeckCommand.Pause.class) + deck.count(DeckCommand.Unload.class);
            for (String c : speech.calls) if (c.equals("stop") || c.equals("pause") || c.equals("release")) n++;
            return n + jingle.stops + (jingle.released ? 1 : 0);
        }

        /** What the service's {@code feed} does: a portless loss is named by the watcher (or dropped). */
        void feed(List<EngineInput.SessionEvent> events) {
            for (EngineInput.SessionEvent event : events) {
                if (event instanceof EngineInput.SessionEvent.Route r && r.change().oldDeviceUnavailable() && r.change().portType() == null) {
                    EngineInput.RouteChange named = watcher.onNoisy();
                    if (named == null) continue;
                    event = new EngineInput.SessionEvent.Route(named);
                }
                host.handle(new EngineInput.Session(event));
            }
        }

        void feedRoutes(List<EngineInput.RouteChange> changes) {
            for (EngineInput.RouteChange c : changes) host.handle(new EngineInput.Session(new EngineInput.SessionEvent.Route(c)));
        }

        /** Episode "a" playing, confirmed audible. */
        void playEpisode() {
            host.handle(ForayEngineHostTest.load("a"));
            host.handle(ForayEngineHostTest.playIndex(0));
            deck.emit(new DeckEvent.Ready(deck.lastToken, 0, true, 5));
            deck.emit(new DeckEvent.TimeControl(deck.lastToken, DeckEvent.TimeControlStatus.PLAYING, null));
            assertTrue("playing", host.state().isRunning());
        }

        void playForay(JsonNode... items) {
            host.handle(new EngineInput.Command(new EngineContract.Command.PlayForay("f1", "A Foray", Arrays.asList(items),
                    new JsonNode.Obj(List.of()), null, false, false, null), Vocabulary.Source.TAP));
        }

        DeckCommand.Load lastLoad() {
            DeckCommand.Load last = null;
            for (DeckCommand c : deck.sent) if (c instanceof DeckCommand.Load l) last = l;
            return last;
        }

        /** Play the Foray's first clip to its out-point (the seam's turn). */
        void runFirstClip() {
            DeckCommand.Load first = lastLoad();
            deck.emit(new DeckEvent.Ready(first.token(), first.startSec(), true, 1));
            deck.emit(new DeckEvent.TimeControl(first.token(), DeckEvent.TimeControlStatus.PLAYING, null));
            deck.reading.positionSec = 200.0;
            deck.reading.audible = false;
            timing.mono += 100_000;
            deck.emit(new DeckEvent.Ended(first.token()));
        }

        /** A spoken line ahead of a clip, the synthesiser speaking it. */
        void speakLine() {
            playForay(ForayEngineHostForayTest.line(0, "A line read aloud."), ForayEngineHostForayTest.clip(1, "a", 100, 200));
            assertNotNull("the line reached the synthesiser", speech.line);
            assertTrue(host.state().isRunning());
        }

        /** In the seam between two clips of two sources, the jingle sounding. */
        void inJingle() {
            playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200), ForayEngineHostForayTest.clip(1, "b", 300, 400));
            runFirstClip();
            assertEquals("the jingle sounds in the seam", 1, jingle.plays);
            assertTrue(host.state().inInterlude);
        }
    }

    static String kindOf(String line) {
        String[] parts = line.split(" ", 4);
        return parts.length >= 3 ? parts[2] : "";
    }

    static JsonNode bodyOf(String line) {
        String[] parts = line.split(" ", 4);
        return parts.length == 4 ? JsonNode.parse(parts[3]) : null;
    }

    /** One Android stop path: what starts it, the cause it must write (null: it is NOT a stop), and the row that says so when it is not. */
    record AndroidPath(String name, String adapter, StopCause cause, String companionKind, String companionEvent, Step step) {}

    interface Step {
        void run(Rig r);
    }

    static final List<AndroidPath> PATHS = List.of(
            // ExoPlayer and the deck (ExoDeck).
            new AndroidPath("an ExoPlayer error mid-play", "ExoDeck onPlayerError -> failed", StopCause.ERROR, null, null, r -> {
                r.playEpisode();
                r.deck.emit(new DeckEvent.Failed(r.deck.lastToken, "player: ERROR_CODE_IO_NETWORK_CONNECTION_FAILED",
                        Vocabulary.NarrationFallbackCause.OFFLINE));
            }),
            new AndroidPath("an episode's load past its P-13 deadline", "ExoDeck deadline", StopCause.LOAD_DEADLINE, null, null, r -> {
                r.host.handle(ForayEngineHostTest.load("a"));
                r.host.handle(ForayEngineHostTest.playIndex(0));
                r.timing.mono += 20_000;
                r.deck.emit(new DeckEvent.DeadlineExceeded(r.deck.lastToken, 20_000));
            }),
            new AndroidPath("the player stopped with no command of ours", "ExoDeck pausedUncommanded", StopCause.SYSTEM_PAUSE, null, null,
                    r -> {
                        r.playEpisode();
                        r.deck.reading.audible = false;
                        r.deck.emit(new DeckEvent.PausedUncommanded(r.deck.lastToken, 12));
                    }),
            new AndroidPath("an episode ends with nothing after it", "ExoDeck ended", StopCause.ENDED, null, null, r -> {
                r.playEpisode();
                r.deck.reading.audible = false;
                r.deck.reading.ended = true;
                r.deck.emit(new DeckEvent.Ended(r.deck.lastToken));
            }),
            new AndroidPath("a Foray's last clip ends", "ExoDeck ended", StopCause.FINAL_END, null, null, r -> {
                r.playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200));
                DeckCommand.Load first = r.lastLoad();
                r.deck.emit(new DeckEvent.Ready(first.token(), 100, true, 1));
                r.deck.emit(new DeckEvent.TimeControl(first.token(), DeckEvent.TimeControlStatus.PLAYING, null));
                r.deck.reading.audible = false;
                r.deck.reading.ended = true;
                r.deck.emit(new DeckEvent.Ended(first.token()));
            }),

            // Audio focus, as Media3 reports it and FocusMapping maps it.
            new AndroidPath("a permanent focus loss (another media app)", "FocusMapping AUDIO_FOCUS_LOSS", StopCause.INTERRUPTION, null, null,
                    r -> {
                        r.playEpisode();
                        r.feed(r.focus.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS));
                    }),
            new AndroidPath("a transient focus loss (a call, an assistant)", "FocusMapping TRANSIENT_AUDIO_FOCUS_LOSS",
                    StopCause.INTERRUPTION, null, null, r -> {
                        r.playEpisode();
                        r.feed(r.focus.onSuppressionChanged(Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS, Player.STATE_READY));
                    }),
            new AndroidPath("a duck (a navigation prompt), handled as a pause for speech", "FocusMapping (LOSS_TRANSIENT_CAN_DUCK)",
                    StopCause.INTERRUPTION, null, null, r -> {
                        // Media3 reports a duck on SPEECH as the transient suppression (FocusIntegrationTest,
                        // and theRealPlayersFocusAndNoiseReachTheHostAsCauseRows below).
                        r.playEpisode();
                        r.feed(r.focus.onSuppressionChanged(Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS, Player.STATE_READY));
                    }),
            new AndroidPath("a focus loss during a spoken line", "FocusMapping + SpeechNarrator", StopCause.INTERRUPTION, null, null, r -> {
                r.speakLine();
                r.feed(r.focus.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS));
            }),

            // BECOMING_NOISY: Media3's receiver on the deck, the service's own off it.
            new AndroidPath("headphones out while the deck plays", "Media3 BECOMING_NOISY -> FocusMapping", StopCause.ROUTE_CHANGE, null, null,
                    r -> {
                        r.playEpisode();
                        r.feed(r.focus.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY));
                    }),
            new AndroidPath("headphones out during a spoken line", "the service's BECOMING_NOISY receiver", StopCause.ROUTE_CHANGE, null, null,
                    r -> {
                        r.speakLine();
                        r.feed(FocusMapping.onBecomingNoisyOffDeck(false, r.host.state().isRunning()));
                    }),
            new AndroidPath("headphones out while the seam's jingle sounds", "the service's BECOMING_NOISY receiver + InterludePlayer",
                    StopCause.ROUTE_CHANGE, null, null, r -> {
                        r.inJingle();
                        r.feed(FocusMapping.onBecomingNoisyOffDeck(false, r.host.state().isRunning()));
                    }),

            // The route policy, from the device callback.
            new AndroidPath("the output device removed (the car, the headset)", "AudioDeviceCallback -> RouteWatcher", StopCause.ROUTE_CHANGE,
                    null, null, r -> {
                        r.playEpisode();
                        r.timing.mono += 1_500;
                        r.feedRoutes(r.watcher.onRemoved(Collections.singletonList(HEADSET)));
                    }),
            new AndroidPath("a listener's pause, then the device back: stays paused", "RouteWatcher (route kind=back decision=no)", null,
                    "route", "back", r -> {
                        r.playEpisode();
                        r.timing.mono += 1_500;
                        r.host.handle(new EngineInput.Command(EngineContract.Command.PAUSE, Vocabulary.Source.TAP));
                        r.feedRoutes(r.watcher.onRemoved(Collections.singletonList(HEADSET)));
                        r.timing.mono += 5_000;
                        r.mark();
                        r.feedRoutes(r.watcher.onAdded(Collections.singletonList(HEADSET)));
                    }),

            // The line deadline.
            new AndroidPath("a rendered line past its P-13 deadline falls back to TextToSpeech", "ExoDeck deadline on a line", null,
                    "narration", "fallback", r -> {
                        r.playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200),
                                ForayEngineHostNarrationTest.rendered(1, "https://audio.test/n/line.m4a", "Read me instead."),
                                ForayEngineHostForayTest.clip(2, "c", 500, 600));
                        r.runFirstClip();
                        DeckCommand.Load line = r.lastLoad();
                        assertEquals("f1#1", line.itemId());
                        r.timing.mono += 8_000;
                        r.deck.emit(new DeckEvent.DeadlineExceeded(line.token(), 8_000));
                        assertNotNull("the script is spoken instead", r.speech.line);
                    }),
            new AndroidPath("a Foray's last spoken line past its deadline", "the narration pulse (a host timer)", StopCause.FINAL_END, null, null,
                    r -> {
                        r.playForay(ForayEngineHostForayTest.line(0, "The only line."));
                        assertNotNull(r.speech.line);
                        r.timing.run(60_000, 100, null);
                    }),

            // Doze.
            new AndroidPath("Doze holds a seam's next load past its deadline, under grace", "ExoDeck deadline + the late-timer row",
                    StopCause.LOAD_DEADLINE, "grace", "late", r -> {
                        r.host.handle(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Background()));
                        r.playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200), ForayEngineHostForayTest.clip(1, "a", 900, 1000));
                        r.runFirstClip();
                        DeckCommand.Load next = r.lastLoad();
                        assertEquals("f1#1", next.itemId());
                        r.timing.mono += 26_000;
                        r.deck.emit(new DeckEvent.DeadlineExceeded(next.token(), 26_000));
                    }),
            new AndroidPath("Doze freezes the process under a spoken line", "the narration pulse after the suspension gap",
                    StopCause.SYSTEM_PAUSE, null, null, r -> {
                        r.speakLine();
                        r.timing.suspend(60_000);
                    }),

            // The page, through the bridge.
            new AndroidPath("a listener's pause from the page", "EngineBridge pause", StopCause.PAUSE, null, null, r -> {
                r.playEpisode();
                r.host.handle(new EngineInput.Command(EngineContract.Command.PAUSE, Vocabulary.Source.TAP));
            }),
            new AndroidPath("a close from the page", "EngineBridge stop", StopCause.CLOSE, null, null, r -> {
                r.playEpisode();
                r.host.handle(new EngineInput.Command(new EngineContract.Command.Stop(true), Vocabulary.Source.TAP));
            }),
            new AndroidPath("Delete my data", "EngineBridge purge", StopCause.DATA_DELETION, null, null, r -> {
                r.playEpisode();
                r.host.handle(new EngineInput.Command(new EngineContract.Command.Purge(), Vocabulary.Source.TAP));
            }),

            // The session's controls (the notification, the lock screen, a car, a headset).
            new AndroidPath("a pause from the notification, a car or a headset", "EnginePlayer (the Media3 session's player)",
                    StopCause.PAUSE, null, null, r -> {
                        r.playEpisode();
                        ShadowLooper.idleMainLooper();
                        r.facade.setPlayWhenReady(false);
                        ShadowLooper.idleMainLooper();
                    }),

            // The service.
            new AndroidPath("a swipe from Recents while the Foray plays: kept", "ForayPlaybackService.onTaskRemoved (kept)", null,
                    null, null, r -> {
                        r.playEpisode();
                        ShadowLooper.idleMainLooper();
                        assertTrue("the playing facade keeps the service", ForayPlaybackService.keepsRunningOnTaskRemoved(true, r.facade));
                    }),
            new AndroidPath("a swipe Media3 does not keep (out of the foreground)", "ForayPlaybackService.onTaskRemoved -> Media3's pause",
                    StopCause.PAUSE, null, null, r -> {
                        r.playEpisode();
                        ShadowLooper.idleMainLooper();
                        assertFalse(ForayPlaybackService.keepsRunningOnTaskRemoved(false, r.facade));
                        // Media3's pauseAllPlayersAndStopSelf: the facade paused, then the service destroyed.
                        r.facade.setPlayWhenReady(false);
                        ShadowLooper.idleMainLooper();
                        r.host.teardown();
                    }),
            new AndroidPath("the service stopped while the engine plays", "ForayPlaybackService.onDestroy -> ForayEngineHost.teardown",
                    StopCause.RELINQUISH, "mode", "teardown", r -> {
                        r.playEpisode();
                        r.host.teardown();
                    }),
            new AndroidPath("the service stopped while the engine plays a spoken line", "ForayPlaybackService.onDestroy + SpeechNarrator",
                    StopCause.RELINQUISH, null, null, r -> {
                        r.speakLine();
                        r.host.teardown();
                    }),
            new AndroidPath("the service stopped while paused", "ForayPlaybackService.onDestroy (nothing audible)", null, "mode", "teardown",
                    r -> {
                        r.playEpisode();
                        r.host.handle(new EngineInput.Command(EngineContract.Command.PAUSE, Vocabulary.Source.TAP));
                        r.mark();
                        r.host.teardown();
                    }));

    /** Whether Android emits a cause, or why it never does. A switch EXPRESSION with no default: a new cause does not compile until audited here. */
    static String androidDisposition(StopCause cause) {
        return switch (cause) {
            case PAUSE, ENDED, FINAL_END, SYSTEM_PAUSE, ROUTE_CHANGE, INTERRUPTION, LOAD_DEADLINE, ERROR, RELINQUISH, DATA_DELETION, CLOSE ->
                    null;
            case GRACE_EXPIRED -> "a mediaPlayback foreground service has no background budget: Android's grace is rows, and nothing fires its expiry";
            case MEDIA_SERVICES_RESET -> "Android has no media-services-reset signal; a dead player is an ExoPlayer error, `error`";
            case SEAM_TIMEOUT -> "a seam's next clip that never becomes ready is its load's P-13 deadline: load-deadline";
            case UNKNOWN -> "the residue: a paste that shows one names a defect, never a path";
        };
    }

    /**
     * THE ACCEPTANCE: every Android stop path, run through the real host, writes exactly one
     * {@code stop} row with its named cause, admitted by the ring's gate, before the host silenced
     * anything in it; a path that is not a stop writes none, and says what it was instead. TO SEE IT
     * FAIL: drop the core teardown from ForayEngineHost.teardown (the service-stop paths lose their
     * row); move {@code stopRow} below {@code cutSeamGap} in the core's {@code onRoute} (the jingle's
     * BECOMING_NOISY path silences first); feed BECOMING_NOISY off the deck nowhere.
     */
    @Test
    public void everyAndroidStopPathWritesItsCauseBeforeTheHostSilencesAnything() {
        List<String> failures = new ArrayList<>();
        for (AndroidPath path : PATHS) {
            Rig r = new Rig();
            r.mark();
            try {
                path.step().run(r);
            } catch (AssertionError | RuntimeException e) {
                failures.add(path.name() + " (" + path.adapter() + "): the path did not run: " + e);
                continue;
            }
            List<String> added = r.lines.subList(r.markLines, r.lines.size());
            List<JsonNode> stops = new ArrayList<>();
            for (String l : added) if (kindOf(l).equals("stop")) stops.add(bodyOf(l));
            if (path.cause() == null) {
                if (!stops.isEmpty()) failures.add(path.name() + ": not a stop, yet it wrote " + stops);
            } else if (stops.size() != 1) {
                failures.add(path.name() + " (" + path.adapter() + "): " + stops.size() + " stop rows, wanted one: " + String.join("\n  ", added));
            } else {
                JsonNode cause = stops.get(0).get("cause");
                if (!JsonNode.str(path.cause().token).equals(cause)) failures.add(path.name() + ": cause " + cause + ", wanted " + path.cause().token);
                int atRow = r.silencedAtStopRow.get(r.markStops);
                if (atRow != r.markSilenced) {
                    failures.add(path.name() + ": the host silenced something before the cause row (" + r.markSilenced + " -> " + atRow + ")");
                }
                boolean admitted = false;
                List<JsonNode> ring = r.log.diagnosticRows();
                for (int i = Math.min(r.markRing, ring.size()); i < ring.size(); i++) {
                    JsonNode row = ring.get(i);
                    if (JsonNode.str("stop").equals(row.get("kind")) && JsonNode.str(path.cause().token).equals(row.get("cause"))) admitted = true;
                }
                if (!admitted) failures.add(path.name() + ": the ring's gate did not keep the cause");
            }
            if (path.companionKind() != null) {
                boolean found = false;
                for (String l : added) {
                    JsonNode body = bodyOf(l);
                    if (kindOf(l).equals(path.companionKind()) && body != null && JsonNode.str(path.companionEvent()).equals(body.get("kind"))) {
                        found = true;
                    }
                }
                if (!found) failures.add(path.name() + ": no " + path.companionKind() + " kind=" + path.companionEvent() + " row: "
                        + String.join("\n  ", added));
            }
        }
        assertTrue(String.join("\n", failures), failures.isEmpty());
    }

    /** Every cause is emitted by an Android path, or never happens on Android for a named reason. TO SEE IT FAIL: drop the Delete my data path. */
    @Test
    public void everyStopCauseIsAnAndroidPathOrNeverHappensOnAndroid() {
        Set<StopCause> emitted = EnumSet.noneOf(StopCause.class);
        for (AndroidPath path : PATHS) if (path.cause() != null) emitted.add(path.cause());
        for (StopCause cause : StopCause.values()) {
            String why = androidDisposition(cause);
            if (why == null) {
                assertTrue(cause.token + " happens on Android but no path in the table shows it", emitted.contains(cause));
            } else {
                assertFalse(cause.token + " is said never to happen on Android, yet a path emits it", emitted.contains(cause));
                assertFalse(why.isEmpty());
            }
        }
    }

    /**
     * The real player's side of focus and BECOMING_NOISY, end to end: a TestExoPlayer configured as
     * the deck's ({@link EngineAudio#configure}), Robolectric's AudioManager delivering a DUCK, a
     * permanent loss, and the broadcast, and the player's listener feeding the host as the service's
     * does. Each reaches a cause row. TO SEE IT FAIL: drop {@code willPauseWhenDucked} (CONTENT_TYPE_SPEECH)
     * from EngineAudio, or {@code setHandleAudioBecomingNoisy}.
     */
    @Test
    public void theRealPlayersFocusAndNoiseReachTheHostAsCauseRows() throws Exception {
        assertEquals(StopCause.INTERRUPTION, realPlayerStop(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK));
        assertEquals(StopCause.INTERRUPTION, realPlayerStop(AudioManager.AUDIOFOCUS_LOSS));
        assertEquals(StopCause.ROUTE_CHANGE, realPlayerStop(null));
    }

    /** One real player, playing; {@code focusChange} delivered (null: BECOMING_NOISY broadcast); the cause the host wrote. */
    private StopCause realPlayerStop(Integer focusChange) throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        ExoPlayer player = new TestExoPlayerBuilder(context).setClock(new FakeClock(true)).setRenderers(new CapturingAudioRenderer()).build();
        try {
            EngineAudio.configure(player);
            Rig r = new Rig();
            player.addListener(new Player.Listener() {
                @Override
                public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                    r.feed(r.focus.onPlayWhenReadyChanged(playWhenReady, reason));
                }

                @Override
                public void onPlaybackSuppressionReasonChanged(int reason) {
                    r.feed(r.focus.onSuppressionChanged(reason, player.getPlaybackState()));
                }
            });
            ClickTracks.Fixture cbr = null;
            for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.file.equals("click-cbr.mp3")) cbr = f;
            assertNotNull(cbr);
            player.setMediaSource(new ProgressiveMediaSource.Factory(new DefaultDataSource.Factory(context))
                    .createMediaSource(MediaItem.fromUri(cbr.uri())));
            player.prepare();
            player.play();
            FocusIntegrationTest.until(player::isPlaying);
            r.playEpisode();
            if (focusChange != null) {
                ShadowAudioManager.AudioFocusRequest request = shadowOf(context.getSystemService(AudioManager.class)).getLastAudioFocusRequest();
                assertNotNull("Media3 asked for focus", request);
                request.listener.onAudioFocusChange(focusChange);
            }
            FocusIntegrationTest.until(() -> {
                if (focusChange == null && stopCause(r) == null) context.sendBroadcast(new Intent(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
                return stopCause(r) != null;
            });
            return stopCause(r);
        } finally {
            player.release();
        }
    }

    private static StopCause stopCause(Rig r) {
        for (String l : r.lines) {
            if (!kindOf(l).equals("stop")) continue;
            JsonNode cause = bodyOf(l).get("cause");
            return cause == null ? StopCause.UNKNOWN : StopCause.of(cause.stringValue());
        }
        return null;
    }

    /**
     * An ExoPlayer error, end to end: the real {@link ExoDeck} over a real ExoPlayer is asked for a
     * file that is not there; ExoPlayer's error becomes the deck's {@code failed}, and the host's core
     * writes {@code stop cause=error}. TO SEE IT FAIL: drop ExoDeck's {@code onPlayerError}.
     */
    @Test
    public void anExoPlayerErrorThroughTheRealDeckIsAnErrorStop() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            List<String> lines = new ArrayList<>();
            EngineLog log = new EngineLog(() -> 0, lines::add);
            ForayEngineHost host = new ForayEngineHost(new EngineSeams(h.deck, new FakeSession(), new ForayEngineHostTest.FakeTiming(), log),
                    new EngineConfig("test"));
            host.start();
            List<ai.jwlabs.foura.engine.EngineItem> items = new ArrayList<>();
            items.add(ai.jwlabs.foura.engine.EngineItem.of(new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("a")),
                    JsonNode.member("kind", JsonNode.str("episode")), JsonNode.member("audio_url", JsonNode.str("file:///nowhere/a67-none.mp3")),
                    JsonNode.member("duration_sec", JsonNode.num(90))))));
            host.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(items)));
            host.handle(ForayEngineHostTest.playIndex(0));
            h.runUntil(() -> lines.stream().anyMatch(l -> kindOf(l).equals("stop")));
            String stop = lines.stream().filter(l -> kindOf(l).equals("stop")).findFirst().orElseThrow();
            assertEquals(stop, JsonNode.str("error"), bodyOf(stop).get("cause"));
            host.teardown();
        }
    }
}

package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.audio.engine.InterludePlayerTest.FakeJingle;
import ai.jwlabs.foura.audio.engine.LateTimerHostTest.ClockedTiming;
import ai.jwlabs.foura.audio.engine.SpeechNarratorTest.FakeOutput;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import android.os.Looper;
import androidx.media3.common.Player;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

/**
 * Card A-65: the service stays in the foreground through a Foray's silent spans. Media3 keeps a
 * {@code MediaSessionService} in the foreground from its session player alone: play-when-ready on,
 * READY or BUFFERING ({@link EnginePlayer#keepsServiceInForeground}, media3-session 1.11.0's
 * {@code MediaNotificationManager.isAnySessionUserEngaged}). Here the real host (the JVM core, the
 * real {@link SpeechNarrator} and {@link InterludePlayer} over fakes) drives the real
 * {@link EnginePlayer} facade, as the service wires them, on a clock that fires each timer when it is
 * due; the rule is checked every 100 ms through a 3 s seam beat (the jingle sounding, the next clip
 * loading, then parked), through a spoken line, and through a rendered line's spoken fallback.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class SilentSeamKeepAliveTest {
    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final ClockedTiming timing = new ClockedTiming();
        final FakeOutput speech = new FakeOutput();
        final FakeJingle jingle = new FakeJingle();
        final List<String> lines = new ArrayList<>();
        final EngineLog log = new EngineLog(() -> 0, lines::add);
        final InterludePlayer interlude;
        final ForayEngineHost host;
        final EnginePlayer facade;
        /** Every check the clock ran, so a test can say the span was really walked. */
        int checks;

        Rig() {
            SpeechNarrator.Config sc = new SpeechNarrator.Config();
            sc.diag = log::diag;
            SpeechNarrator narrator = new SpeechNarrator(speech, sc);
            InterludePlayer.Config ic = new InterludePlayer.Config();
            ic.diag = log::diag;
            ic.timing = timing;
            ic.makeJingle = () -> jingle;
            interlude = new InterludePlayer(ic);
            EngineConfig config = new EngineConfig("test").withForayTape(true, false).withInterludeAvailable(true);
            host = new ForayEngineHost(new EngineSeams(deck, session, timing, log, narrator, interlude), config);
            host.start();
            // As ForayPlaybackService wires them: the facade reads the host's fresh surface, and every turn refreshes it.
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

        void playForay(JsonNode... items) {
            host.handle(new EngineInput.Command(new EngineContract.Command.PlayForay("f1", "A Foray", Arrays.asList(items),
                    new JsonNode.Obj(List.of()), null, false, false, null), Vocabulary.Source.TAP));
        }

        DeckCommand.Load lastLoad() {
            DeckCommand.Load last = null;
            for (DeckCommand c : deck.sent) if (c instanceof DeckCommand.Load l) last = l;
            return last;
        }

        int state() {
            ShadowLooper.idleMainLooper();
            return facade.getPlaybackState();
        }

        /** Media3's rule, read off the facade as Media3 reads it. */
        void assertKeepsForeground(String when) {
            int state = state();
            assertTrue(when + ": the facade must say play-when-ready with READY or BUFFERING, and says playWhenReady="
                    + facade.getPlayWhenReady() + " state=" + state, EnginePlayer.keepsServiceInForeground(facade));
            checks++;
        }

        /** Run the clocks for {@code ms} in 100 ms steps, firing what is due, and check the rule at every step. */
        void runChecking(double ms, String when) {
            timing.run(ms, 100, () -> assertKeepsForeground(when));
        }

        /** Play clip 0 from its in-point to its out-point. */
        void playFirstClipToItsEnd() {
            DeckCommand.Load first = lastLoad();
            assertKeepsForeground("the first clip loading");
            deck.emit(new DeckEvent.Ready(first.token(), first.startSec(), true, 1));
            assertEquals("a playing clip is READY", Player.STATE_READY, state());
            runChecking(1_000, "the first clip playing");
            deck.reading.positionSec = 200.0;
            deck.emit(new DeckEvent.Ended(first.token()));
        }

        /** Run out whatever seam stands before the next clip (its beat, its jingle) until it plays. */
        void landTheNextClip(DeckCommand.Load next) {
            int plays = deck.count(DeckCommand.Play.class);
            runChecking(200, "the next clip loading");
            deck.emit(new DeckEvent.Ready(next.token(), next.startSec(), true, 1));
            for (int round = 0; round < 10 && deck.count(DeckCommand.Play.class) == plays; round++) {
                runChecking(500, "the seam before the next clip");
                if (interlude.isSounding() && round >= 3) jingle.onFinish.accept(true);
            }
            assertTrue("the next clip plays", deck.count(DeckCommand.Play.class) > plays);
            assertKeepsForeground("the next clip playing");
            assertEquals(Player.STATE_READY, state());
        }
    }

    static JsonNode clip(int index, String name, double start, double end) {
        return ForayEngineHostForayTest.clip(index, name, start, end);
    }

    /**
     * THE 3 s BEAT. A seam across two sources: the jingle sounds from the out-point, the next clip
     * loads under it (1.2 s) and waits for the jingle's end (3 s). No item of the Foray sounds, and
     * the facade says BUFFERING with play-when-ready on the whole time, so Media3 keeps the service
     * in the foreground. TO SEE IT FAIL: report the beat as the core's PLAYING without the beat's
     * BUFFERING (the clock then runs on through the beat; this test pins BUFFERING), or as paused
     * (the service would leave the foreground).
     */
    @Test
    public void throughAThreeSecondBeatTheServiceStaysInTheForeground() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200), clip(1, "b", 300, 400));
        rig.playFirstClipToItsEnd();
        assertTrue("the beat runs", rig.host.state().inSeamGap());
        assertTrue("the jingle sounds in it", rig.interlude.isSounding());
        assertTrue(rig.host.surface().silentSeam());
        assertEquals("the beat is BUFFERING", Player.STATE_BUFFERING, rig.state());
        assertTrue("with play-when-ready on", rig.facade.getPlayWhenReady());
        DeckCommand.Load second = rig.lastLoad();
        assertEquals("f1#1", second.itemId());
        rig.runChecking(1_200, "the beat, the next clip loading");
        rig.deck.emit(new DeckEvent.Ready(second.token(), 300, true, 1));
        assertEquals("a ready clip waits for the jingle", 1, rig.deck.count(DeckCommand.Play.class));
        rig.runChecking(1_800, "the beat, the next clip parked");
        assertTrue("still in the beat at 3 s", rig.host.state().inSeamGap() || rig.host.state().gapParkedToken != null);
        assertEquals(Player.STATE_BUFFERING, rig.state());
        rig.jingle.onFinish.accept(true);
        assertEquals("the jingle's end starts the clip", 2, rig.deck.count(DeckCommand.Play.class));
        rig.assertKeepsForeground("the second clip playing");
        assertEquals(Player.STATE_READY, rig.state());
        assertFalse(rig.host.surface().silentSeam());
        assertTrue("the beat was walked step by step: " + rig.checks, rig.checks >= 30);
    }

    /**
     * A SPOKEN LINE. TextToSpeech speaks it in another process and no deck plays; the facade says
     * play-when-ready on throughout: BUFFERING until the synthesiser starts it, then READY at 1x
     * (A-41: the rate its playhead really moves at), and BUFFERING again while the clip after it
     * loads. TO SEE IT FAIL: publish the line paused, or as the deck's (not playing) state.
     */
    @Test
    public void throughASpokenLineTheServiceStaysInTheForeground() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200), ForayEngineHostForayTest.line(1, "Up next, the second story."), clip(2, "c", 500, 600));
        rig.playFirstClipToItsEnd();
        assertEquals("the line reached the synthesiser", "Up next, the second story.", rig.speech.line.text());
        assertTrue(rig.host.state().isNarrationPlayhead());
        rig.assertKeepsForeground("the spoken line's start");
        rig.runChecking(3_000, "the spoken line");
        assertTrue("still speaking at 3 s", rig.host.state().isNarrationPlayhead());
        rig.speech.end(SpeechNarrator.End.FINISHED);
        DeckCommand.Load next = rig.lastLoad();
        assertEquals("f1#2", next.itemId());
        rig.assertKeepsForeground("the clip after the line loading");
        rig.landTheNextClip(next);
    }

    /**
     * A RENDERED LINE'S SPOKEN FALLBACK (airplane mode): the line's file fails, the synthesiser reads
     * its script instead, and the clip after it loads at the line's end. Play-when-ready stays on
     * through the failure, the fallback and the next load.
     */
    @Test
    public void throughASpokenFallbackTheServiceStaysInTheForeground() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200),
                ForayEngineHostNarrationTest.rendered(1, "https://audio.test/n/line.m4a", "Read me instead."), clip(2, "c", 500, 600));
        rig.playFirstClipToItsEnd();
        DeckCommand.Load line = rig.lastLoad();
        assertEquals("f1#1", line.itemId());
        rig.runChecking(400, "the rendered line loading");
        rig.deck.emit(new DeckEvent.Failed(line.token(), "network", Vocabulary.NarrationFallbackCause.OFFLINE));
        assertEquals("the script is read instead", "Read me instead.", rig.speech.line.text());
        rig.assertKeepsForeground("the fallback's start");
        rig.runChecking(3_000, "the spoken fallback");
        rig.speech.end(SpeechNarrator.End.FINISHED);
        DeckCommand.Load next = rig.lastLoad();
        assertEquals("f1#2", next.itemId());
        rig.landTheNextClip(next);
        assertFalse("nothing in these spans is a late timer", String.join("\n", rig.lines).contains("\"kind\":\"late\""));
    }

    /** A listener's pause is the one span that lets go: play-when-ready off (Media3's ten-minute timeout follows). */
    @Test
    public void aPauseInTheBeatLetsGo() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200), clip(1, "b", 300, 400));
        rig.playFirstClipToItsEnd();
        rig.assertKeepsForeground("the beat");
        rig.host.handle(new EngineInput.Command(EngineContract.Command.PAUSE, Vocabulary.Source.TAP));
        rig.state();
        assertFalse("paused: play-when-ready off", rig.facade.getPlayWhenReady());
        assertFalse(EnginePlayer.keepsServiceInForeground(rig.facade));
    }
}

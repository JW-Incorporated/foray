package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeTiming;
import ai.jwlabs.foura.audio.engine.InterludePlayerTest.FakeJingle;
import ai.jwlabs.foura.audio.engine.SpeechNarratorTest.FakeOutput;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * Card A-41: rendered narration, the TTS fallback seam and the jingle through the Android host, on
 * a plain JVM, with the real {@link SpeechNarrator} and {@link InterludePlayer} over fake outputs. A
 * rendered line is a file on the deck; a spoken line and a rendered line's fallback go to the
 * synthesiser, whose answers drive the core; a seam across two sources carries the jingle, whose end
 * starts the next clip.
 */
public class ForayEngineHostNarrationTest {
    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final FakeTiming timing = new FakeTiming();
        final FakeOutput speech = new FakeOutput();
        final FakeJingle jingle = new FakeJingle();
        final List<String> lines = new ArrayList<>();
        final List<Boolean> awake = new ArrayList<>();
        final EngineLog log = new EngineLog(() -> 0, lines::add);
        final SpeechNarrator narrator;
        final InterludePlayer interlude;
        final ForayEngineHost host;

        Rig() {
            SpeechNarrator.Config sc = new SpeechNarrator.Config();
            sc.diag = log::diag;
            narrator = new SpeechNarrator(speech, sc);
            InterludePlayer.Config ic = new InterludePlayer.Config();
            ic.diag = log::diag;
            ic.timing = timing;
            ic.makeJingle = () -> jingle;
            interlude = new InterludePlayer(ic);
            EngineConfig config = new EngineConfig("test").withForayTape(true, false).withInterludeAvailable(true);
            host = new ForayEngineHost(new EngineSeams(deck, session, timing, log, narrator, interlude), config);
            host.setBeatAwake(awake::add);
            host.start();
        }

        ForayEngineHost.Verdict playForay(JsonNode... items) {
            return host.handle(new EngineInput.Command(new EngineContract.Command.PlayForay("f1", "A Foray", Arrays.asList(items),
                    new JsonNode.Obj(List.of()), null, false, false, null), Vocabulary.Source.TAP));
        }

        DeckCommand.Load lastLoad() {
            DeckCommand.Load last = null;
            for (DeckCommand c : deck.sent) if (c instanceof DeckCommand.Load l) last = l;
            return last;
        }

        /** Play the first clip to its out-point. */
        void runFirstClip() {
            DeckCommand.Load first = lastLoad();
            deck.emit(new DeckEvent.Ready(first.token(), first.startSec(), true, 1));
            deck.reading.positionSec = 200.0;
            timing.mono += 100_000;
            deck.emit(new DeckEvent.Ended(first.token()));
        }

        String rows() {
            return String.join("\n", lines);
        }
    }

    static JsonNode clip(int index, String name, double start, double end) {
        return ForayEngineHostForayTest.clip(index, name, start, end);
    }

    static JsonNode spoken(int index, String script) {
        return ForayEngineHostForayTest.line(index, script);
    }

    static JsonNode rendered(int index, String url, String script) {
        return new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("f1#" + index)), JsonNode.member("kind", JsonNode.str("tts")),
                JsonNode.member("type", JsonNode.str("narration")), JsonNode.member("script", JsonNode.str(script)),
                JsonNode.member("audio_url", JsonNode.str(url)), JsonNode.member("duration_sec", JsonNode.num(4))));
    }

    /**
     * A spoken bridge goes to the synthesiser (its text, at 1x), is the playhead while it speaks,
     * and its END is what moves the Foray on: the next clip loads only then. TO SEE IT FAIL: drop the
     * host's hand-over to the speaker (the line is refused and stepped over at once, A-40's shape).
     */
    @Test
    public void aSpokenBridgeIsSpokenAndItsEndMovesTheForayOn() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200), spoken(1, "Up next, the second story."), clip(2, "c", 500, 600));
        rig.runFirstClip();
        assertEquals("the line reached the synthesiser", "Up next, the second story.", rig.speech.line.text());
        assertEquals(1f, rig.speech.line.rate(), 0);
        assertEquals("f1#1", rig.host.state().currentItem().id);
        assertNotEquals("the next clip waits on the line", "f1#2", rig.lastLoad().itemId());
        assertFalse(rig.rows(), rig.rows().contains("\"kind\":\"unsupported\""));
        rig.speech.end(SpeechNarrator.End.FINISHED);
        assertEquals("the line's end loads the next clip", "f1#2", rig.lastLoad().itemId());
    }

    /**
     * A RENDERED line is an ordinary file on the deck; when the file fails (airplane mode), the core
     * falls back and the synthesiser reads the line's script instead, and that line's end moves the
     * Foray on. TO SEE IT FAIL: route a rendered line to the synthesiser first, or drop the fallback.
     */
    @Test
    public void aRenderedLineIsAFileAndItsFallbackIsSpoken() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200), rendered(1, "https://audio.test/n/line.m4a", "Read me instead."), clip(2, "c", 500, 600));
        rig.runFirstClip();
        DeckCommand.Load line = rig.lastLoad();
        assertEquals("the rendered line loads on the deck, as a file", "f1#1", line.itemId());
        assertEquals("https://audio.test/n/line.m4a", line.url());
        assertEquals("nothing is spoken while the file may play", null, rig.speech.line);
        rig.deck.emit(new DeckEvent.Failed(line.token(), "network"));
        assertTrue(rig.rows(), rig.rows().contains("\"kind\":\"fallback\""));
        assertEquals("the script is read instead", "Read me instead.", rig.speech.line.text());
        rig.speech.end(SpeechNarrator.End.FINISHED);
        assertEquals("f1#2", rig.lastLoad().itemId());
    }

    /**
     * A seam across two sources carries the jingle: it starts at the out-point, the next clip loads
     * under it and waits, and the jingle's END starts the clip. TO SEE IT FAIL: drop the host's
     * jingle start (the clip then starts after the 0.5 s beat, with no jingle), or its end report.
     */
    @Test
    public void aSeamAcrossSourcesCarriesTheJingleAndItsEndStartsTheClip() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200), clip(1, "b", 300, 400));
        rig.runFirstClip();
        assertEquals(1, rig.jingle.plays);
        assertTrue(rig.interlude.isSounding());
        assertTrue(rig.host.state().inInterlude);
        DeckCommand.Load second = rig.lastLoad();
        assertEquals("the next clip loads under the jingle", "f1#1", second.itemId());
        rig.timing.mono += 120;
        rig.deck.emit(new DeckEvent.Ready(second.token(), 300, true, 1));
        assertEquals("a ready clip waits for the jingle", 1, rig.deck.count(DeckCommand.Play.class));
        rig.timing.mono += 2_900;
        rig.jingle.onFinish.accept(true);
        assertEquals("the jingle's end starts the clip", 2, rig.deck.count(DeckCommand.Play.class));
        assertFalse(rig.host.state().inInterlude);
        assertTrue(rig.rows(), rig.rows().contains("\"kind\":\"ended\",\"why\":\"ended\""));
    }

    /**
     * A-41 review: while a spoken line is the running playhead no deck plays (the synthesiser is
     * TextToSpeech, in another process), so the host holds the CPU exactly as it does through the
     * seam beat; a pause lets it go, a resume takes it back, and the next clip's load landing lets it
     * go. TO SEE IT FAIL: key the host's lock on {@code inSeamGap} alone (the line runs with nothing
     * holding the CPU, and with the screen off the phone may sleep before its first word).
     */
    @Test
    public void aSpokenLineHoldsTheCpuWhileItIsTheRunningPlayhead() {
        Rig rig = new Rig();
        rig.playForay(clip(0, "a", 100, 200), spoken(1, "Up next, the second story."), clip(2, "c", 500, 600));
        DeckCommand.Load first = rig.lastLoad();
        rig.deck.emit(new DeckEvent.Ready(first.token(), first.startSec(), true, 1));
        assertFalse("a playing clip needs no host lock", rig.host.holdsBeatWakeLock());
        rig.deck.reading.positionSec = 200.0;
        rig.timing.mono += 100_000;
        rig.deck.emit(new DeckEvent.Ended(first.token()));
        assertEquals("Up next, the second story.", rig.speech.line.text());
        assertTrue(rig.host.state().isNarrationPlayhead());
        assertTrue("the spoken line holds the CPU", rig.host.holdsBeatWakeLock());
        rig.host.handle(new EngineInput.Command(EngineContract.Command.PAUSE, Vocabulary.Source.TAP));
        assertFalse("a paused line lets it go", rig.host.holdsBeatWakeLock());
        rig.host.handle(new EngineInput.Command(EngineContract.Command.PLAY, Vocabulary.Source.TAP));
        assertTrue("a resumed line takes it back", rig.host.holdsBeatWakeLock());
        rig.speech.end(SpeechNarrator.End.FINISHED);
        DeckCommand.Load next = rig.lastLoad();
        assertEquals("f1#2", next.itemId());
        int playsBefore = rig.deck.count(DeckCommand.Play.class);
        rig.timing.mono += 120;
        rig.deck.emit(new DeckEvent.Ready(next.token(), 500, true, 1));
        // The seam into the clip (its beat, and a jingle if it carries one) may still hold the lock
        // as the seam's own; run it out, and then nothing holds it.
        for (int round = 0; round < 3 && rig.deck.count(DeckCommand.Play.class) == playsBefore; round++) {
            rig.timing.mono += 5_000;
            for (ForayEngineHostTest.FakeTiming.Scheduled s : new ArrayList<>(rig.timing.live())) {
                if (!s.repeating && s.afterMs > 0 && s.afterMs <= 5_000) s.fire.run();
            }
            if (rig.interlude.isSounding()) rig.jingle.onFinish.accept(true);
        }
        assertTrue("the next clip plays", rig.deck.count(DeckCommand.Play.class) > playsBefore);
        assertFalse(rig.host.state().isNarrationPlayhead());
        assertFalse(rig.host.state().inSeamGap());
        assertFalse("the next clip playing lets it go", rig.host.holdsBeatWakeLock());
    }

    /**
     * The audition goes to the same synthesiser, and a teardown silences and lets go of both the
     * synthesiser and the jingle. TO SEE IT FAIL: leave the speaker or the jingle alive past a
     * teardown (a line or a jingle heard after the engine gave the process back).
     */
    @Test
    public void theAuditionIsSpokenAndATeardownLetsBothGo() {
        Rig rig = new Rig();
        rig.host.handle(new EngineInput.Command(new EngineContract.Command.Audition("Hear this voice.", null), Vocabulary.Source.TAP));
        assertEquals("Hear this voice.", rig.speech.line == null ? null : rig.speech.line.text());
        rig.host.teardown();
        assertTrue(rig.speech.calls.contains("release"));
        assertTrue(rig.jingle.released || rig.jingle.plays == 0);
        assertFalse(rig.interlude.isSounding());
    }
}

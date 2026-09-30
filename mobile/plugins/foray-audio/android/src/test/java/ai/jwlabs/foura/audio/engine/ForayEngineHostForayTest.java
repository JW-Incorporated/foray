package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeTiming;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineTimer;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * Card A-40: the Foray tape through the Android host, on a plain JVM. The seam beat is an ordinary
 * host timer, the packed {@code seam} row lands when the next clip becomes audible, a spoken line is
 * refused at once (no synthesiser until A-41) so the core steps over it, and a core built without
 * the tape still refuses {@code playForay}.
 */
public class ForayEngineHostForayTest {
    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final FakeTiming timing = new FakeTiming();
        final List<String> lines = new ArrayList<>();
        final EngineLog log = new EngineLog(() -> 0, lines::add);
        final ForayEngineHost host;

        Rig(boolean tape) {
            EngineConfig config = new EngineConfig("test").withForayTape(tape, false);
            host = new ForayEngineHost(new EngineSeams(deck, session, timing, log), config);
            host.start();
        }

        ForayEngineHost.Verdict playForay(JsonNode... items) {
            return host.handle(new EngineInput.Command(new EngineContract.Command.PlayForay("f1", "A Foray", Arrays.asList(items),
                    new JsonNode.Obj(List.of()), null, false, false, null), Vocabulary.Source.TAP));
        }

        /** Fire every live timer of this kind (the host's one-shots). */
        void fire(EngineTimer timer) {
            for (FakeTiming.Scheduled s : new ArrayList<>(timing.live())) {
                s.fire.run();
            }
        }

        String rows() {
            return String.join("\n", lines);
        }
    }

    static JsonNode clip(int index, String name, double start, double end) {
        return new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("f1#" + index)), JsonNode.member("kind", JsonNode.str("episode")),
                JsonNode.member("audio_url", JsonNode.str("https://cdn.test/" + name + ".mp3")),
                JsonNode.member("start_sec", JsonNode.num(start)), JsonNode.member("end_sec", JsonNode.num(end)),
                JsonNode.member("duration_sec", JsonNode.num(3600))));
    }

    static JsonNode line(int index, String script) {
        return new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("f1#" + index)), JsonNode.member("kind", JsonNode.str("tts")),
                JsonNode.member("type", JsonNode.str("narration")), JsonNode.member("script", JsonNode.str(script)),
                JsonNode.member("audio_url", JsonNode.NULL), JsonNode.member("duration_sec", JsonNode.num(4))));
    }

    private static DeckCommand.Load lastLoad(FakeDeck deck) {
        DeckCommand.Load last = null;
        for (DeckCommand c : deck.sent) if (c instanceof DeckCommand.Load l) last = l;
        return last;
    }

    /**
     * A clip loads at its in-point and plays; at its out-point the beat is armed as a host timer and
     * the next clip loads INSIDE it; the beat's timer is what starts the second clip, and the
     * packed seam row says what the beat asked for. TO SEE IT FAIL: start the second clip at ready.
     */
    @Test
    public void aSeamIsTheBeatTimerThenTheNextClipAndItsRow() {
        Rig rig = new Rig(true);
        assertTrue(rig.playForay(clip(0, "a", 100, 200), clip(1, "b", 300, 400)).ok());
        DeckCommand.Load first = lastLoad(rig.deck);
        assertEquals("f1#0", first.itemId());
        assertEquals(100, first.startSec(), 0);
        assertTrue("a segment seeks precisely", first.preciseTiming());
        rig.deck.emit(new DeckEvent.Ready(first.token(), 100, true, 1));
        assertEquals("the first clip plays at once (no beat before it)", 1, rig.deck.count(DeckCommand.Play.class));
        assertTrue("its out-point is armed", rig.deck.sent.contains(new DeckCommand.SetOutPoint(200.0)));

        rig.deck.reading.positionSec = 200.0;
        rig.timing.mono += 100_000;
        rig.deck.emit(new DeckEvent.Ended(first.token()));
        DeckCommand.Load second = lastLoad(rig.deck);
        assertEquals("the next clip loads inside the beat", "f1#1", second.itemId());
        assertEquals(300, second.startSec(), 0);
        assertTrue(rig.host.state().inSeamGap());
        rig.timing.mono += 120;
        rig.deck.emit(new DeckEvent.Ready(second.token(), 300, true, 1));
        assertEquals("ready alone does not start it: the beat still runs", 1, rig.deck.count(DeckCommand.Play.class));
        assertTrue("the beat's remainder is a host timer", rig.host.liveTimers().contains(EngineTimer.SEAM_BEAT));

        rig.timing.mono += 380;
        for (ForayEngineHostTest.FakeTiming.Scheduled s : new ArrayList<>(rig.timing.live())) {
            if (s.afterMs > 0 && s.afterMs < 1000) s.fire.run();
        }
        assertEquals("the beat's end starts the second clip", 2, rig.deck.count(DeckCommand.Play.class));
        assertFalse(rig.host.state().inSeamGap());
        String rows = rig.rows();
        assertTrue(rows, rows.contains("\"askedGapMs\":500"));
        assertTrue(rows, rows.contains("\"observedGapMs\":500"));
    }

    /**
     * A spoken line with no synthesiser (A-41's): the host answers {@code failed} for its utterance,
     * the core steps over the bridge, and the clip after it loads. TO SEE IT FAIL: drop the host's
     * answer (the Foray then waits on a line nobody speaks).
     */
    @Test
    public void aSpokenBridgeWithNoSynthesiserIsSteppedOver() {
        Rig rig = new Rig(true);
        rig.playForay(clip(0, "a", 100, 200), line(1, "Up next, the second story."), clip(2, "c", 500, 600));
        DeckCommand.Load first = lastLoad(rig.deck);
        rig.deck.emit(new DeckEvent.Ready(first.token(), 100, true, 1));
        rig.deck.reading.positionSec = 200.0;
        rig.deck.emit(new DeckEvent.Ended(first.token()));
        DeckCommand.Load next = lastLoad(rig.deck);
        assertEquals("the line is stepped over", "f1#2", next.itemId());
        assertTrue(rig.rows(), rig.rows().contains("\"kind\":\"unsupported\""));
    }

    /** Without the tape (a core built as M1's), playForay is refused {@code capability-off}. */
    @Test
    public void aCoreWithoutTheTapeRefusesAForay() {
        Rig rig = new Rig(false);
        ForayEngineHost.Verdict verdict = rig.playForay(clip(0, "a", 100, 200));
        assertEquals(List.of(EngineContract.Refusal.CAPABILITY_OFF.token), verdict.failures());
        assertEquals(0, rig.deck.count(DeckCommand.Load.class));
    }
}

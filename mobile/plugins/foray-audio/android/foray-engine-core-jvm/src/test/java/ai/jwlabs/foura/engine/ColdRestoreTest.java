package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import ai.jwlabs.foura.engine.EngineInput.LifecycleEvent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * Card A-27: the core rebuilt from its own restore record (plan §4.5), and the Developer
 * {@code simulateTermination} command that writes one on demand. The JVM twin of the Swift
 * ColdRestoreTests (NE-24); the host's half (the boot, Media3's resumption) is foray-audio's
 * ForayEngineHostTest and ForayPlaybackServiceTest.
 */
public class ColdRestoreTest {
    private static final EngineNow NOW = new EngineNow(1_790_000_000_000.0, 1000, DeckReading.idle());

    private static JsonNode item(String id) {
        return obj(JsonNode.member("id", JsonNode.str(id)), JsonNode.member("kind", JsonNode.str("episode")),
                JsonNode.member("audio_url", JsonNode.str("https://cdn.example/" + id + ".mp3")),
                JsonNode.member("duration_sec", JsonNode.num(3600)));
    }

    private static JsonNode obj(JsonNode.Member... members) {
        return new JsonNode.Obj(Arrays.asList(members));
    }

    private static final JsonNode EVENT = obj(JsonNode.member("seq", JsonNode.num(7)), JsonNode.member("kind", JsonNode.str("position")),
            JsonNode.member("episode_id", JsonNode.str("a")), JsonNode.member("seconds", JsonNode.num(600)),
            JsonNode.member("duration", JsonNode.NULL), JsonNode.member("at", JsonNode.num(1_790_000_000_000.0)));

    private static final JsonNode ADVANCE = obj(JsonNode.member("planSeq", JsonNode.num(2)), JsonNode.member("hopSeq", JsonNode.num(0)),
            JsonNode.member("nextId", JsonNode.str("b")), JsonNode.member("seq", JsonNode.num(4)),
            JsonNode.member("at", JsonNode.num(1_790_000_000_000.0)));

    private static RestoreRecord record(RestoreRecord.Mode mode, List<JsonNode> queue, String voiceId) {
        return new RestoreRecord(mode, queue, 1, 812.5, mode == RestoreRecord.Mode.FORAY ? "f1" : null, 1.25, voiceId,
                Collections.singletonList(ADVANCE), Collections.singletonList(EVENT), "2026-09-24T12:00:00.000Z", "2026092500");
    }

    private static RestoreRecord record() {
        return record(RestoreRecord.Mode.EPISODE, Arrays.asList(item("a"), item("b")), "voice-b");
    }

    /**
     * What the record carries comes back, through the stored string (the bytes a killed
     * process left), and the queue arrives through {@code coldLaunch} without a single audible
     * or session command. TO SEE IT FAIL: forget the pending events, the advance log, the rate,
     * the voice or the offset in {@code restoring}.
     */
    @Test
    public void aRecordRoundTripsIntoACoreThatPaintsWithoutActivating() {
        RestoreRecord stored = RestoreRecord.parse(record().serialized());
        assertNotNull(stored);
        EngineCore.ColdRestore cold = EngineCore.restoring(stored, new EngineConfig("b"));
        assertNotNull(cold);
        List<String> ids = new ArrayList<>();
        for (EngineItem i : cold.queue()) ids.add(i.id);
        assertEquals(Arrays.asList("a", "b"), ids);
        assertEquals(1, cold.index());
        EngineCore core = cold.core();
        assertEquals(1.25, core.state().rate, 0);
        assertEquals(812.5, core.state().positions.get("b").seconds(), 0);
        assertEquals(1, core.state().pendingEvents.size());
        assertEquals(7, core.state().pendingEvents.get(0).seq());
        assertEquals("re-sent to the page byte for byte", JSWriter.stringify(EVENT),
                JSWriter.stringify(core.state().pendingEvents.get(0).node()));
        assertEquals(7, core.state().lastEventSeq);
        assertEquals(1, core.state().advanceLog.size());
        assertEquals(4, core.state().advanceLog.get(0).seq());
        assertEquals(JSWriter.stringify(ADVANCE), JSWriter.stringify(core.state().advanceLog.get(0).node()));
        assertEquals(4, core.state().lastAdvanceSeq);
        assertEquals("voice-b", core.state().voiceId);

        List<EngineCommand> out = core.handle(new EngineInput.Lifecycle(new LifecycleEvent.ColdLaunch(cold.queue(), cold.index(), false)), NOW);
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.Deck || c instanceof EngineCommand.SessionActivate || c instanceof EngineCommand.Speak
                    || c instanceof EngineCommand.GraceBegin) {
                fail("a cold boot is silent and inactive: " + c);
            }
        }
        assertEquals("b", core.state().currentItem().id);
        assertEquals(SessionPolicy.Phase.INACTIVE, core.state().session);
        MediaMapping.View view = core.mediaView(DeckReading.idle());
        assertNotNull("the restored item is what the session shows", view);
        assertEquals("paused at the recorded offset", 812.5, view.positionSec, 0);
        assertFalse(view.playing);
    }

    /**
     * Nothing is guessed: a relinquished record, a Foray (A-40's), an empty queue, an index
     * outside the queue, or an item with no id restores nothing. TO SEE IT FAIL: restore a
     * Foray, or skip the per-item check.
     */
    @Test
    public void recordsWithNothingToPlayRestoreNothing() {
        EngineConfig config = new EngineConfig();
        assertNull(EngineCore.restoring(null, config));
        assertNull(EngineCore.restoring(RestoreRecord.relinquished("2026-09-24T12:00:00.000Z", "b"), config));
        assertNull(EngineCore.restoring(record(RestoreRecord.Mode.FORAY, Arrays.asList(item("a"), item("b")), null), config));
        assertNull(EngineCore.restoring(new RestoreRecord(RestoreRecord.Mode.EPISODE, Collections.<JsonNode>emptyList(), 0, 0, null, 1,
                null, Collections.<JsonNode>emptyList(), Collections.<JsonNode>emptyList(), "2026-09-24T12:00:00.000Z", "b"), config));
        JsonNode noId = obj(JsonNode.member("kind", JsonNode.str("episode")));
        assertNull(EngineCore.restoring(record(RestoreRecord.Mode.EPISODE, Arrays.asList(noId, item("b")), null), config));
    }

    /**
     * An entry the record holds that this build cannot trust is dropped, never guessed at; the
     * rest still come back. TO SEE IT FAIL: accept a fractional or negative {@code seq}, or a
     * hop with no {@code nextId}.
     */
    @Test
    public void untrustworthyEventsAndHopsAreDropped() {
        assertNull(EngineCommand.PendingEvent.restored(obj(JsonNode.member("seq", JsonNode.num(1.5)),
                JsonNode.member("kind", JsonNode.str("position")), JsonNode.member("episode_id", JsonNode.str("a")),
                JsonNode.member("seconds", JsonNode.num(1)), JsonNode.member("at", JsonNode.num(1)))));
        assertNull(EngineCommand.PendingEvent.restored(obj(JsonNode.member("seq", JsonNode.num(-1)),
                JsonNode.member("kind", JsonNode.str("position")), JsonNode.member("episode_id", JsonNode.str("a")),
                JsonNode.member("seconds", JsonNode.num(1)), JsonNode.member("at", JsonNode.num(1)))));
        assertNull(EngineCommand.AdvanceEntry.restored(obj(JsonNode.member("planSeq", JsonNode.num(0)),
                JsonNode.member("hopSeq", JsonNode.num(0)), JsonNode.member("seq", JsonNode.num(1)), JsonNode.member("at", JsonNode.num(1)))));
        EngineCommand.PendingEvent kept = EngineCommand.PendingEvent.restored(EVENT);
        assertNotNull(kept);
        assertNull("a null duration is none", kept.duration());
        EngineCommand.AdvanceEntry hop = EngineCommand.AdvanceEntry.restored(ADVANCE);
        assertNotNull(hop);
        assertEquals("b", hop.hop().nextId());
        assertEquals(2, hop.hop().planSeq());
    }

    /**
     * DV-7a's command: with a queue it writes the record from the state it has NOW; with none
     * it is refused {@code not-loaded}, and writes nothing. TO SEE IT FAIL: drop the
     * {@code writeRestore()} or the empty-queue refusal.
     */
    @Test
    public void simulateTerminationWritesTheRecordOrIsRefused() {
        EngineCore idle = new EngineCore(new EngineConfig("b"));
        List<EngineCommand> refused = idle.handle(new EngineInput.Command(new EngineContract.Command.SimulateTermination(),
                Vocabulary.Source.TAP), NOW);
        assertTrue(refused.toString(), refused.contains(new EngineCommand.CommandFailed("not-loaded")));
        for (EngineCommand c : refused) assertFalse(c instanceof EngineCommand.WriteRestore);

        EngineCore.ColdRestore cold = EngineCore.restoring(record(), new EngineConfig("b"));
        assertNotNull(cold);
        EngineCore core = cold.core();
        core.handle(new EngineInput.Lifecycle(new LifecycleEvent.ColdLaunch(cold.queue(), cold.index(), false)), NOW);
        List<EngineCommand> out = core.handle(new EngineInput.Command(new EngineContract.Command.SimulateTermination(),
                Vocabulary.Source.TAP), NOW);
        RestoreRecord written = null;
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.WriteRestore w && w.record() != null) written = w.record();
            assertFalse(out.toString(), c instanceof EngineCommand.CommandFailed);
        }
        assertNotNull(out.toString(), written);
        assertEquals(RestoreRecord.Mode.EPISODE, written.mode());
        assertEquals(1, written.index());
        assertEquals(812.5, written.offsetSec(), 0);
        assertEquals(Collections.singletonList(JSWriter.stringify(EVENT)),
                Collections.singletonList(JSWriter.stringify(written.pendingEvents().get(0))));
        assertEquals("the voice survives a second death", "voice-b", written.voiceId());
    }
}

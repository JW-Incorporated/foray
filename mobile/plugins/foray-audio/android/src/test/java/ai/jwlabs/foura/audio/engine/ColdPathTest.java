package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.SessionPolicy;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * Card A-27: THE COLD PATH over the host's recording seams, on a plain JVM: what a car's PLAY
 * meets after Android killed 4a. The JVM twin of the iOS ColdPathTests (NE-24). The boot here
 * is the one {@code ForayPlaybackService} runs when Media3 applies its playback resumption
 * answer ({@code restoreIfCold}); these tests pin what that boot does, minus ExoPlayer.
 */
public class ColdPathTest {
    private static JsonNode itemNode(String id) {
        return new JsonNode.Obj(Arrays.asList(JsonNode.member("id", JsonNode.str(id)), JsonNode.member("kind", JsonNode.str("episode")),
                JsonNode.member("title", JsonNode.str("Episode " + id)), JsonNode.member("show", JsonNode.str("A Show")),
                JsonNode.member("audio_url", JsonNode.str("https://cdn.example/" + id + ".mp3")),
                JsonNode.member("duration_sec", JsonNode.num(3600))));
    }

    private static final JsonNode EVENT = new JsonNode.Obj(Arrays.asList(JsonNode.member("seq", JsonNode.num(3)),
            JsonNode.member("kind", JsonNode.str("position")), JsonNode.member("episode_id", JsonNode.str("a")),
            JsonNode.member("seconds", JsonNode.num(700)), JsonNode.member("duration", JsonNode.num(3600)),
            JsonNode.member("at", JsonNode.num(1_790_000_000_000.0))));

    /** What the engine wrote at the pause before Android ended the process. */
    static RestoreRecord record(double offsetSec) {
        return new RestoreRecord(RestoreRecord.Mode.EPISODE, Arrays.asList(itemNode("a"), itemNode("b")), 0, offsetSec, null, 1.5, null,
                Collections.<JsonNode>emptyList(), Collections.singletonList(EVENT), "2026-09-24T12:00:00.000Z", "android-1");
    }

    /**
     * Plan §4.5 and S-3: a boot from a record publishes the recorded item paused, AT the recorded
     * position, with ZERO activations and nothing sent to the deck, and play enabled, so the
     * session says 4a can play without 4a interrupting anybody. TO SEE IT FAIL: coldLaunch with
     * {@code autoplay: true}, skip the coldLaunch (nothing painted), or drop the record's offset.
     */
    @Test
    public void bootFromARecordPaintsPausedAtTheRecordedPositionWithoutActivating() {
        ForayEngineHostTest.Rig r = new ForayEngineHostTest.Rig();
        assertEquals(ForayEngineHost.ColdBootOutcome.PAINTED, r.host.coldBoot(record(754)));

        assertEquals("a cold boot activates nothing (S-3)", 0, r.session.activations);
        assertTrue("a cold boot loads nothing: " + r.deck.sent, r.deck.sent.isEmpty());
        ForayEngineHost.Surface s = r.host.surface();
        assertTrue("the car's play must be enabled", s.availability().isEnabled(MediaMapping.RemoteCommand.PLAY));
        assertFalse(s.availability().isEnabled(MediaMapping.RemoteCommand.STOP));
        assertNotNull("the session shows the restored item", s.view());
        assertEquals("Episode a", s.view().metadata().title());
        assertEquals(MediaMapping.PAUSED, s.view().playbackState());
        assertEquals(754, s.view().positionState().position(), 0);
        assertEquals(3600, s.view().positionState().duration(), 0);

        assertEquals(0, r.host.state().currentIndex);
        assertEquals(2, r.host.state().queue.size());
        assertEquals("the listener's speed came back", 1.5, r.host.state().rate, 0);
        assertEquals("an undrained event survives the death", 3, r.host.state().pendingEvents.get(0).seq());
        assertEquals("the next event is numbered after it", 3, r.host.state().lastEventSeq);
        assertEquals(SessionPolicy.Phase.INACTIVE, r.host.state().session);
        List<String> rows = r.rows("restore");
        assertEquals(rows.toString(), 1, rows.size());
        assertTrue(rows.get(0), rows.get(0).contains("\"kind\":\"cold-boot\"") && rows.get(0).contains("\"record\":\"painted\"")
                && rows.get(0).contains("\"items\":2"));
    }

    /**
     * The car's play after the cold boot: the grace span opens, ONE activation, then the load AT
     * THE RECORDED OFFSET, and the system is told success. TO SEE IT FAIL: load from 0 (drop the
     * restored position), or answer the press before the load.
     */
    @Test
    public void aColdPlayActivatesOnceAndLoadsAtTheRecordedOffset() {
        ForayEngineHostTest.Rig r = new ForayEngineHostTest.Rig();
        r.host.coldBoot(record(754));

        ForayEngineHost.Verdict v = r.host.remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY));
        assertEquals("success", ForayEngineHost.statusToken(v));
        assertEquals(1, r.session.activations);
        DeckCommand.Load load = null;
        for (DeckCommand c : r.deck.sent) if (c instanceof DeckCommand.Load l) load = l;
        assertNotNull("the play loaded: " + r.deck.sent, load);
        assertEquals("a", load.itemId());
        assertEquals("the car resumes where the listener paused", 754, load.startSec(), 0);
        assertEquals(SessionPolicy.Phase.ACTIVE, r.host.state().session);
        List<String> grace = r.rows("grace");
        assertFalse("the resume's latency is a row: " + grace, grace.isEmpty());
        assertTrue(grace.get(0), grace.get(0).contains("\"kind\":\"begin\""));
    }

    /**
     * Plan §4.5: with no record, or a {@code {mode: "relinquished"}} one, the session still
     * answers the press (not dropped), paints nothing, activates nothing, and says
     * {@code noActionableNowPlayingItem}. TO SEE IT FAIL: restore a relinquished record's queue.
     */
    @Test
    public void noRecordOrARelinquishedRecordAnswersNoActionableNowPlayingItem() {
        Object[][] cases = {
            {null, ForayEngineHost.ColdBootOutcome.NO_RECORD},
            {RestoreRecord.relinquished("2026-09-24T12:00:00.000Z", "android-1"), ForayEngineHost.ColdBootOutcome.RELINQUISHED},
        };
        for (Object[] c : cases) {
            ForayEngineHostTest.Rig r = new ForayEngineHostTest.Rig();
            assertEquals(c[1], r.host.coldBoot((RestoreRecord) c[0]));
            assertNull("nothing to paint", r.host.surface().view());
            ForayEngineHost.Verdict v = r.host.remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY));
            assertEquals("noActionableNowPlayingItem", ForayEngineHost.statusToken(v));
            assertEquals(0, r.session.activations);
            assertTrue(r.deck.sent.isEmpty());
        }
    }

    /**
     * A Foray record (A-40's) or a queue item with no id is not guessed at: {@code unplayable},
     * painted as nothing. And a cold boot after the first input never replaces the core an input
     * is already driving. TO SEE IT FAIL: drop the {@code handledAny} guard, or restore a Foray.
     */
    @Test
    public void unplayableAndLateRecordsAreNeverRestored() {
        RestoreRecord foray = new RestoreRecord(RestoreRecord.Mode.FORAY, Arrays.asList(itemNode("a")), 0, 30, "f1", 1, null,
                Collections.<JsonNode>emptyList(), Collections.<JsonNode>emptyList(), "2026-09-24T12:00:00.000Z", "android-1");
        RestoreRecord noId = new RestoreRecord(RestoreRecord.Mode.EPISODE,
                Collections.<JsonNode>singletonList(new JsonNode.Obj(Collections.singletonList(JsonNode.member("kind", JsonNode.str("episode"))))),
                0, 30, null, 1, null, Collections.<JsonNode>emptyList(), Collections.<JsonNode>emptyList(), "2026-09-24T12:00:00.000Z", "android-1");
        for (RestoreRecord rec : Arrays.asList(foray, noId)) {
            ForayEngineHostTest.Rig r = new ForayEngineHostTest.Rig();
            assertEquals(ForayEngineHost.ColdBootOutcome.UNPLAYABLE, r.host.coldBoot(rec));
            assertTrue(r.host.state().queue.isEmpty());
            assertNull(r.host.surface().view());
        }

        ForayEngineHostTest.Rig r = new ForayEngineHostTest.Rig();
        r.host.handle(ForayEngineHostTest.load("x"));
        int rowsBefore = r.lines.size();
        assertEquals(ForayEngineHost.ColdBootOutcome.LATE, r.host.coldBoot(record(754)));
        assertEquals("the page's queue stands", "x", r.host.state().queue.get(0).id);
        assertEquals("a late boot writes no row", rowsBefore, r.lines.size());

        ForayEngineHostTest.Rig once = new ForayEngineHostTest.Rig();
        assertEquals(ForayEngineHost.ColdBootOutcome.PAINTED, once.host.coldBoot(record(754)));
        assertEquals("a second boot is late: the first one's queue is the core's now",
                ForayEngineHost.ColdBootOutcome.LATE, once.host.coldBoot(record(100)));
        once.host.teardown();
        assertEquals(ForayEngineHost.ColdBootOutcome.LATE, once.host.coldBoot(record(754)));
        assertEquals(EngineContract.Refusal.RELINQUISHED.token,
                once.host.remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY)).failures().get(0));
    }
}

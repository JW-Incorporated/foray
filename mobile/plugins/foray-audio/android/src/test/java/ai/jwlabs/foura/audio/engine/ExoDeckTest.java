package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import androidx.media3.common.Player;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-25: the ExoPlayer deck behind the DeckDriving seam, driven through the core's own
 * vocabulary on a media3-test-utils player ({@code TestExoPlayerBuilder}, an auto-advancing
 * {@code FakeClock}) over NE-25a's click tracks. The Android twin of AVDeckTests.
 *
 * <p>What each test pins is named in its title. The in-point and out-point MEASUREMENTS are
 * {@link ExoDeckMeasurementTest}'s.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ExoDeckTest {
    private static ClickTracks.Fixture fixture(String file) {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.file.equals(file)) return f;
        throw new AssertionError("no click track " + file);
    }

    private static final ClickTracks.Fixture CBR = fixture("click-cbr.mp3");
    private static final ClickTracks.Fixture XING = fixture("click-vbr-xing.mp3");

    private static DeckCommand load(int token, ClickTracks.Fixture f, double startSec) {
        return new DeckCommand.Load(token, "ep-" + token, f.uri().toString(), startSec, false);
    }

    @Test
    public void aLoadIsGatedOnReadinessAndPlayIsRefusedUntilReady() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 30.0));
            // While gating, the playhead reads as the start it will land on, and nothing sounds.
            DeckReading gating = h.deck.reading();
            assertEquals(30.0, gating.positionSec, 0);
            assertFalse(gating.audible);
            h.deck.send(DeckCommand.PLAY);
            DeckEvent.Refused refused = h.find(DeckEvent.Refused.class);
            assertNotNull("a play before ready is refused", refused);
            assertEquals("play", refused.command());
            assertEquals("not-ready", refused.reason());
            assertFalse("the refused play did not start the player", h.player.getPlayWhenReady());

            DeckEvent.Ready ready = h.await(DeckEvent.Ready.class);
            assertEquals(1, ready.token());
            assertEquals(30.0, ready.landedSec(), 0.0005);
            assertTrue("READY with play-when-ready off is the preroll", ready.prerolled());
            DeckEvent.DurationLoaded duration = h.find(DeckEvent.DurationLoaded.class);
            assertNotNull("the duration is reported", duration);
            assertEquals(90.0, duration.durationSec(), 0.1);
            assertTrue("the duration comes before ready", h.events.indexOf(duration) < h.events.indexOf(ready));
            assertFalse("ready does not play", h.player.getPlayWhenReady());
            assertEquals("no-item", DeckHarness.str(h.deckRows("attach").get(0), "cold"));
            assertEquals(1, h.deckRows("ready").size());

            h.deck.send(DeckCommand.PLAY);
            h.runUntil(() -> h.player.isPlaying());
            h.runFor(1500);
            DeckReading playing = h.deck.reading();
            assertTrue(playing.audible);
            assertTrue("the playhead moves: " + playing.positionSec, playing.positionSec >= 31.4 && playing.positionSec <= 31.6);
            assertTrue(h.deck.primitives().contains("attach"));
            assertTrue(h.deck.primitives().contains("play rate=1"));
            assertTrue("no fault with the session active", h.faults.isEmpty());
        }
    }

    @Test
    public void aPlayWithoutAnActiveSessionWritesTheFaultAndStillPlays() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.sessionActive = false;
            h.deck.send(load(1, CBR, 5.0));
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            assertEquals(List.of("fault implicit-activation deck token=1"), h.faults);
            h.runUntil(() -> h.player.isPlaying());
        }
    }

    @Test
    public void theRateIsHeldAcrossLoadsAndReappliedOnEveryPlay() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(new DeckCommand.SetRate(1.5));
            h.deck.send(load(1, CBR, 10.0));
            h.await(DeckEvent.Ready.class);
            h.player.setPlaybackSpeed(1f); // something else reset it
            h.deck.send(DeckCommand.PLAY);
            assertEquals(1.5f, h.player.getPlaybackParameters().speed, 0);
            assertTrue(h.deck.primitives().contains("play rate=1.5"));
            h.runFor(2000);
            double at = h.deck.reading().positionSec;
            assertTrue("1.5x for 2 s of wall clock is 3 s of content: " + at, at >= 12.9 && at <= 13.1);
            h.deck.send(new DeckCommand.SetRate(0));
            DeckEvent.Refused refused = h.find(DeckEvent.Refused.class);
            assertNotNull(refused);
            assertEquals("setRate", refused.command());
            assertEquals("non-positive", refused.reason());
            assertEquals(1.5f, h.player.getPlaybackParameters().speed, 0);
        }
    }

    @Test
    public void aLoadOfTheSameSourceIsASeekInTheHeldSourceNotARefetch() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 10.0));
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            h.runFor(1000);
            h.deck.send(DeckCommand.PAUSE);
            int from = h.events.size();
            // The core's in-place resume: a fresh token for the item the deck holds.
            h.deck.send(load(2, CBR, 10.5));
            DeckEvent.Ready ready = h.await(DeckEvent.Ready.class, from);
            assertEquals(2, ready.token());
            assertEquals(10.5, ready.landedSec(), 0.0005);
            assertNull("a reuse does not report the duration again", h.find(DeckEvent.DurationLoaded.class, from));
            List<String> primitives = h.deck.primitives();
            assertEquals("one attach for both loads: " + primitives, 1, primitives.stream().filter("attach"::equals).count());
            assertTrue(primitives.contains("reuse"));
            EngineCommand.DiagEntry reuse = h.deckRows("reuse").get(0);
            assertEquals(10.5, DeckHarness.num(reuse, "startSec"), 0);
            assertEquals(1, h.deckRows("ready").stream().filter(r -> Boolean.TRUE.equals(isTrue(r, "reuse"))).count());

            // Another source is a cold load, and the row says why.
            h.deck.send(load(3, XING, 4.0));
            h.await(DeckEvent.Ready.class, h.events.indexOf(ready) + 1);
            List<EngineCommand.DiagEntry> attaches = h.deckRows("attach");
            assertEquals(2, attaches.size());
            assertEquals("other-source", DeckHarness.str(attaches.get(1), "cold"));
            // The same URL with the other timing option is cold too: it is another seek map.
            int before = h.events.size();
            h.deck.send(new DeckCommand.Load(4, "ep-4", XING.uri().toString(), 6.0, true));
            h.await(DeckEvent.Ready.class, before);
            assertEquals("timing", DeckHarness.str(h.deckRows("attach").get(2), "cold"));
        }
    }

    private static Boolean isTrue(EngineCommand.DiagEntry row, String key) {
        return row.field(key) instanceof ai.jwlabs.foura.engine.JsonNode.Bool b ? b.value() : null;
    }

    @Test
    public void aLoadThatNeverBecomesReadyHitsTheDeadlineAndNothingSoundsLate() throws Exception {
        GatedDataSource.Gate gate = new GatedDataSource.Gate(0);
        try (DeckHarness h = new DeckHarness(GatedDataSource.factory(gate), c -> c.loadDeadlineSec = 3)) {
            h.deck.send(load(1, CBR, 12.0));
            DeckEvent.DeadlineExceeded deadline = h.await(DeckEvent.DeadlineExceeded.class);
            assertEquals(1, deadline.token());
            assertTrue("after the deadline: " + deadline.afterMs(), deadline.afterMs() >= 3000);
            EngineCommand.DiagEntry row = h.deckRows("deadline").get(0);
            assertEquals("prepare", DeckHarness.str(row, "step"));
            assertEquals(0, h.player.getMediaItemCount());
            // The network comes back: the detached load must not become ready or sound.
            gate.open();
            h.runFor(3000);
            assertNull("a load past its deadline never reports ready", h.find(DeckEvent.Ready.class));
            assertFalse(h.player.getPlayWhenReady());
            h.deck.send(DeckCommand.PLAY);
            DeckEvent.Refused refused = h.find(DeckEvent.Refused.class);
            assertNotNull(refused);
            assertEquals("failed", refused.reason());
            assertEquals(DeckReading.idle(), h.deck.reading());
        } finally {
            gate.open();
        }
    }

    @Test
    public void aFileThatIsNotThereFailsTheLoadUnderItsToken() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(new DeckCommand.Load(1, "ep-1", "file:///nowhere/click-none.mp3", 0, false));
            DeckEvent.Failed failed = h.await(DeckEvent.Failed.class);
            assertEquals(1, failed.token());
            assertTrue(failed.message(), failed.message().startsWith("player: ERROR_CODE_IO"));
            EngineCommand.DiagEntry row = h.deckRows("failed").get(0);
            assertEquals("player", DeckHarness.str(row, "where"));
            assertNotNull(DeckHarness.num(row, "errCode"));
        }
    }

    @Test
    public void aLoadWithNoUsableUrlFailsAtOnceUnderItsToken() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(new DeckCommand.Load(1, "line-1", null, 0, false));
            h.deck.send(new DeckCommand.Load(2, "ep-2", "not a url", 0, false));
            List<DeckEvent> failures = h.events.stream().filter(e -> e instanceof DeckEvent.Failed).toList();
            assertEquals(List.of(new DeckEvent.Failed(1, "no-url"), new DeckEvent.Failed(2, "no-url")), failures);
            assertEquals(0, h.player.getMediaItemCount());
        }
    }

    @Test
    public void aPauseTheDeckDidNotCommandIsReportedOnceAfterTheSettle() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 20.0));
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            h.runUntil(() -> h.player.isPlaying());
            h.runFor(500);
            // The system pauses the player behind the deck's back (focus loss, a remote).
            h.player.pause();
            DeckEvent.PausedUncommanded paused = h.await(DeckEvent.PausedUncommanded.class);
            assertEquals(1, paused.token());
            assertTrue(paused.atSec() > 20.0);
            h.runFor(1000);
            assertEquals("reported once", 1, h.count(DeckEvent.PausedUncommanded.class));
            // A commanded pause is not reported.
            h.deck.send(DeckCommand.PLAY);
            h.runUntil(() -> h.player.isPlaying());
            h.deck.send(DeckCommand.PAUSE);
            h.runFor(1000);
            assertEquals(1, h.count(DeckEvent.PausedUncommanded.class));
        }
    }

    @Test
    public void aPlayInsideTheSettleCancelsTheSuspicion() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 20.0));
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            h.runUntil(() -> h.player.isPlaying());
            h.player.pause();
            h.deck.send(DeckCommand.PLAY);
            h.runFor(1500);
            assertEquals(0, h.count(DeckEvent.PausedUncommanded.class));
            assertTrue(h.player.isPlaying());
        }
    }

    @Test
    public void aStallIsBufferingAndOnlyPlayingAgainReleasesIt() throws Exception {
        // About three seconds of the 16 kbit/s CBR track (2,000 bytes a second), then nothing.
        GatedDataSource.Gate gate = new GatedDataSource.Gate(6_500);
        try (DeckHarness h = new DeckHarness(GatedDataSource.factory(gate), c -> {})) {
            h.deck.send(load(1, CBR, 0));
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            h.runUntil(() -> h.player.isPlaying());
            int playingAt = h.events.size();
            DeckEvent.Stalled stalled = h.await(DeckEvent.Stalled.class, playingAt);
            assertEquals(1, stalled.token());
            int stalledAt = h.events.indexOf(stalled);
            DeckEvent.TimeControl waiting = h.find(DeckEvent.TimeControl.class, stalledAt);
            assertNotNull("the stall is followed by waiting", waiting);
            assertEquals(DeckEvent.TimeControlStatus.WAITING, waiting.status());
            assertEquals("buffering", waiting.waitingReason());
            assertEquals(Player.STATE_BUFFERING, h.player.getPlaybackState());
            assertTrue("still intending to play: waiting is not paused", h.deck.reading().audible);
            assertEquals("a stall is not an uncommanded pause", 0, h.count(DeckEvent.PausedUncommanded.class));
            assertEquals(1, h.deckRows("stalled").size());

            gate.open();
            int waitingAt = h.events.indexOf(waiting);
            h.runUntil(() -> {
                DeckEvent.TimeControl next = h.find(DeckEvent.TimeControl.class, waitingAt + 1);
                return next != null && next.status() == DeckEvent.TimeControlStatus.PLAYING;
            });
            assertTrue(h.player.isPlaying());
        } finally {
            gate.open();
        }
    }

    @Test
    public void theFileRunningOutIsTheItemsOneEnd() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 88.5));
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            DeckEvent.Ended ended = h.await(DeckEvent.Ended.class);
            assertEquals(1, ended.token());
            assertTrue(h.deck.reading().ended);
            h.runFor(1000);
            assertEquals(1, h.count(DeckEvent.Ended.class));
            assertEquals(0, h.count(DeckEvent.PausedUncommanded.class));
        }
    }

    @Test
    public void aSeekWhileReadyReportsWhereItLandedAndASeekBeforeReadyMovesTheStart() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 10.0));
            h.deck.send(new DeckCommand.Seek(25.0));
            DeckEvent.Ready ready = h.await(DeckEvent.Ready.class);
            assertEquals("a seek before ready moves the start", 25.0, ready.landedSec(), 0.0005);
            h.deck.send(new DeckCommand.Seek(40.25));
            DeckEvent.Seeked seeked = h.await(DeckEvent.Seeked.class);
            assertEquals(1, seeked.token());
            assertTrue(seeked.finished());
            assertEquals(40.25, seeked.landedSec(), 0.0005);
            assertEquals(40.25, h.deck.reading().positionSec, 0.0005);
        }
    }

    @Test
    public void anUnloadedDeckRefusesASeek() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(new DeckCommand.Seek(3));
            DeckEvent.Refused refused = h.find(DeckEvent.Refused.class);
            assertNotNull(refused);
            assertEquals("seek", refused.command());
            assertEquals("not-loaded", refused.reason());
        }
    }

    @Test
    public void invalidateSilencesTheDeckAndNothingIsReportedAfter() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 30.0));
            h.await(DeckEvent.Ready.class);
            h.deck.send(DeckCommand.PLAY);
            h.runUntil(() -> h.player.isPlaying());
            h.deck.invalidate();
            assertFalse(h.player.getPlayWhenReady());
            assertEquals(0, h.player.getMediaItemCount());
            int count = h.events.size();
            h.deck.send(load(2, CBR, 1.0));
            h.deck.send(DeckCommand.PLAY);
            h.runFor(1000);
            assertEquals("nothing after invalidate", count, h.events.size());
            assertEquals(0, h.player.getMediaItemCount());
            assertEquals(DeckReading.idle(), h.deck.reading());
        }
    }

    @Test
    public void aLoadDropsTheArmedOutPoint() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(load(1, CBR, 10.0));
            h.await(DeckEvent.Ready.class);
            h.deck.send(new DeckCommand.SetOutPoint(11.0));
            // A new load of the same source (a resume) before the boundary: its out-point is gone.
            h.deck.send(load(2, CBR, 10.0));
            h.await(DeckEvent.Ready.class, 1 + h.events.indexOf(h.find(DeckEvent.Ready.class)));
            h.deck.send(DeckCommand.PLAY);
            h.runFor(2500);
            assertEquals("no out-point stop after the load dropped it", 0, h.count(DeckEvent.Ended.class));
            assertTrue(h.deck.reading().positionSec > 12.0);
        }
    }
}

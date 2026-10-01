package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckDeadlineClass;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DiagGate;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import androidx.media3.test.utils.FakeClock;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-60 (mirrors NE-38's AVDeckTests): the Media3 deck's provisional field values and the rows
 * that settle them (docs/android-emulator-measurements.md §16).
 *
 * <ul>
 *   <li>P-13 PER CLASS: a rendered line gives up at 8 s, a clip or an episode at 20 s, the class
 *       the core named on the load ({@link DeckDeadlineClass}); every deck row of the load says
 *       {@code class=}.</li>
 *   <li>SAME-SOURCE REUSE (#866's rule): the URL the deck holds is a seek in the prepared source
 *       while it was live within 600 s, and a cold attach ({@code cold=stale}) after.</li>
 *   <li>THE ROWS NE-38e READS pass the ring's gate whole ({@link DiagGate}): nothing dropped, the
 *       sub-kind as {@code event}.</li>
 * </ul>
 *
 * <p>The line's TextToSpeech fallback after its deadline is the core's ruling, pinned through the
 * host in {@code ForayEngineHostNarrationTest#aRenderedLinesEightSecondDeadlineIsReadAloud}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ExoDeckFieldValuesTest {
    private static ClickTracks.Fixture fixture(String file) {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.file.equals(file)) return f;
        throw new AssertionError("no click track " + file);
    }

    private static final ClickTracks.Fixture CBR = fixture("click-cbr.mp3");

    private static DeckCommand.Load line(int token) {
        return new DeckCommand.Load(token, "f1#" + token, CBR.uri().toString(), 0, false, DeckDeadlineClass.LINE);
    }

    private static DeckCommand.Load clip(int token, double startSec) {
        return new DeckCommand.Load(token, "f1#" + token, CBR.uri().toString(), startSec, true, DeckDeadlineClass.CLIP);
    }

    private static String cls(EngineCommand.DiagEntry row) {
        return DeckHarness.str(row, "class");
    }

    /** Every deck row the gate would store: whole (nothing in {@code dropped}), its sub-kind as {@code event}. */
    private static void assertGateAdmitsWhole(List<EngineCommand.DiagEntry> rows) {
        assertTrue("rows to judge", !rows.isEmpty());
        for (EngineCommand.DiagEntry row : rows) {
            EngineCommand.DiagEntry admitted = DiagGate.admit(row);
            String text = JSWriter.stringify(new JsonNode.Obj(row.fields()));
            assertNotNull("refused whole: " + text, admitted);
            assertNull("the gate dropped part of " + row.kind() + " " + text, admitted.field(DiagGate.DROPPED_FIELD));
            assertEquals(row.kind() + " " + text, row.field("kind"), admitted.field(DiagGate.SUB_KIND_FIELD));
        }
    }

    /** The values the deck ships, and the verdict each one's MEASURE tag names (ExoDeck's source says the rows). */
    @Test
    public void theProvisionalValuesAreIosValues() {
        assertEquals("P13-clip: AVDeck.defaultLoadDeadlineSec", 20, ExoDeck.DEFAULT_LOAD_DEADLINE_SEC, 0);
        assertEquals("P13-line: AVDeck.defaultLineLoadDeadlineSec", 8, ExoDeck.DEFAULT_LINE_LOAD_DEADLINE_SEC, 0);
        assertEquals("reuse-idle: AVDeck.defaultReuseMaxIdleSec", 600, ExoDeck.DEFAULT_REUSE_MAX_IDLE_SEC, 0);
        ExoDeck.Config config = new ExoDeck.Config();
        assertEquals(20, config.deadlineSec(DeckDeadlineClass.CLIP), 0);
        assertEquals(8, config.deadlineSec(DeckDeadlineClass.LINE), 0);
        assertEquals("a load with no class is a clip", DeckDeadlineClass.CLIP, new DeckCommand.Load(1, "a", "u", 0, false).deadlineClass());
        assertEquals(DeckDeadlineClass.CLIP, new DeckCommand.Prepare("a", "u", 0).deadlineClass());
    }

    /**
     * A rendered line whose file never arrives is given up at EXACTLY 8 s (the line's class), not
     * at a clip's 20 s, and the deadline row says {@code class=line}. TO SEE IT FAIL: arm every
     * load's deadline with {@code loadDeadlineSec} (the row then reads afterMs 20000).
     */
    @Test
    public void aLineLoadPastEightSecondsTimesOut() throws Exception {
        GatedDataSource.Gate gate = new GatedDataSource.Gate(0);
        try (DeckHarness h = new DeckHarness(GatedDataSource.factory(gate), c -> {})) {
            long startedAt = h.clock.elapsedRealtime();
            h.deck.send(line(1));
            assertEquals(DeckDeadlineClass.LINE, h.deck.deadlineClass());
            DeckEvent.DeadlineExceeded deadline = h.await(DeckEvent.DeadlineExceeded.class);
            assertEquals(1, deadline.token());
            assertEquals("the line's 8 s, on the player's clock", 8_000, deadline.afterMs());
            assertEquals(startedAt + 8_000, h.clock.elapsedRealtime(), 50);
            EngineCommand.DiagEntry row = h.deckRows("deadline").get(0);
            assertEquals("line", cls(row));
            assertEquals("prepare", DeckHarness.str(row, "step"));
            assertEquals(8_000, DeckHarness.num(row, "afterMs"), 0);
            assertEquals("line", cls(h.deckRows("attach").get(0)));
            assertEquals("nothing is left to sound late", 0, h.player.getMediaItemCount());
            assertGateAdmitsWhole(h.rows);
        } finally {
            gate.open();
        }
    }

    /**
     * A clip whose file arrives at 19 s is READY, not given up: its deadline is 20 s. The clock is
     * MANUAL here, moved by hand in 10 ms steps, so the load lands at 19 s and not wherever an
     * auto-advancing clock ran to while the loader thread read the file. TO SEE IT FAIL: arm a
     * clip's deadline with the line's 8 s (the deadline row reads afterMs 8000, class=clip).
     */
    @Test
    public void aClipLoadThatLandsAtNineteenSecondsDoesNotTimeOut() throws Exception {
        GatedDataSource.Gate gate = new GatedDataSource.Gate(0);
        try (DeckHarness h = new DeckHarness(new FakeClock(/* isAutoAdvancing= */ false), GatedDataSource.factory(gate), c -> {})) {
            h.deck.send(clip(1, 12.0));
            assertEquals(DeckDeadlineClass.CLIP, h.deck.deadlineClass());
            h.stepTo(19_000, 10, 0, () -> h.find(DeckEvent.DeadlineExceeded.class) != null);
            assertNull("nothing gives a clip up before 20 s", h.find(DeckEvent.DeadlineExceeded.class));
            assertNull("and nothing arrived yet", h.find(DeckEvent.Ready.class));
            gate.open();
            boolean ready = h.stepTo(19_990, 10, 5, () -> h.find(DeckEvent.Ready.class) != null
                    || h.find(DeckEvent.DeadlineExceeded.class) != null);
            assertTrue("the file that arrived at 19 s made the load ready inside 20 s", ready);
            DeckEvent.Ready r = h.find(DeckEvent.Ready.class);
            assertNotNull("ready, not the deadline: " + h.events, r);
            assertTrue("it landed after 19 s: " + h.clock.elapsedRealtime(), h.clock.elapsedRealtime() >= 19_000);
            EngineCommand.DiagEntry readyRow = h.deckRows("ready").get(0);
            assertEquals("clip", cls(readyRow));
            assertTrue("elapsedMs says 19 s: " + readyRow, DeckHarness.num(readyRow, "elapsedMs") >= 19_000);
            // Past the clip's own 20 s: the deadline it cancelled never fires.
            h.stepTo(21_000, 10, 0, () -> false);
            assertNull(h.find(DeckEvent.DeadlineExceeded.class));
            assertTrue(h.deckRows("deadline").isEmpty());
            assertGateAdmitsWhole(h.rows);
        } finally {
            gate.open();
        }
    }

    /** On a MANUAL clock: step 10 ms at a time (2 ms of real time each, for the loader thread) until an event of this type arrives. */
    private static <T extends DeckEvent> T stepUntil(DeckHarness h, Class<T> type, int from, long maxMs) throws InterruptedException {
        h.stepTo(h.clock.elapsedRealtime() + maxMs, 10, 2, () -> h.find(type, from) != null);
        T found = h.find(type, from);
        assertNotNull("no " + type.getSimpleName() + " within " + maxMs + " ms: " + h.events, found);
        return found;
    }

    /**
     * #866's rule on the Media3 deck: a load of the URL the deck holds, live within 600 s, is a
     * {@code seekTo} in the prepared source ({@code deck kind=reuse idleSec=}); past 600 s idle it
     * is a cold attach whose row says why ({@code cold=stale idleSec=}). The class rides on both.
     * The clock is MANUAL: an auto-advancing one runs on by itself behind a READY, paused player
     * (its work message every second), so the idle would not be the test's. TO SEE IT FAIL: drop
     * the idle limit from {@code coldReason} (the third load is a reuse).
     */
    @Test
    public void aReuseAfterSixHundredSecondsIdleIsCold() throws Exception {
        List<EngineCommand.DiagEntry> gated = new ArrayList<>();
        EngineLog log = new EngineLog(() -> 0, line -> {});
        try (DeckHarness h = new DeckHarness(new FakeClock(/* isAutoAdvancing= */ false), null,
                c -> c.diag = c.diag.andThen(log::diag))) {
            h.deck.send(clip(1, 10.0));
            stepUntil(h, DeckEvent.Ready.class, 0, 10_000);

            // 590 s idle: the source is kept.
            h.clock.advanceTime(590_000);
            int from = h.events.size();
            h.deck.send(clip(2, 10.5));
            DeckEvent.Ready reused = stepUntil(h, DeckEvent.Ready.class, from, 10_000);
            assertEquals(2, reused.token());
            assertEquals(1, h.deckRows("attach").size());
            EngineCommand.DiagEntry reuse = h.deckRows("reuse").get(0);
            double keptIdle = DeckHarness.num(reuse, "idleSec");
            assertEquals("idleSec", 590, keptIdle, 0.001);
            assertEquals("clip", cls(reuse));

            // 610 s idle: cold, and the attach row says it was the idle limit.
            h.clock.advanceTime(610_000);
            from = h.events.size();
            h.deck.send(clip(3, 11.0));
            DeckEvent.Ready cold = stepUntil(h, DeckEvent.Ready.class, from, 10_000);
            assertEquals(3, cold.token());
            List<EngineCommand.DiagEntry> attaches = h.deckRows("attach");
            assertEquals("a second attach: the held source was let go", 2, attaches.size());
            EngineCommand.DiagEntry stale = attaches.get(1);
            assertEquals("stale", DeckHarness.str(stale, "cold"));
            assertEquals("idleSec", 610, DeckHarness.num(stale, "idleSec"), 0.001);
            assertEquals("clip", cls(stale));
            assertEquals(1, h.deckRows("reuse").size());
            assertGateAdmitsWhole(h.rows);

            // And through the Android ring (EngineLog), as the page and a Copy read them.
            for (JsonNode row : log.diagnosticRows()) {
                if (!"deck".equals(row.get("kind").stringValue())) continue;
                gated.add(new EngineCommand.DiagEntry("deck", ((JsonNode.Obj) row).members()));
            }
        }
        List<String> events = new ArrayList<>();
        for (EngineCommand.DiagEntry row : gated) {
            assertNull("a stored row lost a field: " + row, row.field(DiagGate.DROPPED_FIELD));
            JsonNode event = row.field(DiagGate.SUB_KIND_FIELD);
            events.add(event == null ? null : event.stringValue());
        }
        assertTrue(events.toString(), events.contains("attach"));
        assertTrue(events.toString(), events.contains("reuse"));
        assertTrue(events.toString(), events.contains("ready"));
        assertTrue(events.toString(), events.contains("time-control"));
        assertTrue("every stored deck row names its sub-kind: " + events, !events.contains(null));
    }

    /** A load with no usable URL fails at once, and its row says the class too. */
    @Test
    public void aLineWithNoUrlFailsUnderItsClass() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(new DeckCommand.Load(1, "f1#1", null, 0, false, DeckDeadlineClass.LINE));
            EngineCommand.DiagEntry failed = h.deckRows("failed").get(0);
            assertEquals("no-url", DeckHarness.str(failed, "where"));
            assertEquals("line", cls(failed));
            assertGateAdmitsWhole(h.rows);
        }
    }
}

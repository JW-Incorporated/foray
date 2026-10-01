package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckDeadlineClass;
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
import java.util.Map;
import org.junit.Test;

/**
 * Card A-65: NE-46's late-timer detector on the Android host, on a plain JVM with a clock that fires
 * each timer when it is due. A seam beat delivered 6 s late while a grace span is held writes
 * {@code grace kind=late timer=seam-beat lateMs=6000 inSeam=y ... clock=mono}; 4 s and exactly 5 s
 * late do not; without grace nothing is written; a wall clock that alone saw the delay says
 * {@code clock=wall}; and the deck's P-13 deadline arriving 6 s past its class's deadline writes
 * {@code timer=load-deadline}. The row decides nothing: the seam lands as it would have.
 */
public class LateTimerHostTest {
    /**
     * The engine's clocks for a test: monotonic and wall, each timer firing when it is due as the
     * clock is moved ({@link #run}), or late, after a {@link #suspend} moved the clocks with nothing
     * firing (a process that did not run).
     */
    static final class ClockedTiming implements EngineSeams.Timing {
        double mono = 1000;
        double wallOffset = 1_790_000_000_000.0;
        final List<Timer> timers = new ArrayList<>();

        final class Timer implements EngineSeams.Cancellable {
            double dueAt;
            final double every;
            final boolean repeating;
            final Runnable fire;
            boolean cancelled;

            Timer(double dueAt, double every, boolean repeating, Runnable fire) {
                this.dueAt = dueAt;
                this.every = every;
                this.repeating = repeating;
                this.fire = fire;
            }

            @Override
            public void cancel() {
                cancelled = true;
            }
        }

        @Override
        public double wallMs() {
            return wallOffset + mono;
        }

        @Override
        public double monoMs() {
            return mono;
        }

        @Override
        public EngineSeams.Cancellable schedule(double afterMs, boolean repeating, Runnable fire) {
            double after = Math.max(0, afterMs);
            Timer t = new Timer(mono + after, Math.max(1, after), repeating, fire);
            timers.add(t);
            return t;
        }

        /** Move both clocks by {@code ms} in steps of {@code stepMs}, firing what is due, then {@code check}, each step. */
        void run(double ms, double stepMs, Runnable check) {
            double end = mono + ms;
            while (mono < end) {
                mono = Math.min(end, mono + stepMs);
                fireDue();
                if (check != null) check.run();
            }
        }

        void run(double ms) {
            run(ms, 10, null);
        }

        /** Move both clocks with nothing firing (a suspended process), then fire what is now due, late. */
        void suspend(double ms) {
            mono += ms;
            fireDue();
        }

        /** Fire every live timer due by now, earliest first. */
        void fireDue() {
            for (int guard = 0; guard < 10_000; guard++) {
                Timer next = null;
                for (Timer t : timers) {
                    if (!t.cancelled && t.dueAt <= mono && (next == null || t.dueAt < next.dueAt)) next = t;
                }
                if (next == null) return;
                if (next.repeating) next.dueAt += next.every;
                else next.cancelled = true;
                next.fire.run();
            }
            throw new AssertionError("timers kept firing");
        }
    }

    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final ClockedTiming timing = new ClockedTiming();
        final List<String> lines = new ArrayList<>();
        final EngineLog log = new EngineLog(() -> 0, lines::add);
        final ForayEngineHost host;

        Rig() {
            host = new ForayEngineHost(new EngineSeams(deck, session, timing, log), new EngineConfig("test").withForayTape(true, false));
            host.start();
        }

        void background() {
            host.handle(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Background()));
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

        /**
         * Two clips of one source (no jingle: this host has no jingle player), the first played to its
         * out-point, and the second's load landed 120 ms into the beat: the beat's remainder (380 ms) is
         * the host's {@code SEAM_BEAT} timer. Returns the second load.
         */
        DeckCommand.Load toTheParkedBeat() {
            playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200), ForayEngineHostForayTest.clip(1, "a", 300, 400));
            DeckCommand.Load first = lastLoad();
            deck.emit(new DeckEvent.Ready(first.token(), 100, true, 1));
            timing.run(1_000);
            deck.reading.positionSec = 200.0;
            deck.emit(new DeckEvent.Ended(first.token()));
            DeckCommand.Load second = lastLoad();
            assertEquals("f1#1", second.itemId());
            timing.run(120);
            deck.emit(new DeckEvent.Ready(second.token(), 300, true, 1));
            assertTrue("the beat's remainder is a host timer", host.liveTimers().contains(EngineTimer.SEAM_BEAT));
            assertTrue(host.state().inSeamGap() || host.state().gapParkedToken != null);
            return second;
        }

        String rows() {
            return String.join("\n", lines);
        }

        List<String> lateRows() {
            List<String> out = new ArrayList<>();
            for (String l : lines) if (l.contains(" grace {\"kind\":\"late\"")) out.add(l);
            return out;
        }
    }

    /**
     * The card's acceptance: a seam beat 6 s late while a seam's grace span is held writes the row, in
     * the card's field order, before the seam lands; the seam then lands as it would have. TO SEE IT
     * FAIL: drop the ledger entry at {@code arm}, or measure after the input is handled (the beat has
     * landed and closed the span, and the row says {@code inSeam=n} or is never written).
     */
    @Test
    public void aSeamBeatSixSecondsLateUnderGraceWritesTheRow() {
        Rig rig = new Rig();
        rig.background();
        rig.toTheParkedBeat();
        assertTrue("a background seam holds a grace span", rig.host.state().grace != null);
        int plays = rig.deck.count(DeckCommand.Play.class);
        rig.timing.suspend(380 + 6_000);
        List<String> late = rig.lateRows();
        assertEquals(rig.rows(), 1, late.size());
        String row = late.get(0);
        assertTrue(row, row.contains("{\"kind\":\"late\",\"timer\":\"seam-beat\",\"lateMs\":6000,\"inSeam\":\"y\",\"reason\":\""));
        assertTrue(row, row.endsWith("\"clock\":\"mono\"}"));
        assertFalse("Android has no background budget to report", row.contains("bgRemainingMs"));
        assertEquals("the row decides nothing: the late beat still starts the clip", plays + 1, rig.deck.count(DeckCommand.Play.class));
        int rowIndex = rig.lines.indexOf(row);
        int seamIndex = -1;
        for (int i = 0; i < rig.lines.size(); i++) if (rig.lines.get(i).contains(" seam {")) seamIndex = i;
        assertTrue("the late row is written before the seam lands: " + rig.rows(), seamIndex < 0 || rowIndex < seamIndex);
    }

    /** 4 s late, and exactly the 5 s gap, are not suspensions: nothing is written. */
    @Test
    public void fourSecondsLateAndTheGapItselfWriteNothing() {
        for (double lateMs : new double[] {4_000, 5_000}) {
            Rig rig = new Rig();
            rig.background();
            rig.toTheParkedBeat();
            rig.timing.suspend(380 + lateMs);
            assertTrue(lateMs + " ms late: " + rig.rows(), rig.lateRows().isEmpty());
        }
    }

    /** A late timer with no grace span held (the app in the foreground) is not the case the row is for. */
    @Test
    public void noGraceNoRow() {
        Rig rig = new Rig();
        rig.toTheParkedBeat();
        assertEquals("no span in the foreground", null, rig.host.state().grace);
        rig.timing.suspend(380 + 6_000);
        assertTrue(rig.rows(), rig.lateRows().isEmpty());
    }

    /** The wall clock alone saw the delay (iOS: a device that slept; here, a clock set forward): {@code clock=wall}. */
    @Test
    public void aDelayOnlyTheWallClockSawSaysClockWall() {
        Rig rig = new Rig();
        rig.background();
        rig.toTheParkedBeat();
        rig.timing.wallOffset += 6_000;
        rig.timing.run(400);
        List<String> late = rig.lateRows();
        assertEquals(rig.rows(), 1, late.size());
        assertTrue(late.get(0), late.get(0).contains("\"timer\":\"seam-beat\",\"lateMs\":6000,\"inSeam\":\"y\""));
        assertTrue(late.get(0), late.get(0).endsWith("\"clock\":\"wall\"}"));
    }

    /**
     * The deck's P-13 deadline for the load in the seam, 6 s past its class's deadline (the deck's own
     * {@code afterMs}), writes {@code timer=load-deadline}; one 4 s past, or a host with no deadlines
     * handed in, writes nothing. TO SEE IT FAIL: drop the service's {@code setLoadDeadlines}, or key
     * the deadline on a load other than the newest.
     */
    @Test
    public void aLateLoadDeadlineInTheSeamWritesTheRow() {
        Rig rig = new Rig();
        rig.host.setLoadDeadlines(Map.of(DeckDeadlineClass.CLIP, 20_000.0, DeckDeadlineClass.LINE, 8_000.0));
        rig.background();
        rig.playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200), ForayEngineHostForayTest.clip(1, "a", 300, 400),
                ForayEngineHostForayTest.clip(2, "a", 500, 600));
        DeckCommand.Load first = rig.lastLoad();
        rig.deck.emit(new DeckEvent.Ready(first.token(), 100, true, 1));
        rig.timing.run(1_000);
        rig.deck.reading.positionSec = 200.0;
        rig.deck.emit(new DeckEvent.Ended(first.token()));
        DeckCommand.Load second = rig.lastLoad();
        assertEquals(DeckDeadlineClass.CLIP, second.deadlineClass());
        rig.deck.emit(new DeckEvent.DeadlineExceeded(second.token(), 26_000));
        List<String> late = rig.lateRows();
        assertEquals(rig.rows(), 1, late.size());
        assertTrue(late.get(0), late.get(0).contains("\"timer\":\"load-deadline\",\"lateMs\":6000,\"inSeam\":\"y\""));

        Rig onTime = new Rig();
        onTime.host.setLoadDeadlines(Map.of(DeckDeadlineClass.CLIP, 20_000.0));
        onTime.background();
        onTime.playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200), ForayEngineHostForayTest.clip(1, "a", 300, 400));
        DeckCommand.Load a = onTime.lastLoad();
        onTime.deck.emit(new DeckEvent.Ready(a.token(), 100, true, 1));
        onTime.deck.reading.positionSec = 200.0;
        onTime.deck.emit(new DeckEvent.Ended(a.token()));
        onTime.deck.emit(new DeckEvent.DeadlineExceeded(onTime.lastLoad().token(), 24_000));
        assertTrue(onTime.rows(), onTime.lateRows().isEmpty());

        Rig unconfigured = new Rig();
        unconfigured.background();
        unconfigured.playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200), ForayEngineHostForayTest.clip(1, "a", 300, 400));
        DeckCommand.Load u = unconfigured.lastLoad();
        unconfigured.deck.emit(new DeckEvent.Ready(u.token(), 100, true, 1));
        unconfigured.deck.reading.positionSec = 200.0;
        unconfigured.deck.emit(new DeckEvent.Ended(u.token()));
        unconfigured.deck.emit(new DeckEvent.DeadlineExceeded(unconfigured.lastLoad().token(), 60_000));
        assertTrue(unconfigured.rows(), unconfigured.lateRows().isEmpty());
    }

    /** A timer cancelled before it fired leaves the ledger: a pause cuts the beat, and nothing is late after it. */
    @Test
    public void aCancelledTimerIsNeverLate() {
        Rig rig = new Rig();
        rig.background();
        rig.toTheParkedBeat();
        rig.host.handle(new EngineInput.Command(EngineContract.Command.PAUSE, Vocabulary.Source.TAP));
        assertFalse("the pause cut the beat", rig.host.liveTimers().contains(EngineTimer.SEAM_BEAT));
        rig.timing.suspend(380 + 6_000);
        for (String row : rig.lateRows()) assertFalse(row, row.contains("seam-beat"));
    }
}

package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.Rows;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * Card A-26: the host's turn discipline, on a plain JVM (no Android type is touched). The JVM
 * twin of the iOS ForayEngineHostTests: activation answered inside the turn that asked for it, a
 * refused activation that commands no deck at all, an input raised from inside a command queued
 * behind the turn, the remote status row, timers, the surface, and a terminal teardown.
 */
public class ForayEngineHostTest {
    /** A deck that records every command, reads back what it was told, and can answer a load at once. */
    static final class FakeDeck implements DeckDriving {
        final List<DeckCommand> sent = new ArrayList<>();
        final DeckReading reading = new DeckReading(0.0, 90.0, false, false);
        Listener listener;
        boolean readyInsideLoad;
        boolean invalidated;
        Integer lastToken;
        /** The host's depth at each command: an input handled on the spot would show a nested send. */
        final List<String> order = new ArrayList<>();

        @Override
        public void setListener(Listener listener) {
            this.listener = listener;
        }

        @Override
        public DeckReading reading() {
            return reading.copy();
        }

        @Override
        public void send(DeckCommand command) {
            sent.add(command);
            order.add(command.getClass().getSimpleName());
            switch (command) {
                case DeckCommand.Load l -> {
                    lastToken = l.token();
                    reading.positionSec = l.startSec();
                    reading.audible = false;
                    if (readyInsideLoad && listener != null) {
                        listener.onEvent(new DeckEvent.Ready(l.token(), l.startSec(), true, 1));
                        order.add("ready-raised");
                    }
                }
                case DeckCommand.Play p -> reading.audible = true;
                case DeckCommand.Pause p -> reading.audible = false;
                default -> {}
            }
        }

        @Override
        public void invalidate() {
            invalidated = true;
        }

        void emit(DeckEvent event) {
            listener.onEvent(event);
        }

        <T extends DeckCommand> int count(Class<T> type) {
            int n = 0;
            for (DeckCommand c : sent) if (type.isInstance(c)) n++;
            return n;
        }
    }

    static final class FakeSession implements EngineSeams.Session {
        boolean ok = true;
        int activations;
        final List<String> calls = new ArrayList<>();

        @Override
        public EngineSeams.Activation activate() {
            activations++;
            calls.add("activate");
            return ok ? EngineSeams.Activation.granted() : new EngineSeams.Activation(false, "other", null);
        }

        @Override
        public void deactivate(boolean notifyOthers) {
            calls.add("deactivate");
        }

        @Override
        public void reapplyCategory() {
            calls.add("reapply");
        }

        @Override
        public void rebuild() {
            calls.add("rebuild");
        }
    }

    static final class FakeTiming implements EngineSeams.Timing {
        double mono = 1000;
        final List<Scheduled> scheduled = new ArrayList<>();

        final class Scheduled implements EngineSeams.Cancellable {
            final double afterMs;
            final boolean repeating;
            final Runnable fire;
            boolean cancelled;

            Scheduled(double afterMs, boolean repeating, Runnable fire) {
                this.afterMs = afterMs;
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
            return 1_790_000_000_000.0 + mono;
        }

        @Override
        public double monoMs() {
            return mono;
        }

        @Override
        public EngineSeams.Cancellable schedule(double afterMs, boolean repeating, Runnable fire) {
            Scheduled s = new Scheduled(afterMs, repeating, fire);
            scheduled.add(s);
            return s;
        }

        List<Scheduled> live() {
            List<Scheduled> out = new ArrayList<>();
            for (Scheduled s : scheduled) if (!s.cancelled) out.add(s);
            return out;
        }
    }

    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final FakeTiming timing = new FakeTiming();
        final List<String> lines = new ArrayList<>();
        final EngineLog log = new EngineLog(() -> 0, lines::add);
        final ForayEngineHost host = new ForayEngineHost(new EngineSeams(deck, session, timing, log), new EngineConfig("test"));
        final List<ForayEngineHost.Surface> surfaces = new ArrayList<>();

        Rig() {
            host.setSurfaceListener(surfaces::add);
            host.start();
        }

        List<String> rows(String kind) {
            List<String> out = new ArrayList<>();
            for (String l : lines) if (l.split(" ")[2].equals(kind)) out.add(l);
            return out;
        }
    }

    static EngineItem item(String id, String title) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("id", JsonNode.str(id)));
        m.add(JsonNode.member("kind", JsonNode.str("episode")));
        m.add(JsonNode.member("title", JsonNode.str(title)));
        m.add(JsonNode.member("show", JsonNode.str("A show")));
        m.add(JsonNode.member("audio_url", JsonNode.str("https://cdn.example/" + id + ".mp3")));
        m.add(JsonNode.member("duration_sec", JsonNode.num(90)));
        return EngineItem.of(new JsonNode.Obj(m));
    }

    static EngineInput load(String... ids) {
        List<EngineItem> items = new ArrayList<>();
        for (String id : ids) items.add(item(id, "Title " + id));
        return new EngineInput.Queue(new EngineInput.QueueInput.Load(items));
    }

    static EngineInput playIndex(int i) {
        return new EngineInput.Queue(new EngineInput.QueueInput.PlayIndex(i, null, Vocabulary.Source.TAP));
    }

    @Test
    public void aTapPlayIsActivatedInsideItsOwnTurnAndThenLoads() {
        Rig r = new Rig();
        assertTrue(r.host.handle(load("a", "b")).ok());
        ForayEngineHost.Verdict v = r.host.handle(playIndex(0));
        assertTrue("the play was accepted: " + v.failures(), v.ok());
        assertEquals("the session was asked once, inside the turn", 1, r.session.activations);
        assertEquals(1, r.host.activations());
        assertEquals("the deck loads the item", 1, r.deck.count(DeckCommand.Load.class));
        DeckCommand.Load load = (DeckCommand.Load) r.deck.sent.get(0);
        assertEquals("https://cdn.example/a.mp3", load.url());
        assertEquals("no play before the deck is ready", 0, r.deck.count(DeckCommand.Play.class));
        r.deck.emit(new DeckEvent.Ready(load.token(), 0, true, 5));
        assertEquals("ready plays", 1, r.deck.count(DeckCommand.Play.class));
        assertTrue(r.host.state().isRunning());
    }

    @Test
    public void aRefusedActivationFailsThePressAndCommandsNoDeck() {
        Rig r = new Rig();
        r.session.ok = false;
        r.host.handle(load("a"));
        ForayEngineHost.Verdict v = r.host.handle(playIndex(0));
        assertFalse("a refused activation is a failed play", v.ok());
        assertTrue("with a session-failed reason: " + v.failures(), v.failures().get(0).startsWith("session-failed"));
        assertTrue("and nothing reached the deck: " + r.deck.sent, r.deck.sent.isEmpty());
        assertFalse(r.host.state().isRunning());
    }

    @Test
    public void anInputRaisedInsideACommandIsQueuedBehindTheTurn() {
        Rig r = new Rig();
        r.deck.readyInsideLoad = true;
        r.host.handle(load("a"));
        ForayEngineHost.Verdict v = r.host.handle(playIndex(0));
        assertTrue(v.ok());
        /* The deck answered `ready` from inside send(load). Handled on the spot, the play would
           be commanded INSIDE the load; queued, it follows the load's turn, and the order says so. */
        List<String> order = r.deck.order;
        int loadAt = order.indexOf("Load");
        int raisedAt = order.indexOf("ready-raised");
        int playAt = order.indexOf("Play");
        assertTrue("the load, then its ready raised, then the play: " + order, loadAt >= 0 && loadAt < raisedAt && raisedAt < playAt);
        assertTrue(r.host.state().isRunning());
    }

    @Test
    public void aRemotePressIsRuledByTheCoreAndItsStatusIsARow() {
        Rig r = new Rig();
        ForayEngineHost.Verdict v = r.host.remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY));
        assertFalse("nothing is loaded", v.ok());
        assertEquals(EngineContract.Refusal.NOT_LOADED.token, v.failures().get(0));
        assertEquals("noActionableNowPlayingItem", ForayEngineHost.statusToken(v));
        List<String> remote = r.rows("remote");
        assertEquals("the core's remote row, then the status row: " + remote, 2, remote.size());
        assertTrue(remote.get(0), remote.get(0).contains("\"cmd\":\"play\""));
        assertTrue(remote.get(1), remote.get(1).contains("\"kind\":\"status\"") && remote.get(1).contains("\"status\":\"noActionableNowPlayingItem\""));

        r.host.handle(load("a", "b"));
        r.host.handle(playIndex(0));
        r.deck.emit(new DeckEvent.Ready(r.deck.lastToken, 0, true, 5));
        ForayEngineHost.Verdict pause = r.host.remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PAUSE));
        assertTrue(pause.ok());
        assertEquals("success", ForayEngineHost.statusToken(pause));
        assertEquals("a remote pause pauses the deck", 1, r.deck.count(DeckCommand.Pause.class));
        assertFalse(r.host.state().isRunning());
        ForayEngineHost.Verdict next = r.host.remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.NEXT_TRACK));
        assertTrue("next with a next item: " + next.failures(), next.ok());
        DeckCommand.Load last = null;
        for (DeckCommand c : r.deck.sent) if (c instanceof DeckCommand.Load l) last = l;
        assertEquals("next loads the next item", "b", last.itemId());
    }

    @Test
    public void theSurfaceFollowsEveryTurn() {
        Rig r = new Rig();
        ForayEngineHost.Surface idle = r.surfaces.get(r.surfaces.size() - 1);
        assertTrue("nothing loaded: Now Playing is cleared", idle.availability().clearsNowPlaying());
        assertNull(idle.view());
        int before = r.surfaces.size();
        r.host.handle(load("a", "b"));
        r.host.handle(playIndex(0));
        assertEquals("one surface per input", before + 2, r.surfaces.size());
        ForayEngineHost.Surface s = r.host.surface();
        assertTrue(s.seq() > idle.seq());
        assertNotNull(s.view());
        assertEquals("Title a", s.view().metadata().title());
        assertEquals("A show", s.view().metadata().artist());
        assertEquals(MediaMapping.PLAYING, s.view().playbackState());
        assertTrue("a next exists", s.availability().isEnabled(MediaMapping.RemoteCommand.NEXT_TRACK));
        assertFalse("a remote stop is never enabled (T-7)", s.availability().isEnabled(MediaMapping.RemoteCommand.STOP));
    }

    @Test
    public void timersAreArmedThroughTheSeamAndCancelledAtTeardown() {
        Rig r = new Rig();
        r.host.handle(load("a"));
        r.host.handle(playIndex(0));
        r.deck.emit(new DeckEvent.Ready(r.deck.lastToken, 0, true, 5));
        r.deck.emit(new DeckEvent.TimeControl(r.deck.lastToken, DeckEvent.TimeControlStatus.PLAYING, null));
        assertFalse("playing arms the position tick", r.host.liveTimers().isEmpty());
        FakeTiming.Scheduled tick = r.timing.live().get(0);
        tick.fire.run();
        assertTrue("a timer's input is handled like any other", r.host.state().isRunning());
        r.host.teardown();
        assertTrue(r.host.isTornDown());
        assertTrue("teardown cancels every timer", r.timing.live().isEmpty());
        assertTrue("and invalidates the deck", r.deck.invalidated);
        ForayEngineHost.Verdict late = r.host.handle(playIndex(0));
        assertEquals(EngineContract.Refusal.RELINQUISHED.token, late.failures().get(0));
    }

    static EngineInput relinquish() {
        return new EngineInput.Command(new EngineContract.Command.Relinquish(EngineContract.RelinquishCap.ALL), Vocabulary.Source.TAP);
    }

    /**
     * CH3-07 (R5-01): a core relinquish hands the listener (the Media3 session's player) a
     * CLEARED surface, not the one the last turn left. Today teardown() re-sends the stale
     * {@code surface} field: "Title a, playing" with every command enabled, on a session nothing
     * will write again.
     * MUTATION: in teardown(), hand the listener the {@code surface} field instead of the cleared
     * one: red here.
     */
    @Test
    public void aCoreRelinquishHandsTheListenerAClearedSurface() {
        Rig r = new Rig();
        r.host.handle(load("a", "b"));
        r.host.handle(playIndex(0));
        r.deck.emit(new DeckEvent.Ready(r.deck.lastToken, 0, true, 5));
        ForayEngineHost.Surface before = r.surfaces.get(r.surfaces.size() - 1);
        assertNotNull("playing: the session shows the item", before.view());
        assertFalse(before.availability().clearsNowPlaying());
        int told = r.surfaces.size();

        ForayEngineHost.Verdict v = r.host.handle(relinquish());
        assertTrue("the relinquish is accepted: " + v.failures(), v.ok());
        assertTrue(r.host.isTornDown());
        assertEquals("the listener is told once more, at teardown", told + 1, r.surfaces.size());
        ForayEngineHost.Surface last = r.surfaces.get(r.surfaces.size() - 1);
        assertTrue("the last surface clears the session", last.availability().clearsNowPlaying());
        assertTrue("with every command disabled: " + last.availability().enabled(), last.availability().enabled().isEmpty());
        assertNull("and nothing to show", last.view());
        assertTrue("a new surface, not the last turn's again", last.seq() > before.seq());
        assertSame("the host keeps answering the terminal surface", last, r.host.surface());
        assertSame(last, r.host.freshSurface());
    }

    @Test
    public void aFocusInterruptionPausesAndItsEndResumes() {
        Rig r = new Rig();
        r.host.handle(load("a"));
        r.host.handle(playIndex(0));
        r.deck.emit(new DeckEvent.Ready(r.deck.lastToken, 0, true, 5));
        r.deck.reading.positionSec = 20.0;
        int loads = r.deck.count(DeckCommand.Load.class);
        FocusMapping focus = new FocusMapping();
        for (EngineInput.SessionEvent e : focus.onSuppressionChanged(
                androidx.media3.common.Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS,
                androidx.media3.common.Player.STATE_READY)) {
            r.host.handle(new EngineInput.Session(e));
        }
        assertEquals("a transient loss pauses the deck", 1, r.deck.count(DeckCommand.Pause.class));
        assertFalse(r.host.state().isRunning());
        for (EngineInput.SessionEvent e : focus.onSuppressionChanged(
                androidx.media3.common.Player.PLAYBACK_SUPPRESSION_REASON_NONE, androidx.media3.common.Player.STATE_READY)) {
            r.host.handle(new EngineInput.Session(e));
        }
        assertTrue("the end of it resumes: the in-place reload that steps back", r.deck.count(DeckCommand.Load.class) > loads);
        assertTrue(r.host.state().isRunning());
    }

    @Test
    public void theLogKeepsABoundedRing() {
        List<String> sink = new ArrayList<>();
        EngineLog log = new EngineLog(() -> 0, sink::add);
        for (int i = 0; i < EngineLog.CAPACITY + 10; i++) {
            log.diag(new EngineCommand.DiagEntry("x", new ArrayList<>()));
        }
        log.writeRestore((RestoreRecord) null);
        log.writeRow((Rows.StoredRow) null);
        assertEquals(EngineLog.CAPACITY, log.lines().size());
        assertEquals(EngineLog.CAPACITY + 12, sink.size());
        assertTrue(log.lines().get(log.lines().size() - 2).contains(" restore clear"));
    }
}

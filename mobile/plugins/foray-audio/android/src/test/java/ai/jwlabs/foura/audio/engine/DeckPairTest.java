package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckPolicy;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Before;
import org.junit.Test;

/**
 * The deck pair's routing, headless (card A-40; the JVM port of the iOS DeckPairTests, NE-32): two
 * recording decks, no Media3, so every rule is deterministic. Each test names the rule it guards
 * and the edit that turns it red.
 */
public class DeckPairTest {
    /** A deck that records what it was told and reports what the test says. */
    static final class FakePairDeck implements PairableDeck {
        final String name;
        final List<String> journal;
        DeckDriving.Listener listener;
        DeckReading reading = DeckReading.idle();
        boolean ready = false;
        String url;
        boolean prepareWindowAvailable = false;
        /** A deck whose pause does not take (the swap must then be refused). */
        boolean stuckAudible = false;
        final List<DeckCommand> sent = new ArrayList<>();
        final List<Integer> adopted = new ArrayList<>();
        boolean invalidated = false;

        FakePairDeck(String name, List<String> journal) {
            this.name = name;
            this.journal = journal;
        }

        @Override
        public void setListener(DeckDriving.Listener listener) {
            this.listener = listener;
        }

        @Override
        public DeckReading reading() {
            return reading.copy();
        }

        @Override
        public void send(DeckCommand command) {
            sent.add(command);
            journal.add(name + "." + logName(command));
            switch (command) {
                case DeckCommand.Load c -> {
                    url = c.url();
                    ready = false;
                    reading = new DeckReading(c.startSec(), null, false, false);
                }
                case DeckCommand.Play c -> reading.audible = true;
                case DeckCommand.Pause c -> {
                    if (!stuckAudible) reading.audible = false;
                }
                case DeckCommand.Unload c -> {
                    url = null;
                    ready = false;
                    reading = DeckReading.idle();
                }
                default -> {}
            }
        }

        @Override
        public void invalidate() {
            invalidated = true;
        }

        @Override
        public boolean isReady() {
            return ready;
        }

        @Override
        public String loadedUrl() {
            return url;
        }

        @Override
        public void setPrepareWindowAvailable(boolean available) {
            prepareWindowAvailable = available;
        }

        @Override
        public void adopt(int token) {
            adopted.add(token);
            journal.add(name + ".adopt:" + token);
        }

        void emit(DeckEvent event) {
            if (listener != null) listener.onEvent(event);
        }

        /** The load the pair issued on this deck most recently. */
        Integer lastLoadToken() {
            for (int i = sent.size() - 1; i >= 0; i--) {
                if (sent.get(i) instanceof DeckCommand.Load l) return l.token();
            }
            return null;
        }

        int count(String name) {
            int n = 0;
            for (DeckCommand c : sent) if (logName(c).equals(name)) n++;
            return n;
        }

        /** The deck's load became ready at {@code atSec} (prerolled). */
        void becomeReady(int token, double atSec) {
            ready = true;
            reading.positionSec = atSec;
            reading.durationSec = 90.0;
            emit(new DeckEvent.DurationLoaded(token, 90.0));
            emit(new DeckEvent.Ready(token, atSec, true, 30));
        }

        static String logName(DeckCommand c) {
            return switch (c) {
                case DeckCommand.Load x -> "load";
                case DeckCommand.Play x -> "play";
                case DeckCommand.Pause x -> "pause";
                case DeckCommand.Seek x -> "seek";
                case DeckCommand.SetRate x -> "setRate";
                case DeckCommand.SetOutPoint x -> "setOutPoint";
                case DeckCommand.Unload x -> "unload";
                case DeckCommand.Prepare x -> "prepare";
            };
        }
    }

    private static final String URL_A = "https://cdn.test/a.mp3";
    private static final String URL_B = "https://cdn.test/b.mp3";
    private static final String URL_C = "https://cdn.test/c.mp3";

    private List<String> journal;
    private FakePairDeck a;
    private FakePairDeck b;
    private DeckPair pair;
    private List<DeckEvent> events;
    private List<EngineCommand.DiagEntry> rows;
    private List<Integer> actives;

    @Before
    public void setUp() {
        journal = new ArrayList<>();
        a = new FakePairDeck("A", journal);
        b = new FakePairDeck("B", journal);
        events = new ArrayList<>();
        rows = new ArrayList<>();
        actives = new ArrayList<>();
        DeckPair.Config config = new DeckPair.Config();
        config.diag = rows::add;
        config.onActiveChanged = actives::add;
        pair = new DeckPair(a, b, config);
        pair.setListener(events::add);
    }

    /** A playing item "a" on deck A (core token 1) with the standby asked to prepare "b" at 300 s. */
    private int playingWithPrepare(boolean readyStandby) {
        pair.send(new DeckCommand.Load(1, "a", URL_A, 100, true));
        a.becomeReady(1, 100);
        pair.send(DeckCommand.PLAY);
        pair.send(new DeckCommand.Prepare("b", URL_B, 300));
        Integer warm = b.lastLoadToken();
        int token = warm == null ? 0 : warm;
        if (readyStandby) b.becomeReady(token, 300);
        return token;
    }

    private DeckEvent.Prepared prepared(int token) {
        for (DeckEvent e : events) if (e instanceof DeckEvent.Prepared p && p.token() == token) return p;
        return null;
    }

    private boolean rowWithReason(String reason) {
        for (EngineCommand.DiagEntry r : rows) {
            JsonNode value = r.field("reason");
            if (r.kind().equals("prepare") && value != null && reason.equals(value.stringValue())) return true;
        }
        return false;
    }

    /**
     * The standby deck loads the next item at its in-point, at the listener's rate, with a token of
     * its own, and NOTHING it reports reaches the core. TO SEE IT FAIL: forward the standby's events,
     * or load it on deck A.
     */
    @Test
    public void aPrepareLoadsTheStandbyAtItsInPointAndTheCoreHearsNothingOfIt() {
        pair.send(new DeckCommand.SetRate(1.5));
        int warm = playingWithPrepare(true);
        assertTrue("a warm token can never be one of the core's", warm < 0);
        assertEquals(Arrays.asList(new DeckCommand.SetRate(1.5), new DeckCommand.SetRate(1.5),
                new DeckCommand.Load(warm, "b", URL_B, 300, true)), b.sent);
        assertEquals("the player is left alone", 1, a.count("load"));
        for (DeckEvent e : events) assertFalse("the standby's ready is the pair's", e instanceof DeckEvent.Ready r && r.token() == warm);
        assertEquals("only deck A's durationLoaded and ready reached the core: " + events, 2, events.size());
    }

    /** {@code prefetchDecision}: the same source is a seek, not a refetch; an item already warm is not fetched twice; no url, nothing. */
    @Test
    public void theStandbyIsNotWarmedForTheSameEpisodeTwiceOrWithoutAUrl() {
        pair.send(new DeckCommand.Load(1, "a", URL_A, 100, true));
        pair.send(new DeckCommand.Prepare("a2", URL_A, 900));
        pair.send(new DeckCommand.Prepare("x", null, 0));
        assertEquals(0, b.count("load"));
        pair.send(new DeckCommand.Prepare("b", URL_B, 300));
        pair.send(new DeckCommand.Prepare("b", URL_B, 300));
        assertEquals("already warm", 1, b.count("load"));
    }

    /**
     * A HIT: the handover in {@code DeckPolicy.handoverSteps} order, the core hears
     * {@code prepared(hit)} and {@code ready} for ITS token at once, nothing loads on the player,
     * and no step plays. TO SEE IT FAIL: swap before pausing; skip {@code adopt}; play in the handover.
     */
    @Test
    public void aHitPromotesTheStandbyInHandoverOrderAndAnswersAtOnce() {
        pair.send(new DeckCommand.SetRate(2));
        int warm = playingWithPrepare(true);
        journal.clear();
        a.emit(new DeckEvent.Ended(1));
        pair.send(new DeckCommand.Load(2, "b", URL_B, 300, true));

        assertEquals("pause-outgoing, adopt-identity, carry-rate", Arrays.asList("A.pause", "B.adopt:2", "B.setRate"), journal);
        List<String> steps = new ArrayList<>();
        for (String entry : pair.handoverLog()) if (entry.startsWith("handover:")) steps.add(entry);
        List<String> expected = new ArrayList<>();
        for (DeckPolicy.HandoverStep step : DeckPolicy.handoverSteps()) expected.add("handover:" + step.token);
        assertEquals(expected, steps);
        assertEquals(Arrays.asList(2), b.adopted);
        assertEquals("a hit loads nothing", 1, a.count("load"));
        assertEquals(0, b.count("play"));
        assertEquals(1, pair.activeIndex());
        assertEquals(1, pair.swaps());
        assertEquals("the service moves its focus listener with the role", Arrays.asList(1), actives);
        assertEquals("the rate is carried onto the deck that inherits the role", new DeckCommand.SetRate(2), b.sent.get(b.sent.size() - 1));
        DeckEvent.Prepared report = prepared(2);
        assertTrue(report != null && report.hit());
        assertEquals(Arrays.asList(Vocabulary.Stage.ATTACH, Vocabulary.Stage.DURATION, Vocabulary.Stage.READINESS, Vocabulary.Stage.SEEK,
                Vocabulary.Stage.PREROLL, Vocabulary.Stage.READY), report.stages());
        assertTrue(events.toString(), events.contains(new DeckEvent.Ready(2, 300, true, 0)));
        assertTrue(warm < 0);

        // From now on the core's commands go to B, and only B's events reach it.
        pair.send(DeckCommand.PLAY);
        assertEquals(1, b.count("play"));
        assertEquals(b.reading(), pair.reading());
        int before = events.size();
        a.emit(new DeckEvent.Ended(1));
        a.emit(new DeckEvent.TimeControl(1, DeckEvent.TimeControlStatus.PAUSED, null));
        assertEquals("the outgoing deck's late events never reach the core", before, events.size());
        b.emit(new DeckEvent.TimeControl(2, DeckEvent.TimeControlStatus.PLAYING, null));
        assertEquals(new DeckEvent.TimeControl(2, DeckEvent.TimeControlStatus.PLAYING, null), events.get(events.size() - 1));
    }

    /**
     * A MISS: a standby still loading at the boundary is forgotten and the load runs as an ordinary
     * load on the player; the core hears {@code prepared(hit: false)}. TO SEE IT FAIL: promote a
     * warm load that is not ready.
     */
    @Test
    public void aMissDegradesToAnOrdinaryLoadAndSaysWhereItMissed() {
        playingWithPrepare(false);
        pair.send(new DeckCommand.Load(2, "b", URL_B, 300, true));
        assertEquals("the ordinary load, on the player", Integer.valueOf(2), a.lastLoadToken());
        assertEquals(0, pair.activeIndex());
        assertEquals(0, pair.swaps());
        assertFalse(prepared(2).hit());
        assertEquals(Arrays.asList(Vocabulary.Stage.ATTACH), prepared(2).stages());
        assertTrue(pair.handoverLog().contains("promotion:not-ready"));
        assertTrue(rowWithReason("not-ready"));
    }

    /** Readiness is re-asserted at the boundary: a warm deck at the wrong in-point, or one that drifted off it, is never promoted. */
    @Test
    public void aWrongOffsetOrADriftedWarmDeckIsNotPromoted() {
        int warm = playingWithPrepare(true);
        pair.send(new DeckCommand.Load(2, "b", URL_B, 600, true));
        assertEquals(Integer.valueOf(2), a.lastLoadToken());
        assertTrue(pair.handoverLog().contains("promotion:wrong-offset"));

        pair.send(new DeckCommand.Prepare("c", URL_C, 40));
        int second = b.lastLoadToken();
        assertNotEquals("every warm load has its own token", warm, second);
        b.becomeReady(second, 40);
        b.reading.positionSec = 0.0;
        pair.send(new DeckCommand.Load(3, "c", URL_C, 40, true));
        assertEquals(Integer.valueOf(3), a.lastLoadToken());
        assertTrue(pair.handoverLog().contains("promotion:drifted"));
    }

    /** A skip to an item that was never prepared is an ordinary load, not a "miss": no {@code prepared} report. */
    @Test
    public void aSkipElsewhereIsNotReportedAsAMiss() {
        playingWithPrepare(true);
        pair.send(new DeckCommand.Load(2, "c", URL_C, 10, true));
        assertEquals(Integer.valueOf(2), a.lastLoadToken());
        assertNull(prepared(2));
    }

    /** NEVER TWO AUDIBLE: when the outgoing deck will not confirm paused, the roles do not swap. TO SEE IT FAIL: drop the audible check. */
    @Test
    public void theRolesDoNotSwapWhileTheOutgoingDeckStillSounds() {
        playingWithPrepare(true);
        a.stuckAudible = true;
        pair.send(new DeckCommand.Load(2, "b", URL_B, 300, true));
        assertEquals(0, pair.activeIndex());
        assertEquals(List.of(), b.adopted);
        assertEquals(Integer.valueOf(2), a.lastLoadToken());
        assertFalse(prepared(2).hit());
        assertTrue(pair.handoverLog().contains("handover:refused-outgoing-audible"));
        assertEquals("no handover, no focus move", List.of(), actives);
    }

    /** {@code unexplainedPauseAction}: an uncommanded pause while a warm load is IN FLIGHT stands warming down for good. */
    @Test
    public void anUncommandedPauseDuringAWarmLoadStandsWarmingDown() {
        playingWithPrepare(false);
        a.emit(new DeckEvent.PausedUncommanded(1, 150));
        assertEquals("reported", new DeckEvent.PausedUncommanded(1, 150), events.get(events.size() - 1));
        assertFalse(pair.available());
        assertFalse(a.prepareWindowAvailable);
        pair.send(new DeckCommand.Prepare("c", URL_C, 10));
        assertEquals("no warming after a stand-down", 1, b.count("load"));
    }

    /** A warm load that is already READY is not evidence: the pause is an ordinary one and warming stays. */
    @Test
    public void aPauseAfterTheWarmLoadIsReadyKeepsWarming() {
        playingWithPrepare(true);
        a.emit(new DeckEvent.PausedUncommanded(1, 150));
        assertTrue(pair.available());
    }

    /** Unload is a release: both decks let go, the warm buffer too. */
    @Test
    public void unloadReleasesBothDecks() {
        playingWithPrepare(true);
        pair.send(DeckCommand.UNLOAD);
        assertEquals(1, a.count("unload"));
        assertEquals(1, b.count("unload"));
        pair.send(new DeckCommand.Load(2, "b", URL_B, 300, true));
        assertEquals("nothing warm survives a release", Integer.valueOf(2), a.lastLoadToken());
    }

    /** Teardown reaches both decks, and nothing is routed afterwards. */
    @Test
    public void invalidateTearsDownBothDecks() {
        pair.invalidate();
        assertTrue(a.invalidated);
        assertTrue(b.invalidated);
        pair.send(DeckCommand.PLAY);
        assertEquals(0, a.count("play"));
    }

    /** The prefetch window belongs to the deck with the player role, and moves with it. */
    @Test
    public void thePrefetchWindowFollowsThePlayerRole() {
        assertTrue(a.prepareWindowAvailable);
        assertFalse(b.prepareWindowAvailable);
        playingWithPrepare(true);
        pair.send(new DeckCommand.Load(2, "b", URL_B, 300, true));
        assertFalse(a.prepareWindowAvailable);
        assertTrue(b.prepareWindowAvailable);
    }

    /** A second seam hands back: the roles swap again, each handover moving the focus listener. */
    @Test
    public void aSecondSeamHandsTheRoleBack() {
        playingWithPrepare(true);
        pair.send(new DeckCommand.Load(2, "b", URL_B, 300, true));
        pair.send(DeckCommand.PLAY);
        pair.send(new DeckCommand.Prepare("c", URL_C, 500));
        int warm = a.lastLoadToken();
        assertTrue("the next warm load goes to the deck that stood down", warm < 0);
        a.becomeReady(warm, 500);
        pair.send(new DeckCommand.Load(3, "c", URL_C, 500, true));
        assertEquals(0, pair.activeIndex());
        assertEquals(2, pair.swaps());
        assertEquals(Arrays.asList(1, 0), actives);
        assertEquals(Arrays.asList(3), a.adopted);
    }
}

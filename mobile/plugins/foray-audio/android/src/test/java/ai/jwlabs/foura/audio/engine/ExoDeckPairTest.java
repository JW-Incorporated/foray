package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConstants;
import android.content.Context;
import androidx.annotation.OptIn;
import androidx.media3.common.util.Clock;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.test.utils.FakeClock;
import androidx.media3.test.utils.TestExoPlayerBuilder;
import androidx.media3.test.utils.robolectric.RobolectricUtil;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-40: the Foray tape's deck pair over two REAL ExoDecks (two media3-test-utils players on
 * one auto-advancing {@link FakeClock}, over NE-25a's click tracks). What {@link DeckPairTest}
 * proves with fakes, here with Media3: the playing deck opens the prefetch window its lead before
 * the out-point, the standby deck prerolls the next segment at its in-point, and at the boundary
 * the standby is promoted with no load, the outgoing deck paused before the incoming one plays,
 * never early at the out-point and never two players sounding.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
@OptIn(markerClass = UnstableApi.class)
public class ExoDeckPairTest {
    private static ClickTracks.Fixture fixture(String file) {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.file.equals(file)) return f;
        throw new AssertionError("no click track " + file);
    }

    private static final ClickTracks.Fixture CBR = fixture("click-cbr.mp3");
    private static final ClickTracks.Fixture WAV = firstWav();

    private static ClickTracks.Fixture firstWav() {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.isWav()) return f;
        throw new AssertionError("no WAV click track");
    }

    private final Context context = ApplicationProvider.getApplicationContext();
    private final FakeClock clock = new FakeClock(/* isAutoAdvancing= */ true);
    private final List<ExoPlayer> players = new ArrayList<>();
    private final List<ExoDeck> decks = new ArrayList<>();
    private final List<DeckEvent> events = new ArrayList<>();
    private final List<EngineCommand.DiagEntry> rows = new ArrayList<>();
    private DeckPair pair;

    private ExoDeck deck() {
        ExoPlayer player = new TestExoPlayerBuilder(context).setClock(clock).setRenderers(new CapturingAudioRenderer()).build();
        players.add(player);
        ExoDeck.Config config = new ExoDeck.Config();
        config.mediaSources = ExoDeck.progressive(new DefaultDataSource.Factory(context));
        config.diag = rows::add;
        config.context = context;
        ExoDeck deck = new ExoDeck(player, config);
        decks.add(deck);
        return deck;
    }

    @Before
    public void setUp() {
        ExoDeck a = deck();
        ExoDeck b = deck();
        DeckPair.Config config = new DeckPair.Config();
        config.diag = rows::add;
        pair = new DeckPair(a, b, config);
        pair.setListener(events::add);
    }

    @After
    public void tearDown() {
        pair.invalidate();
        for (ExoPlayer p : players) p.release();
    }

    private void runUntil(BooleanSupplier condition) throws TimeoutException {
        RobolectricUtil.runMainLooperUntil(condition::getAsBoolean, DeckHarness.WAIT_MS, Clock.DEFAULT);
    }

    private <T extends DeckEvent> T find(Class<T> type, int from) {
        for (int i = from; i < events.size(); i++) if (type.isInstance(events.get(i))) return type.cast(events.get(i));
        return null;
    }

    private <T extends DeckEvent> T await(Class<T> type, int from) throws TimeoutException {
        runUntil(() -> find(type, from) != null);
        return find(type, from);
    }

    private int playing() {
        int n = 0;
        for (ExoPlayer p : players) if (p.isPlaying()) n++;
        return n;
    }

    /**
     * THE PREFETCH WINDOW opens {@code PREFETCH_LEAD_SEC} before the out-point, on the playing deck,
     * once: the core's cue to prepare the next segment. TO SEE IT FAIL: drop rearmPrepareWindow from
     * ExoDeck.step.
     */
    @Test
    public void thePlayingDeckOpensThePrefetchWindowItsLeadBeforeTheOutPoint() throws Exception {
        pair.send(new DeckCommand.Load(1, "a", CBR.uri().toString(), 10.0, true));
        await(DeckEvent.Ready.class, 0);
        pair.send(DeckCommand.PLAY);
        pair.send(new DeckCommand.SetOutPoint(40.0));
        DeckEvent.PrepareWindow window = await(DeckEvent.PrepareWindow.class, 0);
        assertEquals(1, window.token());
        double at = players.get(0).getCurrentPosition() / 1000.0;
        double lead = EngineConstants.HtmlAudioBackend.PREFETCH_LEAD_SEC;
        assertTrue("the window opens at the lead before the boundary, not before: " + at, at >= 40.0 - lead - 0.05 && at < 40.0 - lead + 0.5);
        int before = events.size();
        runUntil(() -> clock.elapsedRealtime() > 0 && players.get(0).getCurrentPosition() >= 35_000);
        assertEquals("once per boundary", null, find(DeckEvent.PrepareWindow.class, before));
    }

    /**
     * A HIT with Media3: the standby deck prerolls the next segment at its in-point while the first
     * plays; at the out-point (never early) the load of that segment is a handover, answered with
     * {@code prepared(hit)} and {@code ready} at once, and after the core's play the incoming player
     * sounds from the in-point with the outgoing one paused. TO SEE IT FAIL: promote before pausing
     * the outgoing deck, or load the segment on the playing deck.
     */
    @Test
    public void aPreparedSegmentIsHandedOverAtTheOutPointWithOnePlayerSounding() throws Exception {
        pair.send(new DeckCommand.Load(1, "a", CBR.uri().toString(), 10.0, true));
        await(DeckEvent.Ready.class, 0);
        pair.send(DeckCommand.PLAY);
        pair.send(new DeckCommand.SetOutPoint(20.0));
        await(DeckEvent.PrepareWindow.class, 0);
        pair.send(new DeckCommand.Prepare("b", WAV.uri().toString(), 5.0));
        runUntil(decks.get(1)::isReady);
        assertFalse("the standby prerolls paused", players.get(1).getPlayWhenReady());
        assertEquals("prerolled at the in-point", 5.0, players.get(1).getCurrentPosition() / 1000.0, 0.01);

        DeckEvent.Ended ended = await(DeckEvent.Ended.class, 0);
        assertEquals(1, ended.token());
        double stoppedAt = players.get(0).getCurrentPosition() / 1000.0;
        assertTrue("never early at the out-point: " + stoppedAt, stoppedAt >= 20.0 - 0.001);
        assertEquals(0, playing());

        int from = events.size();
        pair.send(new DeckCommand.Load(2, "b", WAV.uri().toString(), 5.0, true));
        DeckEvent.Prepared report = find(DeckEvent.Prepared.class, from);
        assertNotNull("the handover reports the prepare", report);
        assertTrue("a hit", report.hit());
        DeckEvent.Ready ready = find(DeckEvent.Ready.class, from);
        assertNotNull("ready at once, for the core's token", ready);
        assertEquals(2, ready.token());
        assertEquals(1, pair.activeIndex());
        assertEquals(1, pair.swaps());

        pair.send(DeckCommand.PLAY);
        runUntil(() -> players.get(1).isPlaying());
        assertEquals("one player sounding", 1, playing());
        assertFalse(players.get(0).getPlayWhenReady());
        double startedAt = players.get(1).getCurrentPosition() / 1000.0;
        assertTrue("the incoming segment starts at its in-point: " + startedAt, startedAt >= 5.0 && startedAt < 5.3);
        pair.send(new DeckCommand.SetOutPoint(8.0));
        DeckEvent.Ended second = await(DeckEvent.Ended.class, from);
        assertEquals("the incoming deck's events carry the core's token", 2, second.token());
    }
}

package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.RouteWatcher;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.RouteResume;
import ai.jwlabs.foura.engine.Vocabulary;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-61: route resume through the Android host, end to end: the {@link RouteWatcher} hears
 * devices come and go (and BECOMING_NOISY), the {@link ForayEngineHost} hands the core its current
 * route on every turn, and the REAL {@link EngineStore} keeps the known routes in the engine's own
 * file, {@code ForayEngine.knownRoutes}. The twin of the iOS RouteResumeHostTests (NE-38rs), on
 * the card's three acceptance lines: a listener's pause, then the device removed and re-added, is
 * not resumed; a car-mode route lost and back resumes exactly once; the keys survive a store
 * reload. (ForayPlaybackServiceTest proves the service's AudioDeviceCallback feeds the watcher
 * from ShadowAudioManager's devices; this drives the watcher with the same devices directly.)
 *
 * <p>Each test names the edit that turns it red.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class RouteResumeHostTest {
    static final String CAR_ADDRESS = "8C:DE:52:11:22:33";
    static final RouteWatcher.Device SPEAKER = new RouteWatcher.Device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, 1, "");
    static final RouteWatcher.Device CAR = new RouteWatcher.Device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, 7, CAR_ADDRESS);

    private Context context;
    private final List<String> lines = new ArrayList<>();

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        prefs(EngineStore.SHARED_FILE).edit().clear().commit();
        prefs(EngineStore.PRIVATE_FILE).edit().clear().commit();
    }

    private SharedPreferences prefs(String name) {
        return context.getSharedPreferences(name, Context.MODE_PRIVATE);
    }

    /** A host over fakes, the real store, and a watcher that has seen the speaker (and {@code seeded}). */
    final class Rig {
        final ForayEngineHostTest.FakeDeck deck = new ForayEngineHostTest.FakeDeck();
        final ForayEngineHostTest.FakeSession session = new ForayEngineHostTest.FakeSession();
        final ForayEngineHostTest.FakeTiming timing = new ForayEngineHostTest.FakeTiming();
        final EngineStore store = new EngineStore(context, new EngineLog(() -> timing.wallMs(), lines::add), null);
        boolean inCar;
        final RouteWatcher watcher = new RouteWatcher(() -> inCar, () -> timing.mono);
        final ForayEngineHost host;

        Rig(RouteWatcher.Device... seeded) {
            List<RouteWatcher.Device> present = new ArrayList<>();
            present.add(SPEAKER);
            Collections.addAll(present, seeded);
            watcher.seed(present);
            host = new ForayEngineHost(new EngineSeams(deck, session, timing, store).withRoutes(watcher, store),
                    new EngineConfig("test").withRouteResume(false, "", null));
            host.start();
        }

        void feed(List<EngineInput.RouteChange> changes) {
            for (EngineInput.RouteChange c : changes) host.handle(new EngineInput.Session(new EngineInput.SessionEvent.Route(c)));
        }

        void noisy() {
            EngineInput.RouteChange named = watcher.onNoisy();
            if (named != null) host.handle(new EngineInput.Session(new EngineInput.SessionEvent.Route(named)));
        }

        /** Item "a" playing, confirmed audible. */
        void play() {
            host.handle(ForayEngineHostTest.load("a"));
            host.handle(ForayEngineHostTest.playIndex(0));
            deck.emit(new DeckEvent.Ready(deck.lastToken, 0, true, 5));
            deck.emit(new DeckEvent.TimeControl(deck.lastToken, DeckEvent.TimeControlStatus.PLAYING, null));
        }

        void tap(EngineContract.Command command) {
            host.handle(new EngineInput.Command(command, Vocabulary.Source.TAP));
        }

        void advance(double ms) {
            timing.mono += ms;
        }
    }

    /** The {@code route} rows written so far, as JSON. */
    List<JsonNode> routeRows() {
        List<JsonNode> out = new ArrayList<>();
        for (String l : lines) {
            String[] parts = l.split(" ", 4);
            if (parts.length == 4 && parts[2].equals("route")) out.add(JsonNode.parse(parts[3]));
        }
        return out;
    }

    List<JsonNode> backs(String decision) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode r : routeRows()) {
            if (JsonNode.str("back").equals(r.get("kind")) && JsonNode.str(decision).equals(r.get("decision"))) out.add(r);
        }
        return out;
    }

    /**
     * A listener's pause, then the car removed and re-added: NOT resumed, although the car is known.
     * TO SEE IT FAIL: route a pause's press as "play" in EngineCore.pressName, or drop the pausedBy
     * check from RouteResume.decision.
     */
    @Test
    public void aListenersPauseThenTheDeviceRemovedAndReAddedIsNotResumed() {
        Rig r = new Rig();
        r.inCar = true;
        r.feed(r.watcher.onAdded(Collections.singletonList(CAR)));
        r.play();
        r.advance(1_500);
        r.tap(EngineContract.Command.PAUSE);
        int plays = r.deck.count(DeckCommand.Play.class);
        int loads = r.deck.count(DeckCommand.Load.class);
        r.advance(2_000);
        r.feed(r.watcher.onRemoved(Collections.singletonList(CAR)));
        r.advance(60_000);
        r.feed(r.watcher.onAdded(Collections.singletonList(CAR)));
        assertEquals("nothing played after the listener's pause: " + lines, plays, r.deck.count(DeckCommand.Play.class));
        assertEquals(loads, r.deck.count(DeckCommand.Load.class));
        assertTrue(lines.toString(), backs("resume").isEmpty());
        List<JsonNode> no = backs("no");
        JsonNode last = no.get(no.size() - 1);
        assertEquals(JsonNode.str("listener-paused"), last.get("why"));
        assertEquals(JsonNode.str("car"), last.get("class"));
        assertEquals("the car was known: the pause alone kept it paused", JsonNode.TRUE, last.get("known"));
        r.host.teardown();
    }

    /**
     * A car-mode route lost while playing (BECOMING_NOISY first, then the removal, as Android sends
     * them) and back: exactly one resume, and the removal adds no second loss. Entering car mode
     * again with the car current resumes nothing more. TO SEE IT FAIL: let the watcher report the
     * removal after the broadcast named it (two losses), or keep the loss after a resume.
     */
    @Test
    public void aCarModeRouteLostAndBackResumesExactlyOnce() {
        Rig r = new Rig();
        r.inCar = true;
        r.feed(r.watcher.onAdded(Collections.singletonList(CAR)));
        r.play();
        r.advance(1_500);
        r.noisy();
        assertEquals("interrupted", r.host.state().stateType());
        assertTrue("the removal after the broadcast is the same loss", r.watcher.onRemoved(Collections.singletonList(CAR)).isEmpty());
        long losses = routeRows().stream().filter(x -> JsonNode.str("lost").equals(x.get("kind"))).count();
        assertEquals(lines.toString(), 1, losses);
        JsonNode lost = routeRows().get(routeRows().size() - 1);
        assertEquals(JsonNode.str("car"), lost.get("class"));
        assertEquals(JsonNode.TRUE, lost.get("known"));
        int plays = r.deck.count(DeckCommand.Play.class) + r.deck.count(DeckCommand.Load.class);

        r.advance(600_000);
        r.feed(r.watcher.onAdded(Collections.singletonList(CAR)));
        assertEquals(lines.toString(), 1, backs("resume").size());
        assertTrue("the resume played: " + r.deck.sent,
                r.deck.count(DeckCommand.Play.class) + r.deck.count(DeckCommand.Load.class) > plays);
        r.feed(r.watcher.onCarMode(true));
        assertEquals("a second word about the same route resumes nothing", 1, backs("resume").size());
        r.host.teardown();
    }

    /**
     * The known routes survive a store reload: the store holds the salted keys (never the
     * address), a new host over the same store knows the car without hearing it again, and a data
     * deletion removes the key. TO SEE IT FAIL: drop persistKnownRoutesIfChanged from the host's
     * turn, or read the salt from anywhere but the store.
     */
    @Test
    public void theKeysSurviveAStoreReload() {
        Rig first = new Rig();
        first.inCar = true;
        first.feed(first.watcher.onAdded(Collections.singletonList(CAR)));
        first.play();
        first.advance(1_500);
        first.noisy();
        String raw = first.store.knownRoutesRaw();
        assertNotNull("the known car was written: " + lines, raw);
        assertFalse("never the address: " + raw, raw.contains(CAR_ADDRESS));
        assertFalse(raw.contains("8C:DE"));
        RouteResume.Stored stored = first.store.loadKnownRoutes();
        assertEquals(1, stored.keys().size());
        assertEquals(stored.salt(), first.host.core().config().routeSalt());
        first.host.teardown();

        // A new process: the same file, the car already connected, heard for only 0.2 s.
        lines.clear();
        Rig reloaded = new Rig(CAR);
        reloaded.inCar = true;
        assertEquals(stored.salt(), reloaded.host.core().config().routeSalt());
        assertEquals(stored.keys(), reloaded.host.state().knownRoutes.keys());
        reloaded.play();
        reloaded.advance(200);
        reloaded.noisy();
        assertEquals("known from the store: " + lines, JsonNode.TRUE, routeRows().get(0).get("known"));
        reloaded.feed(reloaded.watcher.onRemoved(Collections.singletonList(CAR)));
        reloaded.advance(5_000);
        reloaded.feed(reloaded.watcher.onAdded(Collections.singletonList(CAR)));
        assertEquals(lines.toString(), 1, backs("resume").size());

        reloaded.tap(new EngineContract.Command.Purge());
        assertNull("Delete my data removes the key", reloaded.store.knownRoutesRaw());
        reloaded.host.teardown();
    }

    /**
     * Out of car mode the same A2DP device is a Bluetooth route and the arm is off (D-A9): no
     * resume, and the row says bluetooth-off. When the projection then starts (car mode), the
     * watcher reports the route again as a car and it resumes. TO SEE IT FAIL: class A2DP as a car
     * in RouteWatcher.classOf, or drop the car-mode re-report.
     */
    @Test
    public void outOfCarModeItIsBluetoothAndTheProjectionStartingResumes() {
        Rig r = new Rig();
        r.inCar = true;
        r.feed(r.watcher.onAdded(Collections.singletonList(CAR)));
        r.play();
        r.advance(1_500);
        r.noisy();
        r.feed(r.watcher.onRemoved(Collections.singletonList(CAR)));
        r.inCar = false;
        r.advance(60_000);
        r.feed(r.watcher.onAdded(Collections.singletonList(CAR)));
        List<JsonNode> no = backs("no");
        assertEquals(lines.toString(), JsonNode.str("bluetooth-off"), no.get(no.size() - 1).get("why"));
        assertTrue(backs("resume").isEmpty());
        r.inCar = true;
        r.advance(4_000);
        r.feed(r.watcher.onCarMode(true));
        assertEquals(lines.toString(), 1, backs("resume").size());
        r.host.teardown();
    }

    /** The card's class mapping. */
    @Test
    public void theClassMapping() {
        assertEquals(RouteResume.RouteClass.BLUETOOTH, RouteWatcher.classOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, false));
        assertEquals(RouteResume.RouteClass.BLUETOOTH, RouteWatcher.classOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, false));
        assertEquals(RouteResume.RouteClass.BLUETOOTH, RouteWatcher.classOf(AudioDeviceInfo.TYPE_BLE_HEADSET, false));
        assertEquals(RouteResume.RouteClass.BLUETOOTH, RouteWatcher.classOf(AudioDeviceInfo.TYPE_BLE_SPEAKER, false));
        assertEquals(RouteResume.RouteClass.BLUETOOTH, RouteWatcher.classOf(AudioDeviceInfo.TYPE_BLE_BROADCAST, false));
        assertEquals(RouteResume.RouteClass.OTHER, RouteWatcher.classOf(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, false));
        assertEquals(RouteResume.RouteClass.OTHER, RouteWatcher.classOf(AudioDeviceInfo.TYPE_USB_HEADSET, false));
        assertEquals(RouteResume.RouteClass.CAR, RouteWatcher.classOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, true));
        assertEquals(RouteResume.RouteClass.CAR, RouteWatcher.classOf(AudioDeviceInfo.TYPE_USB_DEVICE, true));
    }

    /**
     * The watcher's own bookkeeping: a device that does not become the route is nothing, a removal
     * with no broadcast before it is the loss, and a broadcast right after that removal is dropped.
     */
    @Test
    public void theWatcherReportsOneLossPerRoute() {
        double[] mono = {0};
        RouteWatcher w = new RouteWatcher(() -> false, () -> mono[0]);
        w.seed(Collections.singletonList(SPEAKER));
        assertEquals("speaker", w.currentRoute().portType());
        List<EngineInput.RouteChange> added = w.onAdded(Collections.singletonList(CAR));
        assertEquals(1, added.size());
        assertFalse(added.get(0).oldDeviceUnavailable());
        assertEquals("a2dp", added.get(0).portType());
        assertEquals(CAR_ADDRESS, added.get(0).portUID());
        assertEquals(new EngineInput.RoutePort("a2dp", CAR_ADDRESS), w.currentRoute());
        // A second output that is not the route going is nothing; the speaker going is nothing.
        assertTrue(w.onRemoved(Collections.singletonList(SPEAKER)).isEmpty());
        List<EngineInput.RouteChange> removed = w.onRemoved(Collections.singletonList(CAR));
        assertEquals(1, removed.size());
        assertTrue(removed.get(0).oldDeviceUnavailable());
        mono[0] += 500;
        assertNull("the broadcast after the removal is the same loss", w.onNoisy());
        mono[0] += RouteWatcher.NOISY_AFTER_REMOVAL_MS + 1;
        assertNull("nothing tracked: a loss that names no port", w.onNoisy().portType());
    }

    /**
     * The registration's echo (and a build that re-sends the whole list on a port update) is not
     * an arrival: devices already attached, in any order, change neither the route nor report
     * one coming back. TO SEE IT FAIL: drop the already-attached skip from RouteWatcher.onAdded
     * (re-tracking the wired headset last makes it the route and reports it back).
     */
    @Test
    public void anEchoOfDevicesAlreadyAttachedIsNothing() {
        RouteWatcher w = new RouteWatcher(() -> true, () -> 0);
        RouteWatcher.Device wired = new RouteWatcher.Device(AudioDeviceInfo.TYPE_USB_HEADSET, 3, "card=1;device=0");
        w.seed(java.util.Arrays.asList(SPEAKER, wired, CAR));
        assertEquals(new EngineInput.RoutePort("a2dp", CAR_ADDRESS), w.currentRoute());
        assertTrue(w.onAdded(java.util.Arrays.asList(CAR, wired, SPEAKER)).isEmpty());
        assertEquals("the car is still the route", new EngineInput.RoutePort("a2dp", CAR_ADDRESS), w.currentRoute());
        // A real arrival still is one.
        RouteWatcher.Device other = new RouteWatcher.Device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, 9, "8C:DE:52:44:55:66");
        assertEquals(1, w.onAdded(java.util.Arrays.asList(CAR, other)).size());
    }
}

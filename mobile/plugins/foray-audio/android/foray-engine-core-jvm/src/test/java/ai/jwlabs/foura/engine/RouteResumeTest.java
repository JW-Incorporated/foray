package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand.GraceReason;
import ai.jwlabs.foura.engine.EngineCoreTest.Host;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * Card A-61: route resume in the JVM core, the twin of the Swift RouteResumeTests (NE-38rs). The pure
 * rule is the {@code route-resume} parity family's (RouteResumeFamily, run by ParitySuite); these
 * drive the WHOLE core the way the Android host does, through {@link EngineCoreTest.Host}, for what
 * the family cannot see: the salted keys and the rows, the one-second "heard" rule, the grace and
 * activation of a resume, the either-order attribution, the wall clock, the class the host hands
 * in (car mode), and the known set a reload hands back.
 *
 * <p>Each test names the edit that turns it red.
 */
public class RouteResumeTest {
    static final String SALT = "00112233445566778899aabbccddeeff";
    /** A Bluetooth car's A2DP (SessionMonitor's port token), by its address. */
    static final String CAR_ADDRESS = "8C:DE:52:11:22:33";
    static final EngineInput.RoutePort CAR = new EngineInput.RoutePort("a2dp", CAR_ADDRESS);
    /** A wired headset with an address (a USB one has one), so it has a key and is known: `other` still never resumes. */
    static final EngineInput.RoutePort WIRED = new EngineInput.RoutePort("usb", "card=1;device=0");

    static EngineInput.RouteChange lost(EngineInput.RoutePort port, RouteResume.RouteClass cls) {
        return new EngineInput.RouteChange(true, port.portType(), port.uid(), cls);
    }

    static EngineInput.RouteChange back(EngineInput.RoutePort port, RouteResume.RouteClass cls) {
        return new EngineInput.RouteChange(false, port.portType(), port.uid(), cls);
    }

    static EngineConfig config() {
        return config(false, SessionPolicy.HoldPolicy.DEFAULT, null);
    }

    static EngineConfig config(boolean bluetooth, SessionPolicy.HoldPolicy hold, List<String> known) {
        return new EngineConfig("test", hold, null).withRouteResume(bluetooth, SALT, known);
    }

    /** A host playing item "a", confirmed audible through {@code route}. */
    static Host playingThrough(EngineInput.RoutePort route, EngineConfig config) {
        Host host = new Host(config);
        host.route = route;
        host.send(EngineCoreTest.load("a"));
        host.send(EngineCoreTest.playIndex(0));
        host.land();
        host.confirm();
        assertEquals("playing", host.core.state().stateType());
        return host;
    }

    static EngineInput route(EngineInput.RouteChange change) {
        return EngineCoreTest.session(new EngineInput.SessionEvent.Route(change));
    }

    static List<EngineCommand.DiagEntry> routeRows(List<EngineCommand> commands) {
        return EngineCoreTest.rows("route", commands);
    }

    /** The one {@code route kind=back} row of a turn. */
    static EngineCommand.DiagEntry backRow(List<EngineCommand> commands) {
        List<EngineCommand.DiagEntry> backs = new ArrayList<>();
        for (EngineCommand.DiagEntry e : routeRows(commands)) if (JsonNode.str("back").equals(e.field("kind"))) backs.add(e);
        assertEquals(commands.toString(), 1, backs.size());
        return backs.get(0);
    }

    static boolean resumed(List<EngineCommand> commands) {
        return commands.contains(new EngineCommand.GraceBegin(GraceReason.ROUTE_RESUME));
    }

    // ---- the card's acceptance cases

    /**
     * Q5: a listener's pause is never resumed, even when the car it played through (a KNOWN car)
     * is then removed and re-added. A-42's core resumed it (a known car name, and the reducer models
     * a listener's pause as interrupted-was-playing). TO SEE IT FAIL: route a pause's press as
     * "play" in pressName, or drop the pausedBy check from RouteResume.decision.
     */
    @Test
    public void aListenersPauseIsNotResumedWhenTheDeviceIsRemovedAndReAdded() {
        Host car = playingThrough(CAR, config());
        car.send(EngineContract.Command.PAUSE);
        car.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        List<EngineCommand> back = car.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        assertFalse("a listener's pause was resumed: " + back, resumed(back));
        assertEquals(-1, EngineCoreTest.index(back, EngineCoreTest::isLoad));
        assertEquals(-1, EngineCoreTest.index(back, EngineCoreTest::isPlay));
        EngineCommand.DiagEntry row = backRow(back);
        assertEquals(JsonNode.str("no"), row.field("decision"));
        assertEquals(JsonNode.str("listener-paused"), row.field("why"));
        assertEquals(JsonNode.str("listener"), row.field("pausedBy"));
        assertEquals("the car was known: the pause alone kept it paused", JsonNode.TRUE, row.field("known"));
    }

    /**
     * A car-mode route lost while playing and back: exactly one resume, as a car's press is one:
     * grace from the moment it comes back, the {@code resume kind=route} row, the activation (the
     * hold ran out while it was gone), then the play. A second back resumes nothing. TO SEE IT
     * FAIL: drop the begin(ROUTE_RESUME) in onRoute, or keep the loss after a resume in
     * RouteResume.step (two resumes).
     */
    @Test
    public void aCarModeRouteLostAndBackResumesExactlyOnce() {
        Host car = playingThrough(CAR, config(false, SessionPolicy.HoldPolicy.until(1), null));
        List<EngineCommand> lost = car.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        EngineCommand.DiagEntry lostRow = routeRows(lost).get(0);
        assertEquals(JsonNode.str("lost"), lostRow.field("kind"));
        assertEquals(JsonNode.TRUE, lostRow.field("known"));
        assertEquals(JsonNode.str("car"), lostRow.field("class"));
        assertEquals(JsonNode.str("a2dp"), lostRow.field("port"));
        assertEquals("interrupted", car.core.state().stateType());
        // The car stays off long enough for the hold to run out.
        car.send(new EngineInput.Timer(EngineTimer.HOLD_EXPIRED), 60_000);
        assertNotEquals("premise: the session was released while the car was gone",
                SessionPolicy.Phase.ACTIVE, car.core.state().session);

        List<EngineCommand> back = car.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        EngineCommand.DiagEntry row = backRow(back);
        assertEquals(JsonNode.str("resume"), row.field("decision"));
        assertEquals(JsonNode.str("route-back"), row.field("why"));
        assertEquals(JsonNode.str("route"), row.field("pausedBy"));
        int graces = 0;
        for (EngineCommand c : back) if (c.equals(new EngineCommand.GraceBegin(GraceReason.ROUTE_RESUME))) graces++;
        assertEquals(back.toString(), 1, graces);
        int grace = back.indexOf(new EngineCommand.GraceBegin(GraceReason.ROUTE_RESUME));
        int activation = EngineCoreTest.index(back, c -> c instanceof EngineCommand.SessionActivate);
        assertTrue("no activation: " + back, activation >= 0);
        assertTrue("grace covers the activation, as for a car's press", grace < activation);
        List<EngineCommand.DiagEntry> resumeRows = EngineCoreTest.rows("resume", back);
        assertEquals(1, resumeRows.size());
        assertEquals(JsonNode.str("route"), resumeRows.get(0).field("kind"));
        assertEquals(JsonNode.str("route-resume"), resumeRows.get(0).field("graceReason"));
        assertTrue("the resume plays: " + back,
                EngineCoreTest.index(back, EngineCoreTest::isPlay) >= 0 || EngineCoreTest.index(back, EngineCoreTest::isLoad) >= 0);

        List<EngineCommand> again = car.send(route(back(CAR, RouteResume.RouteClass.CAR)), 300);
        assertFalse("a second back resumed again: " + again, resumed(again));
        assertEquals(JsonNode.str("not-paused"), backRow(again).field("why"));
    }

    /**
     * The same A2DP device OUT of car mode is a Bluetooth route, and the arm is off (D-A9): the
     * row says so, and nothing resumes. With the arm on, the same return resumes; and a car whose
     * projection starts after its Bluetooth connected is reported again as {@code car} (the
     * watcher's car-mode re-report), which resumes, because a {@code no} never clears the loss.
     * TO SEE IT FAIL: pass the arm as true from the core, or drop the class check.
     */
    @Test
    public void bluetoothWithTheArmOffIsNoAndACarModeReReportResumes() {
        Host off = playingThrough(CAR, config());
        off.send(route(lost(CAR, RouteResume.RouteClass.BLUETOOTH)));
        List<EngineCommand> back = off.send(route(back(CAR, RouteResume.RouteClass.BLUETOOTH)));
        EngineCommand.DiagEntry row = backRow(back);
        assertEquals(JsonNode.str("no"), row.field("decision"));
        assertEquals(JsonNode.str("bluetooth-off"), row.field("why"));
        assertEquals(JsonNode.str("bluetooth"), row.field("class"));
        assertFalse(resumed(back));
        // Android Auto starts projecting a few seconds later: car mode, the same device.
        List<EngineCommand> projected = off.send(route(back(CAR, RouteResume.RouteClass.CAR)), 4_000);
        assertEquals(JsonNode.str("route-back"), backRow(projected).field("why"));
        assertTrue(projected.toString(), resumed(projected));

        Host on = playingThrough(CAR, config(true, SessionPolicy.HoldPolicy.DEFAULT, null));
        on.send(route(lost(CAR, RouteResume.RouteClass.BLUETOOTH)));
        List<EngineCommand> armed = on.send(route(back(CAR, RouteResume.RouteClass.BLUETOOTH)));
        assertEquals(JsonNode.str("resume"), backRow(armed).field("decision"));
        assertTrue(resumed(armed));
    }

    /**
     * The known set survives a reload: a core built from what the host stored (the salt and the
     * keys, through Stored's own bytes) knows the car without hearing it again, and a core with an
     * empty set does not. (EngineStoreTest and RouteResumeHostTest do the same through the real
     * store.) TO SEE IT FAIL: drop the knownRoutes seeding from the EngineCore constructor, or hash
     * with anything but config.routeSalt.
     */
    @Test
    public void theKnownSetSurvivesAReload() {
        Host first = playingThrough(CAR, config());
        first.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        RouteResume.Stored stored = new RouteResume.Stored(SALT, first.core.state().knownRoutes.keys());
        assertEquals(1, stored.keys().size());
        RouteResume.Stored reread = RouteResume.Stored.parse(stored.serialized());
        assertEquals(stored, reread);

        // Played through the phone's speaker (no route heard), then the car.
        Host reloaded = playingThrough(null, config(false, SessionPolicy.HoldPolicy.DEFAULT, reread.keys()));
        reloaded.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        List<EngineCommand> back = reloaded.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        assertEquals(JsonNode.TRUE, backRow(back).field("known"));
        assertTrue(back.toString(), resumed(back));

        Host fresh = playingThrough(null, config());
        fresh.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        List<EngineCommand> unknown = fresh.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        assertEquals(JsonNode.str("unknown-route"), backRow(unknown).field("why"));
        assertFalse(resumed(unknown));
    }

    /**
     * No row carries the raw address (DiagGate; plan §10): every row of a whole drive (play, loss,
     * return, resume) is searched for it, and the key the rows do carry is the first 8 hex of the
     * salted hash. TO SEE IT FAIL: write change.portUID() into the route rows, or the whole hashed
     * key instead of RouteResume.rowKey.
     */
    @Test
    public void noRowCarriesTheRawAddress() {
        Host car = playingThrough(CAR, config());
        List<EngineCommand> all = new ArrayList<>(car.send(route(lost(CAR, RouteResume.RouteClass.CAR))));
        all.addAll(car.send(route(back(CAR, RouteResume.RouteClass.CAR))));
        all.addAll(car.land());
        all.addAll(car.confirm());
        int diags = 0;
        for (EngineCommand c : all) {
            if (!(c instanceof EngineCommand.Diag d)) continue;
            diags++;
            List<JsonNode.Member> members = new ArrayList<>();
            members.add(JsonNode.member("kind", JsonNode.str(d.entry().kind())));
            members.addAll(d.entry().fields());
            String text = JSWriter.stringify(new JsonNode.Obj(members));
            assertFalse("the raw address reached a row: " + text, text.contains(CAR_ADDRESS));
            assertFalse("part of the raw address reached a row: " + text, text.contains("8C:DE"));
        }
        assertTrue(diags > 0);
        String hashed = RouteResume.hashedKey("a2dp", CAR_ADDRESS, SALT);
        assertNotNull(hashed);
        List<EngineCommand.DiagEntry> rows = routeRows(all);
        assertEquals(2, rows.size());
        for (EngineCommand.DiagEntry row : rows) assertEquals(JsonNode.str(hashed.substring(0, 8)), row.field("key"));
        assertEquals("the set holds the salted hash, never the address",
                Collections.singletonList(hashed), car.core.state().knownRoutes.keys());
    }

    // ---- the rest of the rule, end to end

    /**
     * A route becomes known only after our audio was heard through it for a second: half a second
     * and then the device gone is an unknown route. TO SEE IT FAIL: lower KNOWN_AFTER_MS to 0, or
     * mark a route known at playing instead of a second later.
     */
    @Test
    public void aRouteHeardForLessThanASecondIsNotKnown() {
        Host car = playingThrough(CAR, config());
        List<EngineCommand> lost = car.send(route(lost(CAR, RouteResume.RouteClass.CAR)), 500);
        assertEquals(JsonNode.FALSE, routeRows(lost).get(0).field("known"));
        List<EngineCommand> back = car.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        assertEquals(JsonNode.str("unknown-route"), backRow(back).field("why"));
        assertFalse(resumed(back));
    }

    /**
     * A second and a half heard, then a stall, then half a second more and the device gone: the car
     * WAS heard for a second, so it is known and its return resumes (the NE-38rs review). TO SEE IT
     * FAIL: drop the known-set update from stopHearing.
     */
    @Test
    public void aStallDoesNotForgetASecondAlreadyHeard() {
        Host car = playingThrough(CAR, config());
        int token = car.lastLoad;
        car.reading.audible = false;
        car.send(new EngineInput.Deck(new DeckEvent.TimeControl(token, DeckEvent.TimeControlStatus.WAITING, null)), 1_500);
        car.reading.audible = true;
        car.send(new EngineInput.Deck(new DeckEvent.TimeControl(token, DeckEvent.TimeControlStatus.PLAYING, null)), 300);
        List<EngineCommand> lost = car.send(route(lost(CAR, RouteResume.RouteClass.CAR)), 500);
        assertEquals(lost.toString(), JsonNode.TRUE, routeRows(lost).get(0).field("known"));
        List<EngineCommand> back = car.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        assertEquals(JsonNode.str("route-back"), backRow(back).field("why"));
        assertTrue(back.toString(), resumed(back));
    }

    /**
     * Either order (plan §4.3): the deck's own pause arrives first and is blamed on the system, then
     * the route goes within 500 ms. It is still the loss of a PLAYING route, so its return resumes
     * it. TO SEE IT FAIL: drop the snapshot restore in onRoute.
     */
    @Test
    public void anUncommandedPauseJustBeforeTheLossIsStillTheRoutes() {
        Host car = playingThrough(CAR, config());
        car.reading.audible = false;
        car.send(new EngineInput.Deck(new DeckEvent.PausedUncommanded(car.lastLoad, 3)));
        assertEquals(RouteResume.PausedBy.SYSTEM, car.core.state().routeResume.pausedBy());
        car.send(route(lost(CAR, RouteResume.RouteClass.CAR)), 200);
        assertEquals(RouteResume.PausedBy.ROUTE, car.core.state().routeResume.pausedBy());
        List<EngineCommand> back = car.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        assertTrue(back.toString(), resumed(back));
    }

    /**
     * A call while the car is gone clears it (Q5), and so does a loss older than 24 h, measured on
     * the WALL clock (the monotonic one moves a second; a phone asleep in a parked car does not
     * count uptime). TO SEE IT FAIL: step INTERRUPTION nowhere, or measure lostSec on now.monoMs.
     */
    @Test
    public void aCallOrADayAndAnHourKeepsItPaused() {
        Host call = playingThrough(CAR, config());
        call.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        call.send(EngineCoreTest.session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        call.send(EngineCoreTest.session(new EngineInput.SessionEvent.InterruptionEnded(false)));
        assertEquals(JsonNode.str("interrupted"), backRow(call.send(route(back(CAR, RouteResume.RouteClass.CAR)))).field("why"));

        Host parked = playingThrough(CAR, config());
        parked.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        parked.wallMs += 25 * 3_600_000.0;
        List<EngineCommand> back = parked.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        EngineCommand.DiagEntry row = backRow(back);
        assertEquals(JsonNode.str("lost-too-long"), row.field("why"));
        assertEquals(JsonNode.num(25 * 3_600), row.field("lostSec"));
        assertFalse(resumed(back));
    }

    /** Delete my data forgets every known route (the host then removes the private key). TO SEE IT FAIL: drop the reset from stop(false). */
    @Test
    public void aDataDeletionForgetsTheRoutes() {
        Host car = playingThrough(CAR, config());
        car.send(route(lost(CAR, RouteResume.RouteClass.CAR)));
        assertEquals(1, car.core.state().knownRoutes.keys().size());
        car.send(new EngineContract.Command.Purge());
        assertEquals(Collections.emptyList(), car.core.state().knownRoutes.keys());
    }

    /**
     * A loss that names no port (A-26's BECOMING_NOISY with nothing tracked) still pauses, with a
     * route row that has no key, and nothing ever resumes it. TO SEE IT FAIL: key a portless route.
     */
    @Test
    public void aPortlessLossPausesAndNeverResumes() {
        Host host = playingThrough(CAR, config());
        List<EngineCommand> lost = host.send(route(new EngineInput.RouteChange(true)));
        assertEquals(JsonNode.NULL, routeRows(lost).get(0).field("key"));
        assertEquals("interrupted", host.core.state().stateType());
        List<EngineCommand> back = host.send(route(back(CAR, RouteResume.RouteClass.CAR)));
        assertEquals(JsonNode.str("no-loss"), backRow(back).field("why"));
        assertFalse(resumed(back));
    }

    // ---- the pieces

    /** FIPS 180-4's vectors: the hash the keys are made of is SHA-256. */
    @Test
    public void sha256MatchesTheStandardVectors() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", RouteResume.sha256Hex(""));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", RouteResume.sha256Hex("abc"));
        assertEquals("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
                RouteResume.sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"));
        byte[] thousand = new byte[1_000];
        Arrays.fill(thousand, (byte) 0x61);
        assertEquals("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3", RouteResume.sha256Hex(thousand));
    }

    /** The Swift core hashes "salt\nport|uid" the same way: the same bytes give the same key on both platforms. */
    @Test
    public void aKeyIsTheSaltedHashOfPortAndAddress() {
        String expected = RouteResume.sha256Hex((SALT + "\n" + "CarAudio|u").getBytes(StandardCharsets.UTF_8));
        assertEquals(expected, RouteResume.hashedKey("CarAudio", "u", SALT));
    }

    /** A key is salted: one device under two installs' salts is two keys; no address is no key. */
    @Test
    public void keysAreSaltedAndNeedAnAddress() {
        String one = RouteResume.hashedKey("a2dp", "u", SALT);
        String other = RouteResume.hashedKey("a2dp", "u", "ffffffffffffffffffffffffffffffff");
        assertNotNull(one);
        assertNotEquals(one, other);
        assertTrue(RouteResume.isHashedKey(one));
        assertEquals(8, RouteResume.rowKey(one).length());
        assertNull(RouteResume.hashedKey("a2dp", "", SALT));
        assertNull(RouteResume.hashedKey(null, "u", SALT));
        assertTrue(RouteResume.isSalt(RouteResume.newSalt()));
        assertNotEquals(RouteResume.newSalt(), RouteResume.newSalt());
    }

    /** At most eight, least recently used first out; hearing one again makes it the most recent; anything else is dropped. */
    @Test
    public void theKnownSetKeepsTheEightMostRecentlyHeard() {
        List<String> keys = new ArrayList<>();
        for (int i = 0; i < 9; i++) keys.add(RouteResume.sha256Hex("k" + i));
        List<String> seed = new ArrayList<>(keys.subList(0, 8));
        seed.add("not-a-key");
        RouteResume.KnownRoutes set = new RouteResume.KnownRoutes(seed);
        assertEquals(keys.subList(0, 8), set.keys());
        RouteResume.KnownRoutes used = set.use(keys.get(0));
        assertNotEquals("heard again: now the most recent", set, used);
        assertSame("already the most recent: nothing to write", used, used.use(keys.get(0)));
        RouteResume.KnownRoutes full = used.use(keys.get(8));
        assertEquals(8, full.keys().size());
        assertFalse("the least recently used went first", full.contains(keys.get(1)));
        assertTrue(full.contains(keys.get(0)));
        assertEquals(keys.get(8), full.keys().get(full.keys().size() - 1));
        assertNull(RouteResume.Stored.parse("{\"v\":2,\"salt\":\"" + SALT + "\",\"keys\":[]}"));
        assertNull(RouteResume.Stored.parse("{\"v\":1,\"salt\":\"short\",\"keys\":[]}"));
        assertNull(RouteResume.Stored.parse(null));
        assertNull(RouteResume.Stored.parse("not json"));
    }

    /** The stored bytes are the Swift Stored's: {"v":1,"salt":...,"keys":[...]}, in that order. */
    @Test
    public void theStoredFormIsTheSwiftOnes() {
        String key = RouteResume.sha256Hex("k");
        assertEquals("{\"v\":1,\"salt\":\"" + SALT + "\",\"keys\":[\"" + key + "\"]}",
                new RouteResume.Stored(SALT, Collections.singletonList(key)).serialized());
    }
}

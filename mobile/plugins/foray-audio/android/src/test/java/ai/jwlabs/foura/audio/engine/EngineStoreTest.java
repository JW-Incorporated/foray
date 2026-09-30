package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.Rows;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-27: {@link EngineStore}, where the Android engine keeps what it keeps. The JVM twin of
 * the iOS EngineStoreTests (NE-19): the shared rows land in the page's Preferences file as the
 * exact bytes; the engine writes no row it does not own; the restore record lives in the
 * engine's own file, is committed before the write returns and survives a new process; and a
 * purge leaves no engine key behind and the page's rows alone. Each test names the edit that
 * turns it red.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class EngineStoreTest {
    private Context context;
    private final List<String> lines = new ArrayList<>();
    /** What the store told the receiver switch, in order. */
    private final List<Boolean> switched = new ArrayList<>();

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        prefs(EngineStore.SHARED_FILE).edit().clear().commit();
        prefs(EngineStore.PRIVATE_FILE).edit().clear().commit();
    }

    private SharedPreferences prefs(String name) {
        return context.getSharedPreferences(name, Context.MODE_PRIVATE);
    }

    private EngineStore store() {
        return new EngineStore(context, new EngineLog(() -> 0, lines::add), switched::add);
    }

    /**
     * THE acceptance line of NE-19, on Android: the host, driving the REAL store, writes
     * {@code cp_pos} and the page's own file ({@code @capacitor/preferences}' default group)
     * holds the identical string under the bare row key. TO SEE IT FAIL: store the row in the
     * engine's own file, prefix the key, or re-serialise the value.
     */
    @Test
    public void theEngineWritesCpPosIntoThePagesFileAsTheExactBytes() {
        EngineStore store = store();
        ForayEngineHostTest.FakeDeck deck = new ForayEngineHostTest.FakeDeck();
        ForayEngineHostTest.FakeTiming timing = new ForayEngineHostTest.FakeTiming();
        ForayEngineHost host = new ForayEngineHost(new EngineSeams(deck, new ForayEngineHostTest.FakeSession(), timing, store),
                new EngineConfig("test"));
        host.start();
        host.handle(ForayEngineHostTest.load("ep-1"));
        host.handle(ForayEngineHostTest.playIndex(0));
        deck.emit(new ai.jwlabs.foura.engine.DeckEvent.Ready(deck.lastToken, 0, true, 5));
        deck.reading.positionSec = 42.0;
        host.remote(new EngineInput.RemotePress(ai.jwlabs.foura.engine.MediaMapping.RemoteCommand.PAUSE));

        String key = Rows.positionKey("ep-1");
        String stored = prefs("CapacitorStorage").getString(key, null);
        assertTrue("the pause wrote the playhead: " + lines, stored != null && stored.contains("42"));
        String stamp = Rows.timestamp(timing.wallMs());
        assertEquals(Rows.position("ep-1", 42.0, 90.0, stamp).value(), stored);
        assertEquals(stored, store.readShared(key));
        assertEquals(stored, store.sharedRows(Arrays.asList(key)).get(key));
        assertTrue("and the record the cold path restores from: " + store.restoreRecordRaw(), store.restorable());
        RestoreRecord record = store.restoreRecord();
        assertEquals(42.0, record.offsetSec(), 0);
        assertTrue("every write is a row too", String.join("\n", lines).contains(" position item=ep-1 sec=42"));
        host.teardown();
    }

    /** The engine writes ONLY its own rows in the page's file. TO SEE IT FAIL: drop the owned-row guard. */
    @Test
    public void theStoreRefusesARowItDoesNotOwn() {
        EngineStore store = store();
        assertFalse(store.writeShared(new Rows.StoredRow("cp_rate", "1.5")));
        assertNull(prefs(EngineStore.SHARED_FILE).getString("cp_rate", null));
        assertTrue(lines.get(lines.size() - 1), lines.get(lines.size() - 1).contains(" fault ") && lines.get(lines.size() - 1).contains("not-owned"));
        assertTrue(store.writeShared(new Rows.StoredRow("cp_last_episode", "{\"id\":\"a\"}")));
        assertEquals("{\"id\":\"a\"}", prefs(EngineStore.SHARED_FILE).getString("cp_last_episode", null));
    }

    /**
     * The record is in the engine's own file under iOS's name, never in the page's, and a new
     * process (a new store over the same files) reads it back. TO SEE IT FAIL: keep the record
     * in memory only, or write it into {@code CapacitorStorage}.
     */
    @Test
    public void theRestoreRecordIsPrivateAndSurvivesANewProcess() {
        EngineStore store = store();
        RestoreRecord written = ColdPathTest.record(754);
        store.writeRestore(written);
        assertEquals(written.serialized(), prefs(EngineStore.PRIVATE_FILE).getString("ForayEngine.restore", null));
        for (String key : prefs(EngineStore.SHARED_FILE).getAll().keySet()) assertFalse(key, key.contains("ForayEngine"));

        EngineStore relaunched = store();
        assertEquals(written.serialized(), relaunched.restoreRecord().serialized());
        assertTrue(relaunched.restorable());
        assertTrue("the receiver asks without a service", EngineStore.restorable(context));
        assertTrue("a record to resume changes nothing: the service switched the receiver on", switched.isEmpty());
    }

    /**
     * Nothing to resume switches the car's way in off (a relinquished record, a cleared one), and
     * a record written after that switches it back on (a listener who deleted their data and then
     * played again). Only changes are told. TO SEE IT FAIL: call the switch on every write, never
     * switch it back on, or never switch it off.
     */
    @Test
    public void theReceiverSwitchFollowsWhetherThereIsSomethingToResume() {
        EngineStore store = store();
        store.writeRestore(ColdPathTest.record(754));
        store.writeRestore(ColdPathTest.record(760));
        assertTrue("writes while resumable tell nothing: " + switched, switched.isEmpty());
        store.writeRestore(RestoreRecord.relinquished("2026-09-24T12:00:00.000Z", "android-1"));
        assertEquals(Arrays.asList(false), switched);
        assertFalse(store.restorable());
        assertFalse(EngineStore.restorable(context));
        store.writeRestore(null);
        assertEquals("already off", Arrays.asList(false), switched);
        assertNull(prefs(EngineStore.PRIVATE_FILE).getString(EngineStore.KEY_RESTORE, null));
        store.writeRestore(ColdPathTest.record(30));
        assertEquals("played again after a deletion: on again", Arrays.asList(false, true), switched);
        assertTrue(EngineStore.restorable(context));

        prefs(EngineStore.PRIVATE_FILE).edit().putString(EngineStore.KEY_RESTORE, "{\"v\":99}").commit();
        assertFalse("a record this build cannot trust is none", EngineStore.restorable(context));
        assertNull(store().restoreRecord());
    }

    /**
     * Delete my data: every shared engine row and every key in the engine's own file (today's and
     * one a later card might add) are gone, enumerated; the page's own rows are the page's to
     * clear. TO SEE IT FAIL: purge only the restore key, or remove every CapacitorStorage key.
     */
    @Test
    public void purgeLeavesNoEngineKeyAndThePagesRowsAlone() {
        EngineStore store = store();
        for (String row : Arrays.asList("cp_pos:ep-1", "cp_foray:f-1", "cp_last_episode")) {
            assertTrue(store.writeShared(new Rows.StoredRow(row, "{}")));
        }
        store.writeRestore(ColdPathTest.record(754));
        prefs(EngineStore.PRIVATE_FILE).edit().putString("ForayEngine.someFutureKey", "later").commit();
        prefs(EngineStore.SHARED_FILE).edit().putString("cp_rate", "1.5").putString("cp_engine_applied", "{}").commit();

        List<String> removed = store.purge();
        assertEquals(Arrays.asList("ForayEngine.restore", "ForayEngine.someFutureKey", "cp_foray:f-1", "cp_last_episode", "cp_pos:ep-1"),
                removed);
        assertTrue(prefs(EngineStore.PRIVATE_FILE).getAll().isEmpty());
        Map<String, ?> left = prefs(EngineStore.SHARED_FILE).getAll();
        assertEquals("the page's rows stay", 2, left.size());
        assertEquals("1.5", left.get("cp_rate"));
        assertNull(store.restoreRecord());
        assertEquals(Arrays.asList(false), switched);
        assertTrue(store.sharedRows(null).isEmpty());
    }
}

package ai.jwlabs.foura.notify;

import static ai.jwlabs.foura.notify.AlertRulesTest.T0;
import static ai.jwlabs.foura.notify.AlertRulesTest.T1;
import static ai.jwlabs.foura.notify.AlertRulesTest.T2;
import static ai.jwlabs.foura.notify.AlertRulesTest.T3;
import static ai.jwlabs.foura.notify.AlertRulesTest.record;
import static ai.jwlabs.foura.notify.AlertRulesTest.row;
import static ai.jwlabs.foura.notify.AlertRulesTest.rows;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Whole {@link AlertsRefresh} passes against the app's real SharedPreferences
 * files (Robolectric runs the framework's own), with a fake network, a
 * recording poster and a fixed clock (issue #761; PQ-29). The Android twin of
 * the "one whole pass" half of iOS's {@code AlertsRefreshTests.swift}, the
 * stale-page guard included.
 *
 * <p>Each test names the one-line mutation it exists to catch.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AlertsRefreshTest {

    private SharedPreferences page;
    private SharedPreferences ledger;

    @Before
    public void setUp() {
        Context app = ApplicationProvider.getApplicationContext();
        page = AlertsRefresh.pageStore(app);
        ledger = AlertsRefresh.ledgerStore(app);
        page.edit().clear().commit();
        ledger.edit().clear().commit();
    }

    private void store(JSONObject shows) {
        page.edit().putString(AlertRules.STARRED_SHOWS_KEY, shows.toString()).commit();
    }

    private static JSONObject shows(Object... idThenRecord) throws Exception {
        JSONObject out = new JSONObject();
        for (int i = 0; i + 1 < idThenRecord.length; i += 2) out.put((String) idThenRecord[i], idThenRecord[i + 1]);
        return out;
    }

    private JSONObject stored(String id) {
        return AlertsRefresh.readShows(page).optJSONObject(id);
    }

    /** One pass. {@code answers.get(id)} is the show's page 1, absent = a failed
     *  request; {@code during} runs inside the fetch, while the "request" is out. */
    private List<List<String>> pass(Map<String, JSONArray> answers, long now, Runnable during) {
        List<List<String>> posts = new ArrayList<>();
        AlertsRefresh refresh = new AlertsRefresh(page, ledger,
            id -> {
                if (during != null) during.run();
                return answers.get(id);
            },
            (title, body, id) -> posts.add(Arrays.asList(title, body, id)),
            () -> now);
        refresh.run();
        return posts;
    }

    private List<List<String>> pass(Map<String, JSONArray> answers, long now) {
        return pass(answers, now, null);
    }

    private static Map<String, JSONArray> answer(String id, JSONArray rows) {
        Map<String, JSONArray> m = new HashMap<>();
        m.put(id, rows);
        return m;
    }

    /** The row lives where {@code @capacitor/preferences} keeps it, the ledger does NOT,
     *  and the row is written back as the page writes it (no {@code \/}).
     *  MUTATION: {@code LEDGER_FILE = "CapacitorStorage"} -> the page's file gains a key.
     *  MUTATION 2: drop {@code .replace("\\/", "/")} in {@code writeShows}. */
    @Test
    public void theRowIsThePagesAndTheLedgerIsOutsideItsFile() throws Exception {
        assertEquals("CapacitorStorage", AlertRules.PREFERENCES_FILE);
        assertEquals("cp_starred_shows", AlertRules.STARRED_SHOWS_KEY);
        store(shows("s1", record("s1", "seen_published_at", T1)));
        pass(answer("s1", rows(row(T2, "Ep 2"))), T0);
        assertEquals("the page's file holds the page's row and nothing else",
            Collections.singleton(AlertRules.STARRED_SHOWS_KEY), page.getAll().keySet());
        assertEquals(T2, AlertsRefresh.readLedger(ledger).get("s1"));
        String raw = page.getString(AlertRules.STARRED_SHOWS_KEY, "");
        assertTrue(raw, raw.contains("\"artwork_url\":\"https://example.com/a.jpg\""));
        assertFalse(raw, raw.contains("\\/"));
    }

    /** A first check posts nothing; a later episode posts once, the show over the
     *  episode, and the row is written back in the page's shape.
     *  MUTATION: drop {@code post.post(line[0], line[1], id)} in {@code apply}. */
    @Test
    public void aNewEpisodePostsOneAlertAndTheRowIsWrittenBack() throws Exception {
        store(shows("s1", record("s1")));
        assertEquals(Collections.emptyList(), pass(answer("s1", rows(row(T1, "Ep 1"))), T0));
        assertEquals(T1, stored("s1").get("seen_published_at"));

        long later = T0 + AlertRules.CHECK_INTERVAL_MS;
        assertEquals(Collections.singletonList(Arrays.asList("Show One", "Ep 2", "s1")),
            pass(answer("s1", rows(row(T2, "Ep 2"), row(T1, "Ep 1"))), later));
        assertEquals(1, stored("s1").getInt("unseen_count"));
        assertEquals(T2, stored("s1").get("latest_published_at"));
        assertEquals(AlertRules.isoString(later), stored("s1").get("checked_at"));
        assertEquals(Collections.singletonMap("s1", T2), AlertsRefresh.readLedger(ledger));
    }

    /** THE STALE-PAGE GUARD: a record rolled back by the page does not notify twice.
     *  The refresh posts for Ep 2; a stale page then writes its older copy back
     *  (watermark and latest at Ep 1, an old {@code checked_at}); the next pass
     *  counts Ep 2 as unseen again (the badge is right) but posts nothing, and a
     *  genuinely newer Ep 3 still posts.
     *  MUTATION: {@code shouldNotify} returns true -> the second pass posts Ep 2 again.
     *  MUTATION 2: {@code ledger.put(id, stamp)} removed -> the same. */
    @Test
    public void aRecordRolledBackByThePageDoesNotNotifyTwice() throws Exception {
        String old = AlertRules.isoString(T0 - 7L * 3600 * 1000);
        JSONObject pageCopy = record("s1", "seen_published_at", T1, "latest_published_at", T1, "checked_at", old, "unseen_count", 0);
        store(shows("s1", pageCopy));
        assertEquals(Collections.singletonList(Arrays.asList("Show One", "Ep 2", "s1")),
            pass(answer("s1", rows(row(T2, "Ep 2"), row(T1, "Ep 1"))), T0));

        store(shows("s1", pageCopy)); // the stale page writes its copy back
        assertEquals("Ep 2 was already announced", Collections.emptyList(),
            pass(answer("s1", rows(row(T2, "Ep 2"), row(T1, "Ep 1"))), T0));
        assertEquals("the badge still counts it", 1, stored("s1").getInt("unseen_count"));

        store(shows("s1", pageCopy));
        assertEquals(Collections.singletonList(Arrays.asList("Show One", "Ep 3", "s1")),
            pass(answer("s1", rows(row(T3, "Ep 3"), row(T2, "Ep 2"), row(T1, "Ep 1"))), T0));
        assertEquals(Collections.singletonMap("s1", T3), AlertsRefresh.readLedger(ledger));
    }

    /** A failed request leaves the record untouched, so the show stays due.
     *  MUTATION: in {@code run}, put an empty array for a failed show instead of skipping it. */
    @Test
    public void aFailedRequestLeavesTheRecordUntouched() throws Exception {
        store(shows("s1", record("s1")));
        assertEquals(Collections.emptyList(), pass(new HashMap<>(), T0));
        assertFalse(stored("s1").has("checked_at"));
        assertTrue(AlertRules.dueForCheck(stored("s1"), T0));
    }

    /** A show unfollowed while its request was out is not brought back, and its
     *  ledger entry goes with it.
     *  MUTATION: drop the {@code if (!(current instanceof JSONObject)) continue;} guard
     *  in {@code apply} (afterCheck(null) would write the show back). */
    @Test
    public void anUnfollowDuringTheCheckIsNotUndone() throws Exception {
        ledger.edit().putString(AlertRules.LEDGER_KEY, "{\"s1\":\"" + T1 + "\",\"gone\":\"" + T1 + "\"}").commit();
        store(shows("s1", record("s1", "seen_published_at", T1)));
        pass(answer("s1", rows(row(T2, "Ep 2"))), T0, () -> store(new JSONObject()));
        assertNull(stored("s1"));
        assertNull("the ledger names no unfollowed show", ledger.getString(AlertRules.LEDGER_KEY, null));
    }

    /** The ledger is pruned to the shows still followed.
     *  MUTATION: {@code writeLedger} keeps every key. */
    @Test
    public void theLedgerIsPrunedToFollowedShows() throws Exception {
        store(shows("s1", record("s1")));
        ledger.edit().putString(AlertRules.LEDGER_KEY, "{\"s1\":\"" + T1 + "\",\"gone\":\"" + T2 + "\"}").commit();
        AlertsRefresh.pruneLedger(page, ledger);
        assertEquals(Collections.singletonMap("s1", T1), AlertsRefresh.readLedger(ledger));
    }
}

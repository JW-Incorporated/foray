package ai.jwlabs.foura.notify;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;

import com.getcapacitor.JSObject;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Collections;

/**
 * The plugin's bridge face (issue #761; PQ-29): the tap that emits
 * {@code alertOpened { showId }} (the PQ-28 contract {@code player/alert-open.js}
 * routes), the cold-start hold, and {@code notifyNow}'s notification on the
 * {@code foray_alerts} channel. Driven through the plugin's own methods with
 * {@link RecordingCall}s and the framework's real NotificationManager (Robolectric).
 *
 * <p>Each test names the one-line mutation it exists to catch.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ForayNotifyPluginTest {

    /** The plugin with its one bridge dependency, the Context, supplied directly. */
    static final class TestPlugin extends ForayNotifyPlugin {
        private final Context context;

        TestPlugin(Context context) {
            this.context = context;
        }

        @Override
        public Context getContext() {
            return context;
        }
    }

    private Context app;
    private TestPlugin plugin;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        AlertsRefresh.pageStore(app).edit().clear().commit();
        AlertsRefresh.ledgerStore(app).edit().clear().commit();
        plugin = new TestPlugin(app);
    }

    private RecordingCall listen() {
        RecordingCall call = RecordingCall.of("addListener", "eventName", AlertRules.EVENT_ALERT_OPENED);
        plugin.addListener(call);
        return call;
    }

    private static String showIdOf(JSObject event) {
        return event.getString("showId");
    }

    /** A warm tap (the app running) emits {@code alertOpened { showId }} at once, and
     *  the intent's extras are spent so nothing replays it.
     *  MUTATION: drop {@code consumeAlertIntent(intent)} from {@code handleOnNewIntent}.
     *  MUTATION 2: drop the two {@code removeExtra} lines. */
    @Test
    public void aWarmTapEmitsAlertOpenedWithTheShow() {
        RecordingCall listener = listen();
        Intent tap = AlertPoster.tapIntent(app, "lex-fridman");
        plugin.handleOnNewIntent(tap);
        assertEquals(1, listener.resolved.size());
        assertEquals("lex-fridman", showIdOf(listener.resolved.get(0)));
        assertFalse(tap.hasExtra(AlertRules.EXTRA_SHOW_ID));
        plugin.handleOnNewIntent(tap);
        assertEquals("a spent intent emits nothing", 1, listener.resolved.size());
    }

    /** A cold tap arrives before the page listens: it is HELD, only the last one, and
     *  handed to the first listener that attaches, once.
     *  MUTATION: drop the held-tap release from {@code addListener} -> the cold tap is lost.
     *  MUTATION 2: {@code heldShowId = showId} -> {@code if (heldShowId == null) heldShowId = showId}
     *  (the first tap would win). */
    @Test
    public void aColdTapIsHeldUntilAListenerAttachesAndTheLastOneWins() {
        plugin.consumeAlertIntent(AlertPoster.tapIntent(app, "s1"));
        plugin.consumeAlertIntent(AlertPoster.tapIntent(app, "s2"));
        RecordingCall listener = listen();
        assertEquals(1, listener.resolved.size());
        assertEquals("s2", showIdOf(listener.resolved.get(0)));
        RecordingCall second = listen();
        assertTrue("the hold is released once", second.resolved.isEmpty());
    }

    /** An intent without our marker (a plain launch, a shared link) emits nothing.
     *  MUTATION: read only {@code EXTRA_SHOW_ID}, ignoring the marker. */
    @Test
    public void anIntentThatIsNotOursEmitsNothing() {
        RecordingCall listener = listen();
        Intent plain = new Intent(Intent.ACTION_MAIN).putExtra(AlertRules.EXTRA_SHOW_ID, "s1");
        plugin.handleOnNewIntent(plain);
        assertTrue(listener.resolved.isEmpty());
        assertTrue("someone else's extras are left alone", plain.hasExtra(AlertRules.EXTRA_SHOW_ID));
    }

    /** {@code notifyNow} posts on the {@code foray_alerts} channel ("New episodes"), one
     *  per show by tag, and the tap carries the show back to the plugin.
     *  MUTATION: drop {@code launch.putExtra(EXTRA_SHOW_ID, showId)} in {@code tapIntent}.
     *  MUTATION 2: {@code CHANNEL_ID = "foray_playback"} -> the channel pin fails. */
    @Test
    public void notifyNowPostsOnTheAlertsChannelAndItsTapCarriesTheShow() {
        RecordingCall call = RecordingCall.of("notifyNow", "title", "Show One", "body", "Ep 2", "showId", "s1");
        plugin.notifyNow(call);
        assertEquals(1, call.resolved.size());
        NotificationManager manager = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = manager.getNotificationChannel("foray_alerts");
        assertNotNull("the channel exists after the first post", channel);
        assertEquals("New episodes", channel.getName().toString());
        Notification posted = shadowOf(manager).getNotification("foray-alert-s1", 0);
        assertNotNull(posted);
        assertEquals("foray_alerts", posted.getChannelId());
        assertEquals("Show One", posted.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals("Ep 2", posted.extras.getCharSequence(Notification.EXTRA_TEXT).toString());
        Intent tap = shadowOf(posted.contentIntent).getSavedIntent();
        assertEquals("alert", tap.getStringExtra(AlertRules.EXTRA_MARKER));
        assertEquals("s1", tap.getStringExtra(AlertRules.EXTRA_SHOW_ID));
        assertEquals(app.getPackageName(), tap.getPackage() != null ? tap.getPackage() : tap.getComponent().getPackageName());
    }

    /** {@code notifyNow} without a show is refused, as on iOS.
     *  MUTATION: drop the {@code showId} guard -> an alert whose tap opens nothing. */
    @Test
    public void notifyNowWithoutAShowIsRefused() {
        RecordingCall call = RecordingCall.of("notifyNow", "title", "Show One");
        plugin.notifyNow(call);
        assertEquals(Collections.singletonList("showId is required"), call.rejected);
        assertTrue(call.resolved.isEmpty());
    }

    /** Loading the plugin prunes the ledger to the shows still followed.
     *  MUTATION: drop {@code AlertsRefresh.pruneLedger(context)} from {@code load}. */
    @Test
    public void loadPrunesTheLedgerToFollowedShows() {
        AlertsRefresh.pageStore(app).edit().putString(AlertRules.STARRED_SHOWS_KEY, "{\"s1\":{\"show_id\":\"s1\"}}").commit();
        AlertsRefresh.ledgerStore(app).edit()
            .putString(AlertRules.LEDGER_KEY, "{\"s1\":\"2026-10-01T09:00:00.000Z\",\"gone\":\"2026-10-01T09:00:00.000Z\"}").commit();
        plugin.load();
        assertEquals(Collections.singletonMap("s1", "2026-10-01T09:00:00.000Z"),
            AlertsRefresh.readLedger(AlertsRefresh.ledgerStore(app)));
    }
}

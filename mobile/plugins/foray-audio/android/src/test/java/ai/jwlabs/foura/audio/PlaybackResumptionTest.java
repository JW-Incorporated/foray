package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.EngineLog;
import ai.jwlabs.foura.audio.engine.EnginePlayer;
import ai.jwlabs.foura.audio.engine.EngineStore;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.SessionPolicy;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.view.KeyEvent;
import androidx.media3.common.Player;
import androidx.media3.common.util.Clock;
import androidx.media3.session.MediaController;
import androidx.media3.session.MediaSession;
import androidx.test.core.app.ApplicationProvider;
import androidx.media3.test.utils.robolectric.RobolectricUtil;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.ExecutionException;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;

/**
 * Card A-27: a car's PLAY after the process died, through the service and Media3. The restore
 * record the engine left is in the store; the service comes up cold (as the media button
 * receiver starts it); its session is empty and says it can resume; Media3's
 * {@code onPlaybackResumption} answers with the recorded item and position; applying that answer
 * boots the engine from the record (painted, paused, nothing activated); and the play that
 * follows loads the recorded item AT the recorded position. Plus the receiver: switched on by
 * the service, off in the manifest, and it takes a PLAY only when there is something to resume.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class PlaybackResumptionTest {
    private Context context;
    private ServiceController<ForayPlaybackService> controller;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(EngineStore.PRIVATE_FILE, Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences(EngineStore.SHARED_FILE, Context.MODE_PRIVATE).edit().clear().commit();
    }

    @After
    public void tearDown() {
        if (controller != null) controller.destroy();
        controller = null;
    }

    private ForayPlaybackService create() {
        controller = Robolectric.buildService(ForayPlaybackService.class).create();
        return controller.get();
    }

    private static JsonNode item(String id) {
        return new JsonNode.Obj(Arrays.asList(JsonNode.member("id", JsonNode.str(id)), JsonNode.member("kind", JsonNode.str("episode")),
                JsonNode.member("title", JsonNode.str("Episode " + id)), JsonNode.member("show", JsonNode.str("A Show")),
                /* An asset that is not there: the deck's load fails fast and offline, which these
                   tests do not wait for. */
                JsonNode.member("audio_url", JsonNode.str("asset:///a27/" + id + ".mp3")),
                JsonNode.member("duration_sec", JsonNode.num(3600))));
    }

    /** The record the engine wrote at the pause, before the process died. */
    private void storeRecord(double offsetSec) {
        RestoreRecord record = new RestoreRecord(RestoreRecord.Mode.EPISODE, Arrays.asList(item("a"), item("b")), 0, offsetSec, null, 1,
                null, Collections.<JsonNode>emptyList(), Collections.<JsonNode>emptyList(), "2026-09-29T12:00:00.000Z", "android-1");
        new EngineStore(context, new EngineLog(() -> 0, line -> {}), null).writeRestore(record);
    }

    private String dump(ForayPlaybackService s) {
        StringWriter out = new StringWriter();
        s.dump(null, new PrintWriter(out), new String[0]);
        return out.toString();
    }

    @Test
    public void theReceiverIsOffInTheManifestAndTheServiceSwitchesItOn() {
        PackageManager pm = context.getPackageManager();
        assertFalse("off until the native engine runs: the JS lane never registers it",
                ForayMediaButtonReceiver.isEnabled(context));
        create();
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                pm.getComponentEnabledSetting(ForayMediaButtonReceiver.component(context)));
    }

    @Test
    public void theReceiverTakesAPlayOnlyWhenThereIsSomethingToResume() {
        ForayMediaButtonReceiver receiver = new ForayMediaButtonReceiver();
        Intent play = new Intent(Intent.ACTION_MEDIA_BUTTON).putExtra(Intent.EXTRA_KEY_EVENT,
                new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY));
        assertFalse("nothing stored: the press is dropped, and no service is started to die unplayed",
                receiver.shouldStartForegroundService(context, play));
        storeRecord(754);
        assertTrue(receiver.shouldStartForegroundService(context, play));
        new EngineStore(context, new EngineLog(() -> 0, line -> {}), null)
                .writeRestore(RestoreRecord.relinquished("2026-09-29T12:00:00.000Z", "android-1"));
        assertFalse("the legacy lane owns playback", receiver.shouldStartForegroundService(context, play));
    }

    /**
     * The whole resumption, step by step, as Media3 runs it. TO SEE IT FAIL: drop the two
     * commands from the empty state (Media3 never asks), answer without the offset, make
     * {@code handleSetMediaItems} a no-op (nothing to play), or restore in {@code resumption}
     * itself (a metadata-only ask would boot the engine).
     */
    @Test
    public void anEmptySessionResumesTheRecordAtItsPosition() throws Exception {
        storeRecord(754);
        ForayPlaybackService s = create();
        MediaSession session = s.session();
        assertNotNull(session);
        Player player = session.getPlayer();
        assertEquals("cold: nothing loaded", Player.STATE_IDLE, player.getPlaybackState());
        assertTrue("Media3 resumes only a player that can take an item", player.isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM));
        assertTrue("and can play", player.isCommandAvailable(Player.COMMAND_PLAY_PAUSE));

        ListenableFuture<MediaSession.MediaItemsWithStartPosition> answer = s.resumption(false);
        assertTrue(answer.isDone());
        MediaSession.MediaItemsWithStartPosition items = answer.get();
        assertEquals(1, items.mediaItems.size());
        assertEquals(EnginePlayer.MEDIA_ID, items.mediaItems.get(0).mediaId);
        assertEquals("Episode a", String.valueOf(items.mediaItems.get(0).mediaMetadata.title));
        assertEquals("A Show", String.valueOf(items.mediaItems.get(0).mediaMetadata.artist));
        assertEquals(754_000, items.startPositionMs);
        assertFalse("asking is not restoring", s.host().hasHandledInput());

        // What Media3 does with the answer: set it, then press play.
        player.setMediaItem(items.mediaItems.get(0), items.startPositionMs);
        assertEquals("applying the answer is the cold boot: painted, paused", Player.STATE_READY, player.getPlaybackState());
        assertFalse(player.getPlayWhenReady());
        assertEquals("Episode a", String.valueOf(player.getMediaMetadata().title));
        assertEquals(754_000, player.getContentPosition());
        assertEquals("a boot activates nothing", 0, s.host().activations());
        assertFalse("and the resumption door closes behind it", player.isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM));

        player.play();
        assertEquals(1, s.host().activations());
        assertEquals(SessionPolicy.Phase.ACTIVE, s.host().state().session);
        assertEquals("the deck loads the recorded item", "a", s.host().state().currentItem().id);
        assertEquals("AT the recorded position", 754_000, s.exoPlayer().getCurrentPosition(), 1_000);
        String text = dump(s);
        assertTrue(text, text.contains("\"coldBoot\":\"painted\""));
        assertTrue(text, text.contains("\"mediaButtonReceiver\":true"));
        String rows = String.join("\n", s.rows());
        assertTrue(rows, rows.contains("resumption {\"kind\":\"answer\",\"forPlayback\":false,\"record\":\"episode\",\"item\":\"a\",\"offsetSec\":754}"));
        assertTrue(rows, rows.contains("\"kind\":\"cold-boot\",\"record\":\"painted\""));
    }

    /**
     * The same, end to end through a Media3 controller: a play on the empty session makes Media3
     * itself call {@code onPlaybackResumption}, apply the answer and play. TO SEE IT FAIL: remove
     * {@code onPlaybackResumption} from the session callback.
     */
    @Test
    public void aControllersPlayOnTheEmptySessionGoesThroughMedia3sResumption() throws Exception {
        storeRecord(754);
        ForayPlaybackService s = create();
        ListenableFuture<MediaController> future = new MediaController.Builder(context, s.session().getToken())
                .setApplicationLooper(Looper.getMainLooper())
                .buildAsync();
        RobolectricUtil.runMainLooperUntil(future::isDone, 60_000, Clock.DEFAULT);
        MediaController c = future.get();
        try {
            c.play();
            RobolectricUtil.runMainLooperUntil(() -> s.host().activations() > 0, 60_000, Clock.DEFAULT);
            assertEquals(SessionPolicy.Phase.ACTIVE, s.host().state().session);
            assertEquals("a", s.host().state().currentItem().id);
            assertEquals(754_000, s.exoPlayer().getCurrentPosition(), 1_000);
            assertTrue(String.join("\n", s.rows()), String.join("\n", s.rows()).contains("resumption {\"kind\":\"answer\",\"forPlayback\":true"));
        } finally {
            c.release();
        }
    }

    /**
     * With nothing stored the empty session offers nothing to resume, and an ask fails, so Media3
     * plays as asked and the engine answers {@code noActionableNowPlayingItem}. TO SEE IT FAIL:
     * declare the resumption commands unconditionally.
     */
    @Test
    public void withNothingStoredThereIsNothingToResume() throws Exception {
        ForayPlaybackService s = create();
        Player player = s.session().getPlayer();
        assertFalse(player.isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM));
        assertFalse(player.isCommandAvailable(Player.COMMAND_PLAY_PAUSE));
        ListenableFuture<MediaSession.MediaItemsWithStartPosition> answer = s.resumption(true);
        assertTrue(answer.isDone());
        try {
            answer.get();
            throw new AssertionError("an answer with nothing stored");
        } catch (ExecutionException expected) {
            assertTrue(expected.getCause() instanceof UnsupportedOperationException);
        }
        assertEquals(ForayEngineHost.ColdBootOutcome.NO_RECORD, s.restoreIfCold());
        assertEquals("once is all", ForayEngineHost.ColdBootOutcome.LATE, s.restoreIfCold());
    }

    /** Once the engine has an input, the door is shut: the page's queue is never replaced by a record. */
    @Test
    public void aDrivenEngineIsNeverRestoredOver() {
        storeRecord(754);
        ForayPlaybackService s = create();
        s.handle(new ai.jwlabs.foura.engine.EngineInput.Queue(new ai.jwlabs.foura.engine.EngineInput.QueueInput.Load(
                ForayPlaybackService.items("[{\"id\":\"x\",\"kind\":\"episode\",\"audio_url\":\"asset:///a27/x.mp3\"}]"))));
        assertFalse(s.session().getPlayer().isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM));
        assertEquals(ForayEngineHost.ColdBootOutcome.LATE, s.restoreIfCold());
        assertEquals("x", s.host().state().queue.get(0).id);
    }
}

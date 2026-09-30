package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import ai.jwlabs.foura.audio.engine.EngineLane;
import ai.jwlabs.foura.audio.engine.EngineLog;
import ai.jwlabs.foura.audio.engine.EnginePlayer;
import ai.jwlabs.foura.audio.engine.EngineStore;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.audio.engine.OwnershipCore;
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
import java.lang.reflect.Field;
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
    public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(EngineStore.PRIVATE_FILE, Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences(EngineStore.SHARED_FILE, Context.MODE_PRIVATE).edit().clear().commit();
        resetOwner();
        /* The native lane, as a listener who chose Native in the Developer drawer has it (the
           stock build is the JS lane until A-31): the cold path is the native lane's alone. */
        setOverride("native");
    }

    @After
    public void tearDown() throws Exception {
        if (controller != null) controller.destroy();
        controller = null;
        resetOwner();
    }

    /** The Developer engine setting, as the owner stores it (EngineLane.PREFS, iOS's key). */
    private void setOverride(String mode) {
        context.getSharedPreferences(EngineLane.PREFS, Context.MODE_PRIVATE).edit()
                .putString(OwnershipCore.KEY_OVERRIDE, mode).commit();
    }

    /** The process's owner is a static; each test is a new process. */
    private static void resetOwner() throws Exception {
        Field shared = EngineOwnership.class.getDeclaredField("shared");
        shared.setAccessible(true);
        shared.set(null, null);
    }

    private static Intent playKey() {
        return new Intent(Intent.ACTION_MEDIA_BUTTON).putExtra(Intent.EXTRA_KEY_EVENT,
                new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY));
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

    /**
     * A-27 review: the record outlives the lane. A listener who put the Developer engine back to
     * Automatic (the stock JS lane) or to Web still has the record the native engine wrote, and a
     * car's PLAY must not boot the native engine from it. TO SEE IT FAIL: drop the lane from
     * {@code ForayMediaButtonReceiver.answersColdPress} or from the service's {@code onCreate}.
     */
    @Test
    public void inTheJsLaneTheRecordAnswersNoPress() {
        storeRecord(754);
        ForayMediaButtonReceiver receiver = new ForayMediaButtonReceiver();
        assertTrue("the native lane resumes it", receiver.shouldStartForegroundService(context, playKey()));
        for (String mode : new String[] {"auto", "web"}) {
            setOverride(mode);
            assertFalse(mode + ": the JS lane's", receiver.shouldStartForegroundService(context, playKey()));
        }
        create();
        assertFalse("a JS-lane process that starts the service never arms the receiver",
                ForayMediaButtonReceiver.isEnabled(context));
    }

    /**
     * A-27 review: a process that decides the JS lane switches off a receiver an earlier native
     * process left on, before the page's own session is built (Media3 hands an enabled manifest
     * receiver to every session). TO SEE IT FAIL: drop the switch from EngineOwnership.decideOnce.
     */
    @Test
    public void aJsLaneDecisionSwitchesTheReceiverOff() {
        ForayMediaButtonReceiver.setEnabled(context, true);
        setOverride("auto");
        assertEquals("legacy", EngineOwnership.shared(context).decideOnce().mode());
        assertFalse(ForayMediaButtonReceiver.isEnabled(context));
    }

    /**
     * A-27 review: a media button start the service cannot keep is declined, not left to die.
     * Below API 31 Media3 gives every session (the JS lane's too) a media button PendingIntent to
     * this service, so after a JS-lane process died a PLAY starts it in the foreground with nothing
     * to resume; Media3 alone would never call startForeground, and API 26-30 kills the app. TO
     * SEE IT FAIL: remove {@code onStartCommand}'s guard (the service is not stopped).
     */
    @Test
    public void aMediaButtonStartWithNothingToResumeIsDeclined() {
        setOverride("auto");
        controller = Robolectric.buildService(ForayPlaybackService.class, playKey()).create().startCommand(0, 1);
        ForayPlaybackService s = controller.get();
        shadowOf(Looper.getMainLooper()).idle();
        assertTrue("stopped, having kept the foreground start's promise", shadowOf(s).isStoppedBySelf());
        String rows = String.join("\n", s.rows());
        assertTrue(rows, rows.contains("\"kind\":\"decline-media-button\""));
        assertEquals(0, s.host().activations());
    }

    /**
     * The same start in the native lane with a record: Media3's, which resumes the record (the
     * receiver's door, end to end in the service). TO SEE IT FAIL: decline every media button start.
     */
    @Test
    public void aMediaButtonStartThatCanResumeIsMedia3s() throws Exception {
        storeRecord(754);
        controller = Robolectric.buildService(ForayPlaybackService.class, playKey()).create().startCommand(0, 1);
        ForayPlaybackService s = controller.get();
        RobolectricUtil.runMainLooperUntil(() -> s.host() != null && s.host().activations() > 0, 60_000, Clock.DEFAULT);
        assertFalse(shadowOf(s).isStoppedBySelf());
        assertEquals("a", s.host().state().currentItem().id);
        assertEquals(754_000, s.exoPlayer().getCurrentPosition(), 1_000);
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

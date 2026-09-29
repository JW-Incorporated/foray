package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.media.AudioManager;
import android.os.Looper;

import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNotificationManager;

/**
 * M5 (full-repo-review-report.md, 2026-08-31): real service lifecycle coverage for
 * {@link PlaybackKeepAliveService} — the piece neither
 * `tools/mobile/shell-invariants.test.mjs` (source-shape only) nor `android-build.yml`
 * (compiles the APK, never runs a line of it) ever executes. Robolectric's
 * {@link ServiceController} drives the REAL {@code onCreate}/{@code onStartCommand}/
 * {@code onDestroy} lifecycle methods against a shadow Android framework — this is
 * the class's actual `running`/`sessionOwner` bookkeeping under test, not a reading
 * of the source.
 *
 * <p>{@code @Config(sdk = 34)} — API 34 is the version whose behaviour this class's
 * own comments are most concerned with (mediaPlayback service type requirement,
 * runtime-dismissible notification, POST_NOTIFICATIONS gating).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class PlaybackKeepAliveServiceTest {

    private ServiceController<PlaybackKeepAliveService> controller;

    @After
    public void tearDownServiceAndHub() {
        if (controller != null) {
            try {
                controller.destroy();
            } catch (Exception ignored) {
                // Some tests destroy explicitly and assert on it; a double-destroy
                // here must not fail an otherwise-passing test.
            }
        }
        NowPlayingHub.reset();
    }

    @Test
    public void onCreate_buildsASessionAndClaimsOwnership() {
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        assertFalse("not running before onCreate", PlaybackKeepAliveService.isRunning());
        controller.create();
        // onCreate alone (no onStartCommand yet) builds the MediaSession but does not
        // call startForeground — see the class's own onCreate/startSession split.
        assertTrue("session should be built and owned by onCreate",
            PlaybackKeepAliveService.isSessionActive());
        assertFalse("running is set by onStartCommand, not onCreate",
            PlaybackKeepAliveService.isRunning());
    }

    @Test
    public void onStartCommand_startsForegroundAndSetsRunningTrue() {
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0);

        assertTrue("running must be true once onStartCommand's startForeground succeeds",
            PlaybackKeepAliveService.isRunning());

        // A real notification channel + notification were built and posted — the
        // exact mechanism `docs/android-native-code.md` describes and the thing a
        // source-shape check cannot see happen. `getAllNotifications()` avoids
        // depending on a tag/id overload shape that has shifted across Robolectric
        // releases.
        ShadowNotificationManager shadowNm = org.robolectric.Shadows.shadowOf(
            (android.app.NotificationManager) org.robolectric.RuntimeEnvironment.getApplication()
                .getSystemService(android.content.Context.NOTIFICATION_SERVICE));
        assertFalse("a playback notification should have been posted",
            shadowNm.getAllNotifications().isEmpty());
    }

    @Test
    public void onDestroy_clearsRunningAndReleasesSessionOwnership() {
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0);
        assertTrue(PlaybackKeepAliveService.isRunning());
        assertTrue(PlaybackKeepAliveService.isSessionActive());

        controller.destroy();

        assertFalse("running must go false on destroy", PlaybackKeepAliveService.isRunning());
        assertFalse("this instance must release session ownership on destroy",
            PlaybackKeepAliveService.isSessionActive());
    }

    @Test
    public void transportIntentAction_isDispatchedToTheHubBeforeForegroundStarts() {
        // This is the "REPORT lock screen presses back to the page" half of #27,
        // and it is handled inside onStartCommand BEFORE startForeground — see the
        // class's own comment on why ordering matters here.
        java.util.concurrent.atomic.AtomicReference<String> seenAction =
            new java.util.concurrent.atomic.AtomicReference<>();
        NowPlayingHub.setSink((action, positionMs, offsetMs) -> seenAction.set(action));

        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();

        Intent transportIntent = new Intent(
                org.robolectric.RuntimeEnvironment.getApplication(), PlaybackKeepAliveService.class)
            .setAction("ai.jwlabs.foura.audio.TRANSPORT")
            .putExtra("action", "pause");
        // Robolectric 4.14.1 (pinned in build.gradle) does not have the
        // startCommand(Intent, int, int) overload added in later releases —
        // withIntent(...).startCommand(flags, startId) is the version-portable
        // way to deliver a specific Intent into onStartCommand.
        controller.withIntent(transportIntent).startCommand(0, 0);

        assertEquals("pause", seenAction.get());
    }

    @Test
    public void bareStartWithNoTransportAction_dispatchesNothing() {
        java.util.concurrent.atomic.AtomicReference<String> seenAction =
            new java.util.concurrent.atomic.AtomicReference<>();
        NowPlayingHub.setSink((action, positionMs, offsetMs) -> seenAction.set(action));

        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0); // no ACTION_TRANSPORT intent

        assertEquals(null, seenAction.get());
        // A bare start (e.g. from ForayAudioPlugin#start) must still bring the
        // service to a running foreground state.
        assertTrue(PlaybackKeepAliveService.isRunning());
    }

    @Test
    public void restartAfterDestroy_reclaimsSessionOwnership() {
        // Exercises the overlap the class's `sessionOwner` javadoc warns about: a
        // second instance's onCreate can run before the first's onDestroy. Here we
        // do them in strict sequence and confirm ownership transfers cleanly, which
        // is the simpler, deterministic half of that guarantee that a JVM test can
        // actually pin.
        ServiceController<PlaybackKeepAliveService> first =
            Robolectric.buildService(PlaybackKeepAliveService.class);
        first.create();
        first.startCommand(0, 0);
        assertTrue(PlaybackKeepAliveService.isRunning());

        first.destroy();
        assertFalse(PlaybackKeepAliveService.isRunning());

        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0);
        assertTrue("a fresh instance must be able to start after the previous one tore down",
            PlaybackKeepAliveService.isRunning());
        assertTrue(PlaybackKeepAliveService.isSessionActive());
    }

    /* ---- audit round 2 (native-7, native-8): the two pure rules ---- */

    @Test
    public void aTransportPressOnARunningServiceDoesNotRepostTheNotification() {
        // native-8: a press used to re-post the pre-press notification through
        // startForeground, and a swipe on Android 14+ put it straight back.
        // MUTATION: return true unconditionally.
        assertTrue("a bare start always starts foreground",
            PlaybackKeepAliveService.foregroundStartNeeded(false, false));
        assertTrue("the first transport intent, before any start, still starts foreground",
            PlaybackKeepAliveService.foregroundStartNeeded(false, true));
        assertTrue("a bare start on a running service re-asserts foreground (ForayAudioPlugin#start)",
            PlaybackKeepAliveService.foregroundStartNeeded(true, false));
        assertFalse("a press on a running service dispatches and returns",
            PlaybackKeepAliveService.foregroundStartNeeded(true, true));
    }

    @Test
    public void compactViewShowsTheSeekPairForASingleEpisodeAndTheTrackPairForAForay() {
        // native-7: with nothing queued the lock screen showed play/pause and Stop
        // only. MUTATION: ignore hasNext and always pick prev/next.
        assertEquals("[3, 1, 4]", java.util.Arrays.toString(
            PlaybackKeepAliveService.compactActions(0, 1, 2, 3, 4, false)));
        assertEquals("[0, 1, 2]", java.util.Arrays.toString(
            PlaybackKeepAliveService.compactActions(0, 1, 2, 3, 4, true)));
        assertEquals("a missing slot is skipped, not drawn as -1", "[1, 4]", java.util.Arrays.toString(
            PlaybackKeepAliveService.compactActions(-1, 1, -1, -1, 4, false)));
    }

    /* ---- A-08: pause on headphone unplug / Bluetooth loss ---- */

    /** Every session event the service sent the page, as "kind/reason". */
    private static java.util.List<String> captureSessionEvents() {
        java.util.List<String> seen = new java.util.ArrayList<>();
        NowPlayingHub.setSessionSink((kind, reason) -> seen.add(kind + "/" + reason));
        return seen;
    }

    /** What the system sends when the output is about to become the loudspeaker.
     *  `adb shell am broadcast` cannot send it (a protected broadcast), which is why
     *  this suite is the only automated cover the receiver has. */
    private static void becomeNoisy() {
        RuntimeEnvironment.getApplication().sendBroadcast(new Intent(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

    @Test
    public void becomingNoisyWhileRunning_tellsThePageTheOldDeviceIsGone() {
        // MUTATION: drop `registerNoisyReceiver()` from onStartCommand, or dispatch
        // any other kind/reason -- client.js's onNativeSession matches exactly
        // routeChange/old-device-gone, and anything else plays on from the speaker.
        java.util.List<String> seen = captureSessionEvents();
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0);
        assertTrue("registered once the service is foreground",
            controller.get().isNoisyReceiverRegistered());

        becomeNoisy();

        assertEquals(java.util.Collections.singletonList("routeChange/old-device-gone"), seen);
    }

    @Test
    public void becomingNoisyBeforeAnyStart_isNotHeard() {
        // The broadcast means nothing with no Foray loaded; onCreate alone builds the
        // session but is not "running". MUTATION: register from onCreate.
        java.util.List<String> seen = captureSessionEvents();
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        becomeNoisy();
        assertTrue("nothing reaches the page before the service is running", seen.isEmpty());
    }

    @Test
    public void becomingNoisyAfterDestroy_isNotHeard() {
        // MUTATION: drop `unregisterNoisyReceiver()` from onDestroy -- a stopped
        // Foray would then be "paused" by every later unplug, and the receiver leaks.
        java.util.List<String> seen = captureSessionEvents();
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0);
        PlaybackKeepAliveService service = controller.get();
        controller.destroy();
        controller = null;
        assertFalse(service.isNoisyReceiverRegistered());
        becomeNoisy();
        assertTrue("an unregistered receiver hears nothing", seen.isEmpty());
    }

    @Test
    public void aSecondBareStart_doesNotDeliverAnUnplugTwice() {
        // ForayAudioPlugin#start re-asserts foreground on a running service.
        // MUTATION: drop the `noisyReceiver != null` guard -- two receivers, two
        // pauses, and a second `routeChanged` on the record for one unplug.
        java.util.List<String> seen = captureSessionEvents();
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0);
        controller.startCommand(0, 1);
        becomeNoisy();
        assertEquals(1, seen.size());
    }

    @Test
    public void anotherAudioBroadcastIsNotMistakenForAnUnplug() {
        // The receiver filters on the action: a headset PLUGGED IN is not a loss.
        java.util.List<String> seen = captureSessionEvents();
        controller = Robolectric.buildService(PlaybackKeepAliveService.class);
        controller.create();
        controller.startCommand(0, 0);
        RuntimeEnvironment.getApplication().sendBroadcast(new Intent(AudioManager.ACTION_HEADSET_PLUG));
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue(seen.isEmpty());
    }
}

package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Application;
import android.app.ForegroundServiceStartNotAllowedException;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.AudioDeviceInfoBuilder;
import org.robolectric.shadows.ShadowAudioManager;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A-09: each of {@link SessionMonitor}'s emitters, driven through the platform door it
 * listens on wherever Robolectric has one (Activity lifecycle, {@code onTrimMemory},
 * {@code AudioDeviceCallback}, {@code AudioPlaybackCallback}, the becoming-noisy
 * broadcast), and through its package-visible method where Robolectric cannot build
 * the input (two distinct audio devices -- its builder gives every device id 0, and
 * the shadow's device list then treats them as one).
 *
 * <p>The vocabulary (every kind in SESSION_KINDS, every reason a record token, every
 * port in SESSION_PORTS, client.js never acting on an inference) is
 * {@code shell-invariants.test.mjs}'s, which can read both languages.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class SessionMonitorTest {

    /** Every row the monitor sent the page, as "kind/reason", with its facts beside. */
    private final List<String> rows = new ArrayList<>();
    private final List<Map<String, Object>> facts = new ArrayList<>();

    @Before
    public void capture() {
        SessionMonitor.resetForTest();
        NowPlayingHub.reset();
        NowPlayingHub.setSessionSink(new NowPlayingHub.SessionSink() {
            @Override
            public void onSession(@NonNull String kind, @NonNull String reason) {
                onSession(kind, reason, Collections.emptyMap());
            }

            @Override
            public void onSession(@NonNull String kind, @NonNull String reason, @NonNull Map<String, Object> f) {
                rows.add(kind + "/" + reason);
                facts.add(new HashMap<>(f));
            }
        });
    }

    @After
    public void tearDown() {
        SessionMonitor.resetForTest();
        NowPlayingHub.reset();
    }

    private static Application app() {
        return RuntimeEnvironment.getApplication();
    }

    private static ShadowAudioManager audio() {
        return Shadows.shadowOf((AudioManager) app().getSystemService(Context.AUDIO_SERVICE));
    }

    private static AudioDeviceInfo device(int type) {
        return AudioDeviceInfoBuilder.newBuilder().setType(type).build();
    }

    private static AudioAttributes usage(int usage) {
        return new AudioAttributes.Builder().setUsage(usage).build();
    }

    private static void page(String state) throws Exception {
        NowPlayingHub.set(NowPlaying.from(new JSObject("{\"state\":\"" + state + "\",\"title\":\"Episode 1\"}")));
    }

    private static void advance(long ms) {
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms));
    }

    private SessionMonitor installWithSpeaker() {
        audio().setOutputDevices(Collections.singletonList(device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)));
        SessionMonitor monitor = SessionMonitor.install(app());
        assertNotNull(monitor);
        return monitor;
    }

    /* ---- install and state() ---- */

    @Test
    public void stateAnswersUnknownBeforeInstall_andTheRouteAfter_andInstallIsOnce() {
        // MUTATION: build a second monitor per plugin load -- every row twice after a
        // rotation.
        assertEquals("unknown", SessionMonitor.focusState());
        assertEquals("unknown", SessionMonitor.route());
        SessionMonitor monitor = installWithSpeaker();
        assertSame(monitor, SessionMonitor.install(app()));
        assertEquals("speaker", SessionMonitor.route());
        assertTrue("the registration's report of devices already present is not a change", rows.isEmpty());
    }

    /* ---- background / foreground ---- */

    @Test
    public void theLastActivityStopping_isBackground_andStartingAgain_isForeground_butALaunchIsNeither() {
        // MUTATION: emit foreground on the first start -> every cold launch reads as a
        // return; drop the backgrounded guard -> a second stop writes a second row.
        installWithSpeaker();
        ActivityController<Activity> activity = Robolectric.buildActivity(Activity.class).setup();
        assertTrue("a launch is not a return from the background", rows.isEmpty());

        activity.pause().stop();
        assertEquals(Collections.singletonList("background/did-enter"), rows);

        activity.restart().start().resume();
        assertEquals(List.of("background/did-enter", "foreground/will-enter"), rows);
    }

    @Test
    public void aRotationIsNotATripToTheBackground() {
        // MUTATION: ignore isChangingConfigurations -> a background/foreground pair on
        // every turn of the phone, and a flush plus a reconcile in client.js with it.
        SessionMonitor monitor = installWithSpeaker();
        monitor.onActivityStarted();
        monitor.onActivityStopped(true);
        monitor.onActivityStarted();
        assertTrue(rows.isEmpty());
        monitor.onActivityStopped(false);
        assertEquals(Collections.singletonList("background/did-enter"), rows);
    }

    /* ---- onTrimMemory ---- */

    @Test
    public void trimMemory_isAMemoryWarningNamedByLevel_withTheHeadroom() {
        // MUTATION: drop the registration, or report UI_HIDDEN (every background).
        ActivityManager am = (ActivityManager) app().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        info.availMem = 96L * 1024L * 1024L;
        Shadows.shadowOf(am).setMemoryInfo(info);
        installWithSpeaker();

        app().onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN);
        assertTrue("UI_HIDDEN is the background row's news, not pressure", rows.isEmpty());

        app().onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL);
        assertEquals(Collections.singletonList("memoryWarning/running-critical"), rows);
        assertEquals(96L, facts.get(0).get("availMb"));

        assertEquals("level-7", SessionMonitor.trimLevelToken(7));
        assertEquals("complete", SessionMonitor.trimLevelToken(ComponentCallbacks2.TRIM_MEMORY_COMPLETE));
    }

    /* ---- routes ---- */

    @Test
    public void aRemovedOutput_throughTheRegisteredCallback_isARouteChangeWithPorts() {
        // MUTATION: drop registerAudioDeviceCallback -> no row; spell the reason
        // old-device-gone -> client.js pauses for a device that may not be playing.
        AudioDeviceInfo speaker = device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
        audio().setOutputDevices(Collections.singletonList(speaker));
        SessionMonitor.install(app());
        audio().removeOutputDevice(speaker, true);
        assertEquals(Collections.singletonList("routeChange/device-removed"), rows);
        assertEquals("speaker", facts.get(0).get("from"));
        assertEquals("none", facts.get(0).get("to"));
        assertEquals("none", SessionMonitor.route());
    }

    @Test
    public void aHeadsetArriving_movesTheRoute_andLeaving_movesItBack_andAMicrophoneIsNotARoute() {
        SessionMonitor monitor = installWithSpeaker();
        AudioDeviceInfo a2dp = device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP);

        monitor.onDevices(new AudioDeviceInfo[] { a2dp }, true);
        assertEquals(Collections.singletonList("routeChange/new-device"), rows);
        assertEquals("speaker", facts.get(0).get("from"));
        assertEquals("a2dp", facts.get(0).get("to"));
        assertEquals("a2dp", SessionMonitor.route());

        monitor.onDevices(new AudioDeviceInfo[] { a2dp }, true);
        assertEquals("a device already held is not a second arrival", 1, rows.size());

        monitor.onDevices(new AudioDeviceInfo[] {
            device(AudioDeviceInfo.TYPE_BUILTIN_MIC), device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO),
        }, true);
        assertEquals("a mic and the call-only half of a headset are not where a Foray plays", 1, rows.size());

        monitor.onDevices(new AudioDeviceInfo[] { a2dp }, false);
        assertEquals("routeChange/device-removed", rows.get(1));
        assertEquals("a2dp", facts.get(1).get("from"));
        assertEquals("speaker", facts.get(1).get("to"));
    }

    @Test
    public void portTokens_areTypesNeverNames() {
        assertEquals("wired", SessionMonitor.RouteTracker.portToken(AudioDeviceInfo.TYPE_WIRED_HEADPHONES));
        assertEquals("ble", SessionMonitor.RouteTracker.portToken(AudioDeviceInfo.TYPE_BLE_HEADSET));
        assertEquals("usb", SessionMonitor.RouteTracker.portToken(AudioDeviceInfo.TYPE_USB_HEADSET));
        assertEquals("hdmi", SessionMonitor.RouteTracker.portToken(AudioDeviceInfo.TYPE_HDMI));
        assertEquals("other", SessionMonitor.RouteTracker.portToken(AudioDeviceInfo.TYPE_HEARING_AID));
        SessionMonitor.RouteTracker tracker = new SessionMonitor.RouteTracker();
        assertEquals("none", tracker.route());
        tracker.add(AudioDeviceInfo.TYPE_WIRED_HEADSET, 7);
        tracker.add(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, 2);
        assertEquals("the speaker never outranks an attached device", "wired", tracker.route());
        tracker.add(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, 9);
        assertEquals("the last attached wins", "a2dp", tracker.route());
    }

    @Test
    public void becomingNoisy_carriesThePortItWasLostFrom() throws Exception {
        // A-08's row, with A-09's fact. MUTATION: dispatch without lostRouteFacts().
        SessionMonitor monitor = installWithSpeaker();
        monitor.onDevices(new AudioDeviceInfo[] { device(AudioDeviceInfo.TYPE_WIRED_HEADPHONES) }, true);
        rows.clear();
        facts.clear();
        ServiceController<PlaybackKeepAliveService> service = Robolectric.buildService(PlaybackKeepAliveService.class);
        service.create();
        service.startCommand(0, 0);
        app().sendBroadcast(new Intent(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        service.destroy();
        assertEquals(Collections.singletonList("routeChange/old-device-gone"), rows);
        assertEquals("wired", facts.get(0).get("from"));
    }

    /* ---- inferred focus ---- */

    @Test
    public void aRingtoneStartingAsOurAudioStops_isAnInferredLoss_andOurAudioBack_isTheReturn() throws Exception {
        // Through the registered AudioPlaybackCallback. MUTATION: drop the
        // registration -> no row; emit interruptionBegan instead -> client.js would
        // reconcile the player on a guess (and shell-invariants goes red).
        SessionMonitor.install(app());
        page("playing");
        audio().setActivePlaybackConfigurationsFor(List.of(usage(AudioAttributes.USAGE_MEDIA)), true);
        assertEquals("held", SessionMonitor.focusState());
        assertTrue(rows.isEmpty());

        audio().setActivePlaybackConfigurationsFor(List.of(usage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)), true);
        assertEquals(Collections.singletonList("focusChange/lost-inferred"), rows);
        assertEquals(Boolean.TRUE, facts.get(0).get("other"));
        assertEquals("lost", SessionMonitor.focusState());

        advance(5_000);
        audio().setActivePlaybackConfigurationsFor(List.of(usage(AudioAttributes.USAGE_MEDIA)), true);
        assertEquals("focusChange/regained-inferred", rows.get(1));
        assertEquals(5_000L, facts.get(1).get("durMs"));
        assertEquals("held", SessionMonitor.focusState());
    }

    @Test
    public void aPause_aSeam_andAnUnheardStart_areNotLosses() {
        // The false positives the inference is built to refuse. MUTATION: infer a loss
        // from silence alone -> every hidden seam (9-11 s) is a "loss".
        SessionMonitor.FocusInference f = new SessionMonitor.FocusInference();
        int none = SessionMonitor.FocusInference.NONE;

        // Nothing heard yet under the page: a slow first load beside a notification.
        assertEquals(none, f.onConfigs(0, true, true, true, 0L));

        // Heard, then a seam's silence with nobody else sounding, for 10 s.
        assertEquals(none, f.onConfigs(1, false, true, true, 1_000L));
        assertEquals(none, f.onConfigs(0, false, true, true, 2_000L));
        assertEquals("a notification long after the silence began is not a takeover",
            none, f.onConfigs(0, true, true, true, 12_000L));
        assertEquals(none, f.onConfigs(1, false, true, true, 13_000L));

        // The listener paused first, then something else played.
        assertEquals(none, f.onConfigs(0, false, false, true, 20_000L));
        assertEquals(none, f.onConfigs(0, true, false, true, 20_500L));
        assertEquals("idle", f.state(false));
    }

    @Test
    public void aTakeoverJustAfterOurSilence_isStillALoss_andAnotherAppsMediaIsNotOurReturn() {
        SessionMonitor.FocusInference f = new SessionMonitor.FocusInference();
        assertEquals("unknown", f.state(true));
        f.onConfigs(1, false, true, true, 0L);
        // Ours stops first, the ringtone starts 800 ms later (the order focus gives).
        assertEquals(SessionMonitor.FocusInference.NONE, f.onConfigs(0, false, true, true, 1_000L));
        assertEquals(SessionMonitor.FocusInference.LOST, f.onConfigs(0, true, true, true, 1_800L));
        // The page has since seen the pause; another app's media plays: not ours.
        assertEquals(SessionMonitor.FocusInference.NONE, f.onConfigs(1, false, false, true, 30_000L));
        assertEquals("lost", f.state(false));
        // The listener presses play.
        assertEquals(SessionMonitor.FocusInference.REGAINED, f.onConfigs(1, false, true, true, 60_000L));
        assertEquals(58_200L, f.lastLostMs());
        // Closing the Foray forgets everything.
        f.onConfigs(0, true, false, true, 61_000L);
        f.onConfigs(0, false, false, false, 62_000L);
        assertEquals(SessionMonitor.FocusInference.NONE, f.onConfigs(0, true, true, true, 63_000L));
    }

    @Test
    public void usagesThatAreOurKind_andThoseThatAreSomebodyElse() {
        assertTrue(SessionMonitor.FocusInference.isMediaUsage(AudioAttributes.USAGE_MEDIA));
        assertTrue(SessionMonitor.FocusInference.isMediaUsage(AudioAttributes.USAGE_UNKNOWN));
        assertFalse(SessionMonitor.FocusInference.isMediaUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION));
        assertFalse(SessionMonitor.FocusInference.isMediaUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE));
        assertFalse(SessionMonitor.FocusInference.isMediaUsage(AudioAttributes.USAGE_ASSISTANT));
    }

    /* ---- foreground-service refusals ---- */

    /** A name past dataTokenOf's 48 characters once dashed. */
    static final class AnExceptionWhoseNameKeepsGoingWellPastTheRecordLimitException extends RuntimeException { }

    @Test
    public void aRefusedForegroundService_isARowNamingTheExceptionClass_inTheAppStateItHappened() {
        // MUTATION: put e.getMessage() in the reason -> prose (and a component name)
        // in the record; drop the call from either catch -> shell-invariants red.
        SessionMonitor monitor = installWithSpeaker();
        monitor.onActivityStarted();
        monitor.onActivityStopped(false);
        rows.clear();
        facts.clear();

        SessionMonitor.foregroundRefused(new ForegroundServiceStartNotAllowedException("startForegroundService() not allowed"));
        assertEquals(Collections.singletonList("sessionActivated/refused-foreground-service-start-not-allowed"), rows);
        assertEquals("bg", facts.get(0).get("app"));

        assertEquals("refused-security", SessionMonitor.refusalReason(new SecurityException("x")));
        assertEquals("refused-illegal-state", SessionMonitor.refusalReason(new IllegalStateException()));
        assertEquals("refused", SessionMonitor.refusalReason(null));
        String longOne = SessionMonitor.refusalReason(new AnExceptionWhoseNameKeepsGoingWellPastTheRecordLimitException());
        assertTrue(longOne, longOne.matches("^[a-z][a-z0-9-]{0,47}$") && !longOne.endsWith("-"));
    }

    @Test
    public void aRefusalBeforeInstall_stillReachesThePage_withoutAnAppState() {
        SessionMonitor.foregroundRefused(new SecurityException("x"));
        assertEquals(Collections.singletonList("sessionActivated/refused-security"), rows);
        assertFalse(facts.get(0).containsKey("app"));
    }
}

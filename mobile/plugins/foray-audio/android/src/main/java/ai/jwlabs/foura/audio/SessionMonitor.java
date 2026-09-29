package ai.jwlabs.foura.audio;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Application;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A-09: the system events an {@code <audio>} element cannot report, raised as the
 * plugin's {@code SESSION_EVENT} so {@code player/diagnostic-log.js} can put the cause
 * of a stop one line above the stop.
 *
 * <h2>Why</h2>
 *
 * The iOS plugin observes {@code AVAudioSession} and {@code UIApplication} and writes
 * one {@code session} row per interruption, route change, background, foreground and
 * memory warning. Until A-08 the Android plugin wrote none, so an Android record's
 * {@code stop element pausedUnexpectedly} had nothing above it that could say why
 * (docs/plans/android-assessment.md: "Diagnostics cannot explain an Android stop").
 * These are the Android doors into the same rows, in the same vocabulary:
 *
 * <ul>
 *   <li><b>background / foreground</b> ({@code did-enter} / {@code will-enter}, the
 *       iOS words) from Activity callbacks. A configuration change (rotation) is not
 *       a trip to the background, and a cold launch is not a return from one.</li>
 *   <li><b>routeChange</b> from an {@link AudioDeviceCallback}: {@code new-device} (the
 *       iOS word) and {@code device-removed}, with {@code from}/{@code to} port tokens.
 *       NOT {@code old-device-gone}: that pair makes {@code client.js} pause, and a
 *       removed device is not always the one playing. The pause is A-08's
 *       {@code ACTION_AUDIO_BECOMING_NOISY}, the platform's own "the output was lost"
 *       signal, which now carries the {@code from} port as well.</li>
 *   <li><b>focusChange</b> ({@code lost-inferred} / {@code regained-inferred}) from an
 *       {@link AudioManager.AudioPlaybackCallback}. See {@link FocusInference}: it is
 *       an inference, it says so in its reason, and {@code client.js} never acts on
 *       it.</li>
 *   <li><b>memoryWarning</b> from {@code onTrimMemory}, with the level as the reason
 *       and {@code availMb}.</li>
 *   <li><b>sessionActivated</b> with a {@code refused-*} reason naming the exception
 *       class, when Android refuses the foreground service -- the Android analogue of
 *       an iOS hold that failed, and the one refusal that explains a background stop
 *       on Android 12+.</li>
 * </ul>
 *
 * <h2>Closed vocabulary only</h2>
 *
 * Every fact is a token from the sets {@code diagnostic-log.js} admits
 * ({@code SESSION_PORTS}, {@code SESSION_APP_STATES}), a number or a boolean. A
 * device's NAME never leaves this class: a Bluetooth car is named after the person
 * who owns it, and the record is pasted into issues.
 *
 * <h2>Lifetime and threads</h2>
 *
 * Process-wide and installed once, from {@link ForayAudioPlugin#load()}, on the
 * application context -- an Activity recreation builds a second plugin and must not
 * build a second set of observers. Every callback is delivered on the main looper;
 * {@link #focusState()} and {@link #route()} are read from the bridge's worker pool,
 * which is why the two answers are volatile or synchronised. Every row goes out
 * through {@link NowPlayingHub#dispatchSession(String, String, Map)}, which drops it
 * when no page is listening and contains a sink that throws.
 */
final class SessionMonitor {

    private static final String TAG = "ForayAudio";

    /* The kinds, each one in diagnostic-log.js's SESSION_KINDS (a row whose kind is not
       there is dropped and counted, never stored). */
    static final String KIND_BACKGROUND = "background";
    static final String KIND_FOREGROUND = "foreground";
    static final String KIND_ROUTE_CHANGE = "routeChange";
    static final String KIND_FOCUS_CHANGE = "focusChange";
    static final String KIND_MEMORY_WARNING = "memoryWarning";
    static final String KIND_SESSION_ACTIVATED = "sessionActivated";

    /* The reasons: dataTokenOf's shape, /^[a-z][a-z0-9-]{0,47}$/. */
    static final String REASON_DID_ENTER = "did-enter";
    static final String REASON_WILL_ENTER = "will-enter";
    static final String REASON_NEW_DEVICE = "new-device";
    static final String REASON_DEVICE_REMOVED = "device-removed";
    static final String REASON_FOCUS_LOST = "lost-inferred";
    static final String REASON_FOCUS_REGAINED = "regained-inferred";

    /** SESSION_APP_STATES. */
    static final String APP_ACTIVE = "active";
    static final String APP_BACKGROUND = "bg";

    /** {@code state()}'s {@code focusState} words. */
    static final String FOCUS_UNKNOWN = "unknown";
    static final String FOCUS_HELD = "held";
    static final String FOCUS_LOST = "lost";
    static final String FOCUS_IDLE = "idle";

    /** SESSION_PORTS' "no output at all"; {@code state()} answers "unknown" before the
     *  monitor is installed, which is a different fact. */
    static final String PORT_NONE = "none";
    static final String PORT_SPEAKER = "speaker";
    static final String ROUTE_UNKNOWN = "unknown";

    @Nullable private static volatile SessionMonitor installed = null;

    private final Application app;
    @Nullable private final AudioManager audio;
    private final RouteTracker routes = new RouteTracker();
    private final FocusInference focus = new FocusInference();

    /** Main thread only. */
    private int startedActivities = 0;
    /** Main thread only. True between a background row and the foreground row that
     *  answers it; false at launch, so a cold start writes no "foreground". */
    private boolean backgrounded = false;
    /** SESSION_APP_STATES, or null until the first Activity callback says. */
    @Nullable private volatile String appState = null;
    private volatile String route = PORT_NONE;

    @Nullable private Application.ActivityLifecycleCallbacks lifecycle;
    @Nullable private ComponentCallbacks2 memory;
    @Nullable private AudioDeviceCallback devices;
    /** An {@code AudioManager.AudioPlaybackCallback} on API 26+, held as Object so this
     *  class verifies on API 24-25, where that type does not exist. */
    @Nullable private Object playback;

    private SessionMonitor(@NonNull Application app) {
        this.app = app;
        AudioManager am = null;
        try {
            am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        } catch (Exception e) {
            Log.w(TAG, "no AudioManager; routes and focus will not be reported", e);
        }
        this.audio = am;
    }

    /**
     * Install the observers once per process. Safe to call from every plugin
     * {@code load()}; the second call returns the first monitor. Each observer is
     * registered in its own try: a platform that refuses one must cost that row, not
     * the plugin's load.
     */
    @MainThread
    @Nullable
    static synchronized SessionMonitor install(@Nullable Context context) {
        SessionMonitor existing = installed;
        if (existing != null) return existing;
        if (context == null) return null;
        Context appContext = context.getApplicationContext();
        if (!(appContext instanceof Application)) {
            Log.w(TAG, "no Application context; session events will not be reported");
            return null;
        }
        SessionMonitor monitor = new SessionMonitor((Application) appContext);
        monitor.start();
        installed = monitor;
        return monitor;
    }

    /** For the JUnit suites: unregister everything and forget the monitor. */
    static synchronized void resetForTest() {
        SessionMonitor monitor = installed;
        installed = null;
        if (monitor != null) monitor.stop();
    }

    @Nullable
    static SessionMonitor current() {
        return installed;
    }

    private void start() {
        try {
            lifecycle = new Lifecycle();
            app.registerActivityLifecycleCallbacks(lifecycle);
        } catch (Exception e) {
            lifecycle = null;
            Log.w(TAG, "could not observe the Activity lifecycle", e);
        }
        try {
            memory = new Memory();
            app.registerComponentCallbacks(memory);
        } catch (Exception e) {
            memory = null;
            Log.w(TAG, "could not observe onTrimMemory", e);
        }
        if (audio != null) {
            try {
                /* SEEDED BEFORE REGISTERING: the platform answers a registration with an
                   onAudioDevicesAdded for every device already present, and those are
                   not new devices. The tracker already knows them, so they add nothing
                   and write no row. */
                for (AudioDeviceInfo d : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    if (d != null && isOutput(d)) routes.add(d.getType(), d.getId());
                }
                route = routes.route();
                devices = new AudioDeviceCallback() {
                    @Override
                    public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                        onDevices(added, true);
                    }

                    @Override
                    public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                        onDevices(removed, false);
                    }
                };
                audio.registerAudioDeviceCallback(devices, new Handler(Looper.getMainLooper()));
            } catch (Exception e) {
                devices = null;
                Log.w(TAG, "could not observe audio devices", e);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startPlaybackObserver();
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private void startPlaybackObserver() {
        try {
            AudioManager.AudioPlaybackCallback callback = new AudioManager.AudioPlaybackCallback() {
                @Override
                public void onPlaybackConfigChanged(List<AudioPlaybackConfiguration> configs) {
                    onPlaybackConfigs(configs);
                }
            };
            /* Seeded, so `state()` answers from the first call rather than "unknown"
               until something changes. A seed can say `held`; it never writes a row. */
            onPlaybackConfigs(audio.getActivePlaybackConfigurations(), false);
            audio.registerAudioPlaybackCallback(callback, new Handler(Looper.getMainLooper()));
            playback = callback;
        } catch (Exception e) {
            playback = null;
            Log.w(TAG, "could not observe audio playback; focus will not be inferred", e);
        }
    }

    private void stop() {
        try {
            if (lifecycle != null) app.unregisterActivityLifecycleCallbacks(lifecycle);
        } catch (Exception ignored) { /* best effort */ }
        try {
            if (memory != null) app.unregisterComponentCallbacks(memory);
        } catch (Exception ignored) { /* best effort */ }
        try {
            if (audio != null && devices != null) audio.unregisterAudioDeviceCallback(devices);
        } catch (Exception ignored) { /* best effort */ }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audio != null && playback != null) {
            try {
                audio.unregisterAudioPlaybackCallback((AudioManager.AudioPlaybackCallback) playback);
            } catch (Exception ignored) { /* best effort */ }
        }
        lifecycle = null;
        memory = null;
        devices = null;
        playback = null;
    }

    /* ------------------------------------------------------------------ */
    /* What state() reports                                                */
    /* ------------------------------------------------------------------ */

    /** {@code state()}'s {@code focusState}: see {@link FocusInference#state}. */
    @NonNull
    static String focusState() {
        SessionMonitor m = installed;
        if (m == null) return FOCUS_UNKNOWN;
        return m.focus.state(NowPlayingHub.get().state == NowPlaying.PLAYING);
    }

    /** {@code state()}'s {@code route}: a SESSION_PORTS token, or "unknown" before the
     *  monitor is installed. */
    @NonNull
    static String route() {
        SessionMonitor m = installed;
        return m == null ? ROUTE_UNKNOWN : m.route;
    }

    /** A-08's becoming-noisy row, with the port it was lost from. Empty when nothing
     *  is installed, so the row keeps A-08's shape. */
    @NonNull
    static Map<String, Object> lostRouteFacts() {
        SessionMonitor m = installed;
        if (m == null) return Collections.emptyMap();
        Map<String, Object> facts = new LinkedHashMap<>();
        facts.put("from", m.route);
        return facts;
    }

    /* ------------------------------------------------------------------ */
    /* The emitters                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Android refused the foreground service. Called from the plugin's {@code start}
     * (the {@code startForegroundService} refusal, on the bridge's worker pool) and from
     * the service's {@code onStartCommand} ({@code startForeground}'s, on main). Works
     * without an installed monitor; the {@code app} fact is then left off.
     */
    static void foregroundRefused(@Nullable Throwable error) {
        Map<String, Object> facts = new LinkedHashMap<>();
        SessionMonitor m = installed;
        String app = m == null ? null : m.appState;
        if (app != null) facts.put("app", app);
        NowPlayingHub.dispatchSession(KIND_SESSION_ACTIVATED, refusalReason(error), facts);
    }

    /**
     * {@code ForegroundServiceStartNotAllowedException} ->
     * {@code refused-foreground-service-start-not-allowed}: the exception's CLASS as a
     * dashed token (never its message, which is prose and can name a component), capped
     * at dataTokenOf's 48 characters. Pure, for the suite.
     */
    @NonNull
    static String refusalReason(@Nullable Throwable error) {
        String name = error == null ? "" : error.getClass().getSimpleName();
        if (name.endsWith("Exception") && name.length() > "Exception".length()) {
            name = name.substring(0, name.length() - "Exception".length());
        }
        String dashed = name
            .replaceAll("([a-z0-9])([A-Z])", "$1-$2")
            .replaceAll("([A-Z]+)([A-Z][a-z])", "$1-$2")
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("^-+|-+$", "");
        String token = dashed.isEmpty() ? "refused" : "refused-" + dashed;
        if (token.length() > 48) token = token.substring(0, 48).replaceAll("-+$", "");
        return token;
    }

    /** An Activity came to the front. Package-visible for the suite. */
    @MainThread
    void onActivityStarted() {
        startedActivities++;
        appState = APP_ACTIVE;
        if (startedActivities == 1 && backgrounded) {
            backgrounded = false;
            emit(KIND_FOREGROUND, REASON_WILL_ENTER, Collections.emptyMap());
        }
    }

    /**
     * An Activity stopped. The LAST one stopping is the app going to the background --
     * unless it stopped to be rebuilt ({@code isChangingConfigurations}: a rotation, a
     * dark-mode switch), which is not a trip anywhere and would otherwise write a
     * background/foreground pair on every turn of the phone.
     */
    @MainThread
    void onActivityStopped(boolean changingConfigurations) {
        if (startedActivities > 0) startedActivities--;
        if (startedActivities > 0 || changingConfigurations || backgrounded) return;
        backgrounded = true;
        appState = APP_BACKGROUND;
        emit(KIND_BACKGROUND, REASON_DID_ENTER, Collections.emptyMap());
    }

    /**
     * {@code onTrimMemory}: the level is the reason. {@code TRIM_MEMORY_UI_HIDDEN} is
     * skipped -- it is not pressure, it is every trip to the background, and the
     * background row already says that.
     */
    @MainThread
    void onTrimMemory(int level) {
        if (level == ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) return;
        Map<String, Object> facts = new LinkedHashMap<>();
        Long availMb = availMb();
        if (availMb != null) facts.put("availMb", availMb);
        String app = appState;
        if (app != null) facts.put("app", app);
        emit(KIND_MEMORY_WARNING, trimLevelToken(level), facts);
    }

    @NonNull
    static String trimLevelToken(int level) {
        switch (level) {
            case ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE: return "running-moderate";
            case ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW: return "running-low";
            case ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL: return "running-critical";
            case ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN: return "ui-hidden";
            case ComponentCallbacks2.TRIM_MEMORY_BACKGROUND: return "background";
            case ComponentCallbacks2.TRIM_MEMORY_MODERATE: return "moderate";
            case ComponentCallbacks2.TRIM_MEMORY_COMPLETE: return "complete";
            default: return "level-" + Math.max(0, level);
        }
    }

    @Nullable
    private Long availMb() {
        try {
            ActivityManager am = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return null;
            ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(info);
            return Math.max(0L, info.availMem / (1024L * 1024L));
        } catch (Exception e) {
            return null;
        }
    }

    /** Devices came or went. One row per callback, and only when a MEDIA output
     *  changed: a microphone, the earpiece or the call-only half of a Bluetooth
     *  headset is not where a Foray plays. Package-visible for the suite. */
    @MainThread
    void onDevices(@Nullable AudioDeviceInfo[] changed, boolean added) {
        if (changed == null) return;
        String from = routes.route();
        boolean moved = false;
        for (AudioDeviceInfo d : changed) {
            if (d == null || !isOutput(d)) continue;
            moved |= added ? routes.add(d.getType(), d.getId()) : routes.remove(d.getType(), d.getId());
        }
        route = routes.route();
        if (!moved) return;
        Map<String, Object> facts = new LinkedHashMap<>();
        facts.put("from", from);
        facts.put("to", route);
        emit(KIND_ROUTE_CHANGE, added ? REASON_NEW_DEVICE : REASON_DEVICE_REMOVED, facts);
    }

    /** A sink, or a device whose role the platform did not say (Robolectric's). A
     *  source (a microphone) is never an output. */
    private static boolean isOutput(@NonNull AudioDeviceInfo d) {
        return d.isSink() || !d.isSource();
    }

    @RequiresApi(Build.VERSION_CODES.O)
    @MainThread
    void onPlaybackConfigs(@Nullable List<AudioPlaybackConfiguration> configs) {
        onPlaybackConfigs(configs, true);
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private void onPlaybackConfigs(@Nullable List<AudioPlaybackConfiguration> configs, boolean report) {
        int media = 0;
        boolean other = false;
        if (configs != null) {
            for (AudioPlaybackConfiguration c : configs) {
                AudioAttributes attrs = c == null ? null : c.getAudioAttributes();
                if (attrs == null) continue;
                if (FocusInference.isMediaUsage(attrs.getUsage())) media++;
                else other = true;
            }
        }
        onPlayback(media, other, report);
    }

    /** The counted form, package-visible so the suite can drive the inference without
     *  building platform configurations. */
    @MainThread
    void onPlayback(int mediaActive, boolean otherActive, boolean report) {
        NowPlaying np = NowPlayingHub.get();
        int event = focus.onConfigs(
            mediaActive, otherActive, np.state == NowPlaying.PLAYING, np.isLoaded(), SystemClock.elapsedRealtime());
        if (!report || event == FocusInference.NONE) return;
        Map<String, Object> facts = new LinkedHashMap<>();
        facts.put("other", otherActive);
        if (event == FocusInference.REGAINED) facts.put("durMs", focus.lastLostMs());
        String app = appState;
        if (app != null) facts.put("app", app);
        emit(KIND_FOCUS_CHANGE, event == FocusInference.LOST ? REASON_FOCUS_LOST : REASON_FOCUS_REGAINED, facts);
    }

    private static void emit(@NonNull String kind, @NonNull String reason, @NonNull Map<String, Object> facts) {
        NowPlayingHub.dispatchSession(kind, reason, facts);
    }

    /* ------------------------------------------------------------------ */
    /* Observers                                                           */
    /* ------------------------------------------------------------------ */

    private final class Lifecycle implements Application.ActivityLifecycleCallbacks {
        @Override public void onActivityCreated(@NonNull Activity activity, @Nullable Bundle saved) { }
        @Override public void onActivityStarted(@NonNull Activity activity) { SessionMonitor.this.onActivityStarted(); }
        @Override public void onActivityResumed(@NonNull Activity activity) { }
        @Override public void onActivityPaused(@NonNull Activity activity) { }
        @Override public void onActivityStopped(@NonNull Activity activity) {
            SessionMonitor.this.onActivityStopped(activity.isChangingConfigurations());
        }
        @Override public void onActivitySaveInstanceState(@NonNull Activity activity, @NonNull Bundle out) { }
        @Override public void onActivityDestroyed(@NonNull Activity activity) { }
    }

    private final class Memory implements ComponentCallbacks2 {
        @Override public void onTrimMemory(int level) { SessionMonitor.this.onTrimMemory(level); }
        @Override public void onConfigurationChanged(@NonNull Configuration newConfig) { }
        /* Android calls onTrimMemory(TRIM_MEMORY_COMPLETE) beside this, so a second row
           here would say the same thing twice. */
        @Override public void onLowMemory() { }
    }

    /* ------------------------------------------------------------------ */
    /* The two pure parts                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Which media outputs are attached, and which one a Foray is most likely playing
     * through. Keyed by type and id (a wired headset is a sink and a source with two
     * ids); ordered by attachment, because Android sends media to the device attached
     * last and to the built-in speaker only when nothing else is there. A heuristic --
     * the platform will not tell a non-system app its media route below API 33 -- and
     * named as one: {@code route} is "likely", and a device pass's
     * {@code dumpsys audio} is the ground truth.
     */
    static final class RouteTracker {
        private final LinkedHashMap<String, String> outputs = new LinkedHashMap<>();

        /** True when {@code type} is a media output this did not already hold. */
        synchronized boolean add(int type, int id) {
            if (!isMediaOutput(type)) return false;
            String key = type + ":" + id;
            if (outputs.containsKey(key)) return false;
            outputs.put(key, portToken(type));
            return true;
        }

        /** True when {@code type} was a media output this held. */
        synchronized boolean remove(int type, int id) {
            if (!isMediaOutput(type)) return false;
            return outputs.remove(type + ":" + id) != null;
        }

        /** The last-attached output that is not the speaker, else the speaker, else
         *  {@code none}. */
        @NonNull
        synchronized String route() {
            String last = null;
            boolean speaker = false;
            for (String port : outputs.values()) {
                if (PORT_SPEAKER.equals(port)) speaker = true;
                else last = port;
            }
            return last != null ? last : speaker ? PORT_SPEAKER : PORT_NONE;
        }

        /** Not where a Foray plays: the earpiece and the call-only (SCO) half of a
         *  headset carry calls, and the rest are capture, telephony or plumbing. */
        static boolean isMediaOutput(int type) {
            switch (type) {
                case AudioDeviceInfo.TYPE_UNKNOWN:
                case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                case AudioDeviceInfo.TYPE_BUILTIN_MIC:
                case AudioDeviceInfo.TYPE_FM:
                case AudioDeviceInfo.TYPE_FM_TUNER:
                case AudioDeviceInfo.TYPE_TV_TUNER:
                case AudioDeviceInfo.TYPE_TELEPHONY:
                case AudioDeviceInfo.TYPE_IP:
                case AudioDeviceInfo.TYPE_BUS:
                case AudioDeviceInfo.TYPE_REMOTE_SUBMIX:
                    return false;
                default:
                    return true;
            }
        }

        /** {@code AudioDeviceInfo} type -> SESSION_PORTS, by TYPE only (a type is not a
         *  name). The Android twin of {@code ForayAudioPlugin.swift}'s
         *  {@code portToken}. */
        @NonNull
        static String portToken(int type) {
            switch (type) {
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE:
                    return PORT_SPEAKER;
                case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                    return "receiver";
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_LINE_ANALOG:
                case AudioDeviceInfo.TYPE_LINE_DIGITAL:
                case AudioDeviceInfo.TYPE_AUX_LINE:
                    return "wired";
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                    return "a2dp";
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                    return "hfp";
                case AudioDeviceInfo.TYPE_BLE_HEADSET:
                case AudioDeviceInfo.TYPE_BLE_SPEAKER:
                case AudioDeviceInfo.TYPE_BLE_BROADCAST:
                    return "ble";
                case AudioDeviceInfo.TYPE_USB_DEVICE:
                case AudioDeviceInfo.TYPE_USB_ACCESSORY:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                    return "usb";
                case AudioDeviceInfo.TYPE_HDMI:
                case AudioDeviceInfo.TYPE_HDMI_ARC:
                case AudioDeviceInfo.TYPE_HDMI_EARC:
                    return "hdmi";
                default:
                    return "other";
            }
        }
    }

    /**
     * Whether something else took the audio, INFERRED -- and the inference is the
     * whole design, so it is stated exactly.
     *
     * <p>Android does not tell a non-system app who holds audio focus. What it does
     * give is {@code AudioPlaybackCallback}: every active player on the device, with
     * its usage, and ANONYMISED -- no uid, so "ours" cannot be picked out by identity.
     * The WebView's {@code <audio>} plays through a media-usage player in this process,
     * so the signal is:
     *
     * <ul>
     *   <li><b>lost</b>: the page reports PLAYING, media-usage audio had been heard
     *       under it, media-usage audio goes quiet, and a player of ANOTHER usage (a
     *       ringtone, a call, a navigation prompt, an assistant) is active at that
     *       moment or starts within {@link #TAKEOVER_WINDOW_MS}. A pause the page asked
     *       for, and a seam's own silence, have no other player beside them and write
     *       nothing -- which is also why a hidden seam's 9-11 s load is never mistaken
     *       for a loss.</li>
     *   <li><b>regained</b>: after a loss, media-usage audio sounds again under a
     *       playing page ({@code durMs} = how long it was lost).</li>
     * </ul>
     *
     * <p>What it cannot see: another MEDIA app (a second podcast player) taking focus
     * looks the same as our own audio carrying on. And the WebView's own focus
     * behaviour is still unestablished (A-12). So these rows are {@code focusChange},
     * a kind {@code player/client.js} does not act on -- a heuristic may explain a stop,
     * it may never cause one.
     */
    static final class FocusInference {
        static final int NONE = 0;
        static final int LOST = 1;
        static final int REGAINED = 2;
        static final long TAKEOVER_WINDOW_MS = 1500L;

        /** Active media-usage players at the last callback, or -1 before any. */
        private int media = -1;
        /** Media audio has sounded under a playing page since it was loaded. */
        private boolean heard = false;
        private boolean lost = false;
        private long lostAt = 0L;
        private long lastLostMs = 0L;
        /** When media went quiet under a PLAYING page, or -1. */
        private long quietAt = -1L;

        /** Media-like: what the WebView's element (and the TTS fallback, which speaks
         *  on the music stream) play as. Everything else is somebody else. */
        static boolean isMediaUsage(int usage) {
            return usage == AudioAttributes.USAGE_MEDIA
                || usage == AudioAttributes.USAGE_UNKNOWN
                || usage == AudioAttributes.USAGE_GAME;
        }

        synchronized int onConfigs(int mediaActive, boolean otherActive, boolean pagePlaying, boolean pageLoaded, long now) {
            media = Math.max(0, mediaActive);
            if (!pageLoaded) {
                heard = false;
                lost = false;
                quietAt = -1L;
                return NONE;
            }
            if (media > 0) {
                quietAt = -1L;
                if (!pagePlaying) return NONE;
                heard = true;
                if (!lost) return NONE;
                lost = false;
                lastLostMs = Math.max(0L, now - lostAt);
                return REGAINED;
            }
            if (lost || !heard) return NONE;
            if (quietAt < 0L) {
                /* The page had already stopped claiming play: the listener paused, and
                   that is not a loss. */
                if (!pagePlaying) return NONE;
                quietAt = now;
            }
            if (otherActive && now - quietAt <= TAKEOVER_WINDOW_MS) {
                lost = true;
                lostAt = now;
                quietAt = -1L;
                return LOST;
            }
            return NONE;
        }

        synchronized long lastLostMs() {
            return lastLostMs;
        }

        /** {@code lost} until regained; {@code unknown} before any callback (or below
         *  API 26); {@code idle} while the page is not playing; {@code held} while it
         *  plays and media audio sounds. */
        @NonNull
        synchronized String state(boolean pagePlaying) {
            if (lost) return FOCUS_LOST;
            if (media < 0) return FOCUS_UNKNOWN;
            if (!pagePlaying) return FOCUS_IDLE;
            return media > 0 ? FOCUS_HELD : FOCUS_UNKNOWN;
        }
    }
}

package com.jwincorporated.foray.audio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * A `mediaPlayback` foreground service whose only job is to hold the app's process
 * importance up while the WebView is playing audio.
 *
 * <h2>Why this exists at all</h2>
 *
 * The audio is a plain {@code <audio>} element inside Capacitor's WebView. Nothing
 * in this class touches it, decodes anything, or knows what is playing. What it
 * buys, from {@code docs/research/mp1-background-audio.md} §5.3, is two things at a
 * layer above Blink that no amount of JavaScript can reach:
 *
 * <ol>
 *   <li><b>Audio focus on Android 15+.</b> "If an app targets Android 15 (API level
 *       35) or higher, it cannot request audio focus unless it's the top app or
 *       running a foreground service." Capacitor 8.5.0 generates
 *       {@code targetSdkVersion = 36}, so the shell is inside that rule from its
 *       first build.</li>
 *   <li><b>Not being frozen.</b> The documented process-importance ladder is
 *       foreground → visible → service → cached, and a cached process is moved into
 *       a frozen cgroup where "all of its threads are suspended".
 *       {@code startForeground()} confers <i>visible</i>. Playing audio appears
 *       nowhere on that ladder.</li>
 * </ol>
 *
 * <p>MP1 is careful to call the second one an <b>inference</b> from two documented
 * facts rather than a sentence AOSP states, and this class does not upgrade it.
 * Nothing here has been observed on a device or an emulator — see
 * {@code docs/android-native-code.md} for exactly what is measured.
 *
 * <h2>What it is NOT for</h2>
 *
 * It is <b>not</b> a fix for the seam. Hidden-page throttling in Blink is on the
 * media-load <i>task chain</i> and is keyed to <b>visibility</b>, not audibility
 * (MP1 §4.1a): a hidden load of a small local bundled file still measured 9–11 s,
 * because each step of the HTML media load algorithm is a queued task delivered
 * ~3 s apart while hidden. A foreground service does not make the page visible and
 * so does not shorten that. Believing otherwise is the trap this comment exists to
 * close.
 *
 * <h2>START_NOT_STICKY</h2>
 *
 * If Android kills this service under memory pressure, restarting it would put a
 * foreground service and its notification back up with no page and no audio behind
 * it. The web layer re-asks on the next {@code play()}, which is the only signal
 * that means anything.
 */
public class PlaybackKeepAliveService extends Service {

    private static final String TAG = "ForayAudio";

    /** Low-importance so the notification is silent and does not push into view. */
    static final String CHANNEL_ID = "foray-playback";

    /** Any non-zero id. Zero is rejected by {@code startForeground}. */
    static final int NOTIFICATION_ID = 1837;

    /**
     * Read by {@link ForayAudioPlugin} so a JS caller can be told what actually
     * happened rather than what was requested.
     *
     * <p>{@code volatile} because it is written on the main thread and read from
     * the bridge's thread pool. It is deliberately a plain flag and not a count:
     * this service is a singleton per process, and "how many times was start
     * called" is not a question worth being able to answer wrongly.
     */
    private static volatile boolean running = false;

    static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel(this);
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), foregroundServiceType());
            running = true;
        } catch (Exception e) {
            /* Broad on purpose, and the reason is the whole point of this catch.
               From Android 14, startForeground throws
               InvalidForegroundServiceTypeException / MissingForegroundServiceTypeException
               when the manifest and the type argument disagree, and from Android 12
               ForegroundServiceStartNotAllowedException when the app was not allowed
               to start one. All of those are unchecked, all of them would otherwise
               kill the app MID-FORAY, and none of them is worth a crash: an app that
               plays audio without the service is degraded, an app that has died is
               not playing anything. The flag stays false so the JS side sees the
               truth, and stopSelf() means we do not sit as a started-but-not-
               foreground service. */
            Log.w(TAG, "startForeground failed; continuing without a foreground service", e);
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        /* Nothing binds to this. The plugin starts and stops it with intents, which
           keeps its lifetime independent of the Activity's. */
        return null;
    }

    /* ------------------------------------------------------------ notification */

    private int foregroundServiceType() {
        /* The typed overload exists from API 29. Below that a foreground service has
           no type and passing 0 is the documented "no type" value; the
           `mediaPlayback` requirement itself only starts at API 34. minSdk is 24. */
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            : 0;
    }

    /**
     * Create the notification channel. Idempotent — {@code createNotificationChannel}
     * on an existing id updates it rather than failing, which matters because
     * {@code onCreate} runs again after every stop.
     */
    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.foray_playback_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(context.getString(R.string.foray_playback_channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            /* A PLATFORM drawable, so this plugin ships no res/drawable and cannot
               collide with the app's icons. It is a placeholder: the real
               notification — icon, artwork, episode title, transport controls — is
               #27's Android half, and building it here would be building the wrong
               half first. */
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.foray_playback_notification_title))
            .setContentText(getString(R.string.foray_playback_notification_text))
            .setContentIntent(launchIntent())
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setOngoing(true)
            .setShowWhen(false)
            /* Without this the system may hold the notification back for ~10 s.
               A user who backgrounds the app should be able to see immediately why
               it is still running. */
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    /**
     * Tapping the notification reopens the app. Resolved through the package
     * manager rather than by naming {@code MainActivity}: the activity belongs to
     * the GENERATED project, and this plugin must not hold a compile-time reference
     * into a tree that `cap add android` rewrites.
     */
    @Nullable
    private PendingIntent launchIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}

package ai.jwlabs.foura.audio;

import ai.jwlabs.foura.audio.engine.EngineLog;
import ai.jwlabs.foura.audio.engine.EngineStore;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaButtonReceiver;

/**
 * THE CAR'S WAY BACK IN AFTER THE PROCESS DIED (card A-27, docs/plans/android-assessment.md §5.4;
 * plan §3's "car hands play to Spotify after the app died" row). The Android half of iOS NE-24's
 * cold path: with no live media session, Android sends a media button PLAY to the last app that
 * registered a media button receiver. This is ours. Media3's {@link MediaButtonReceiver} starts
 * {@link ForayPlaybackService} in the foreground with the key event, the service's session gets a
 * play with nothing loaded, and Media3 asks {@code onPlaybackResumption} for the playlist: the
 * engine's restore record ({@code EngineStore}), which the engine then plays at the saved
 * position.
 *
 * <h2>OFF UNLESS THE NATIVE ENGINE IS THE LANE</h2>
 *
 * Declared {@code android:enabled="false"}. Media3 hands a manifest media button receiver to
 * EVERY session this app builds, the JS lane's {@code PlaybackKeepAliveService} session included,
 * and the JS lane has nothing to resume without its WebView (docs/android-lock-screen.md §4.3). So
 * the JS lane must never register it: {@code ForayPlaybackService.onCreate} switches it on (native
 * mode only runs that service, A-20), BEFORE its session is built (Media3 reads the manifest when
 * a session is built), and the store switches it off again when nothing is left to resume (a
 * relinquished record, a purge).
 *
 * <h2>AND A PLAY IT CANNOT KEEP IS NOT TAKEN</h2>
 *
 * Once started this way, the service MUST start playing within a few seconds, or Android kills it
 * ({@code ForegroundServiceDidNotStartInTimeException}). So {@link #shouldStartForegroundService}
 * starts it only when the store holds a record a PLAY can resume; otherwise the press is dropped
 * here, which is what the JS lane does today (nobody gets it), and a row says so in logcat.
 */
@OptIn(markerClass = UnstableApi.class)
public class ForayMediaButtonReceiver extends MediaButtonReceiver {
    static final String TAG = EngineLog.TAG;

    @Override
    protected boolean shouldStartForegroundService(@NonNull Context context, @NonNull Intent intent) {
        boolean resumable;
        try {
            resumable = EngineStore.restorable(context);
        } catch (RuntimeException e) {
            resumable = false;
        }
        Log.i(TAG, "media-button receiver " + (resumable ? "start" : "drop") + " restorable=" + resumable);
        return resumable;
    }

    /** Switch the receiver on (the native engine is the lane) or off (nothing to resume). Never throws. */
    static void setEnabled(@NonNull Context context, boolean enabled) {
        try {
            context.getPackageManager().setComponentEnabledSetting(component(context),
                    enabled ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not switch the media button receiver " + (enabled ? "on" : "off"), e);
        }
    }

    /** Whether it is on now (the manifest says off; the service's {@code onCreate} turns it on). */
    static boolean isEnabled(@NonNull Context context) {
        try {
            return context.getPackageManager().getComponentEnabledSetting(component(context))
                    == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
        } catch (RuntimeException e) {
            return false;
        }
    }

    static ComponentName component(@NonNull Context context) {
        return new ComponentName(context, ForayMediaButtonReceiver.class);
    }
}

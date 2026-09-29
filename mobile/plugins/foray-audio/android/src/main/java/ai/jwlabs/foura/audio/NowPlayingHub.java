package ai.jwlabs.foura.audio;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * The one place the page's now-playing state lives, and the one channel a transport
 * press travels back down.
 *
 * <h2>Why a process singleton and not a field on either end</h2>
 *
 * The two ends have different lifetimes and neither can hold the other:
 *
 * <ul>
 *   <li>{@link ForayAudioPlugin} exists for as long as the Activity's bridge does.
 *       It receives {@code setNowPlaying} on Capacitor's worker pool, and it can
 *       receive one <b>before</b> the service exists — the page writes metadata as
 *       soon as a Foray loads, and {@code play()} is what starts the service.</li>
 *   <li>{@link PlaybackKeepAliveService} exists between the first {@code play()} and
 *       the stop, is created and destroyed repeatedly across a session, and owns the
 *       {@code MediaSession} that has to be built from whatever the current state
 *       already is.</li>
 * </ul>
 *
 * So the state outlives both and is held here, and the service reads it at
 * {@code onCreate} rather than waiting to be told again. Without that, a service
 * started by the first {@code play()} would show an empty notification until the
 * page's next 4 Hz repaint — visible, and avoidable for one field.
 *
 * <h2>Threading, stated exactly</h2>
 *
 * {@link #set} is called from the <b>bridge's worker pool</b>. {@link #get} is called
 * from the <b>main thread</b>, inside {@code WebViewPlayer.getState()}, which Media3
 * may call at any time. The field is {@code volatile} and {@link NowPlaying} is
 * immutable, so a reader sees one whole value or another and never a mix.
 *
 * <p>The listener is dispatched <b>on the main thread</b>, always, even when
 * {@code set} was already called from it — because
 * {@code SimpleBasePlayer.invalidateState()} asserts its own looper and the
 * notification touches {@code NotificationManager}. Posting unconditionally is one
 * behaviour instead of two.
 */
final class NowPlayingHub {

    private static final String TAG = "ForayAudio";

    /** Told, on the main thread, that {@link #get()} will answer differently. */
    interface Listener {
        @MainThread
        void onNowPlayingChanged(@NonNull NowPlaying nowPlaying);
    }

    /** Carries a transport press back to the page. Implemented by the plugin, which
     *  is the only thing that can reach the WebView. */
    interface TransportSink {
        /**
         * @param action    one of `ROUTABLE_ACTIONS` in `foray-media-session.js`
         * @param positionMs for {@code seekto}; ignored otherwise
         * @param offsetMs   for {@code seekbackward}/{@code seekforward}
         */
        void onTransport(@NonNull String action, long positionMs, long offsetMs);

        /**
         * The same press, with WHICH DOOR it came through (founder, 2026-09-23:
         * "my car resumed Spotify"). {@link #ORIGIN_SESSION} is Media3's session —
         * a car head unit, a Bluetooth button, the lock screen's media panel —
         * and {@link #ORIGIN_NOTIFICATION} is one of the notification's own
         * buttons. The record's {@code remote} row reads it; nothing else does.
         *
         * <p>A default so every existing sink (and every lambda in
         * {@code NowPlayingHubTest}) keeps compiling; the plugin overrides it.
         */
        default void onTransport(@NonNull String action, long positionMs, long offsetMs, @NonNull String origin) {
            onTransport(action, positionMs, offsetMs);
        }
    }

    /**
     * Carries a SYSTEM event -- something the OS did under the player, not a press --
     * back to the page as the plugin's {@code SESSION_EVENT} (A-08). Implemented by the
     * plugin, for the same reason {@link TransportSink} is: it is the only thing that
     * can reach the WebView.
     *
     * <p>{@code kind} and {@code reason} are the iOS plugin's closed vocabulary
     * ({@code player/diagnostic-log.js} admits it, {@code player/client.js} acts on
     * it), so the page reads an Android route loss exactly as it reads an iOS one.
     */
    interface SessionSink {
        void onSession(@NonNull String kind, @NonNull String reason);
    }

    /** The two origins, spelled as `REMOTE_ORIGINS` in `player/diagnostic-log.js`
     *  spells them. */
    static final String ORIGIN_SESSION = "media-session";
    static final String ORIGIN_NOTIFICATION = "notification";

    private NowPlayingHub() {}

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static volatile NowPlaying current = NowPlaying.EMPTY;
    @Nullable private static volatile Listener listener = null;
    @Nullable private static volatile TransportSink sink = null;
    @Nullable private static volatile SessionSink sessionSink = null;

    @NonNull
    static NowPlaying get() {
        return current;
    }

    static void set(@NonNull NowPlaying next) {
        current = next;
        final Listener target = listener;
        if (target == null) return;
        MAIN.post(() -> {
            /* RE-READ RATHER THAN CAPTURED, both of them. Two `setNowPlaying` calls can
               land on the worker pool before either post runs; capturing `next` would
               deliver them in post order with the older value last, and the service
               would render a stale title. Re-reading `current` makes both posts deliver
               the same, latest value — the second is then a redundant repaint, which is
               the cheap failure. Re-reading `listener` matters because the service can
               be destroyed between the post and its execution. */
            final Listener live = listener;
            if (live != null) live.onNowPlayingChanged(current);
        });
    }

    /** Registered by the service in {@code onCreate}. */
    static void setListener(@Nullable Listener next) {
        listener = next;
    }

    /** Cleared by the service in {@code onDestroy}, and IDENTITY-CHECKED because a
     *  stop and a start can overlap: a new service's {@code onCreate} can run before
     *  the old one's {@code onDestroy}, and an unconditional clear there would
     *  unregister the live listener and leave the new notification frozen at whatever
     *  it was built with. */
    static void clearListener(@Nullable Listener expected) {
        if (listener == expected) listener = null;
    }

    static void setSink(@Nullable TransportSink next) {
        sink = next;
    }

    /** Same identity check, same reason: an Activity recreation builds the new
     *  plugin's sink before tearing the old plugin down. */
    static void clearSink(@Nullable TransportSink expected) {
        if (sink == expected) sink = null;
    }

    static void setSessionSink(@Nullable SessionSink next) {
        sessionSink = next;
    }

    /** Identity-checked, for the Activity-recreation overlap {@link #clearSink}
     *  names. */
    static void clearSessionSink(@Nullable SessionSink expected) {
        if (sessionSink == expected) sessionSink = null;
    }

    /**
     * A system event for the page (A-08: headphones unplugged, a Bluetooth route
     * lost). Dropped when no page is listening, for {@link #dispatch}'s reason: a
     * pause replayed minutes later, after the page came back, is a pause nobody
     * caused.
     */
    static void dispatchSession(@NonNull String kind, @NonNull String reason) {
        final SessionSink target = sessionSink;
        if (target == null) {
            Log.w(TAG, "session " + kind + "/" + reason + " arrived with no page listening");
            return;
        }
        try {
            target.onSession(kind, reason);
        } catch (Exception e) {
            /* Same rule as a transport press: this runs on the main thread inside a
               broadcast receiver, and failing to tell the page must not kill the app. */
            Log.w(TAG, "could not deliver session " + kind + "/" + reason, e);
        }
    }

    /**
     * A transport press from the OS, a Bluetooth button or a car head unit.
     *
     * <p>Silently dropped when there is no page to tell, and that is the right
     * answer rather than a queue: a press with no WebView behind it has nothing to
     * act on, and a press REPLAYED later — after the page came back, seconds or
     * minutes on — would be a pause or a skip the listener did not just ask for.
     */
    static void dispatch(@NonNull String action, long positionMs, long offsetMs) {
        dispatch(action, positionMs, offsetMs, ORIGIN_SESSION);
    }

    /** {@link #dispatch(String, long, long)}, naming the door. */
    static void dispatch(@NonNull String action, long positionMs, long offsetMs, @NonNull String origin) {
        final TransportSink target = sink;
        if (target == null) {
            Log.w(TAG, "transport " + action + " from " + origin + " arrived with no page listening");
            return;
        }
        try {
            target.onTransport(action, positionMs, offsetMs, origin);
        } catch (Exception e) {
            /* The sink calls into Capacitor, which calls into the WebView. A throw
               here arrives on the main thread inside a Media3 state change, so it would
               take the app down to fail at sending a pause. */
            Log.w(TAG, "could not deliver transport " + action, e);
        }
    }

    /** Test and device-probe seam: forget everything. Not called in normal operation
     *  — the plugin and the service each clear what they registered. */
    static void reset() {
        current = NowPlaying.EMPTY;
        listener = null;
        sink = null;
        sessionSink = null;
    }
}

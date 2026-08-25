package ai.jwlabs.foura.audio;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The bridge half of `foray-audio`: the methods that start, stop and report the
 * {@link PlaybackKeepAliveService}, and the ones that carry #27's now-playing state
 * to it and transport presses back.
 *
 * <h2>Called from where</h2>
 *
 * From {@code mobile/plugins/foray-audio/web/foray-audio-shell.js}, over
 * {@code window.Capacitor.nativePromise("ForayAudio", …)}. There is no
 * {@code @capacitor/core} import and no generated JS proxy, because this repo has
 * no bundler — the root is dependency-free with no build step, which is what lets
 * the keyless Action deploy the static site. {@code nativePromise} is part of the
 * bridge Capacitor injects at document start, so it is there without one.
 *
 * <h2>Every method RESOLVES. None of them rejects.</h2>
 *
 * A rejected {@code PluginCall} becomes a rejected promise in the page, and the
 * page is a media player mid-Foray. The failure this plugin can actually have —
 * Android refusing to let a foreground service start — must degrade to "playing
 * without the service", not to an unhandled rejection inside the player's event
 * path. So the outcome is data: {@code started}, {@code running} and a
 * {@code reason} string, and the web side decides what to do with it.
 *
 * <p>The one thing this class must never do is throw into the WebView's thread or
 * crash the process. {@code startForegroundService} throws
 * {@code ForegroundServiceStartNotAllowedException} from Android 12 when called
 * from the background, and that is a live risk here rather than a theoretical one:
 * a cross-episode seam pauses one element and plays another while the app is
 * hidden (MP1 §4.4, and #239 gives a hidden load 20 s), so a stop-then-start
 * across a seam would be a background start. The web side is built to avoid ever
 * making that call — see the settle window in {@code foray-audio-shell.js} — and
 * this catch is the second line, not the first.
 *
 * <h2>#27's addition: two directions instead of one</h2>
 *
 * {@code setNowPlaying} carries what the lock screen should say INTO the process, and
 * a {@code transport} event carries a press back OUT. Both go through
 * {@link NowPlayingHub} rather than through this class's fields, because the service
 * that renders the state and the plugin that receives it have different lifetimes and
 * either can exist without the other — see the hub's own comment.
 *
 * <p>The event is raised with {@code notifyListeners}, and the page subscribes with
 * the injected bridge's own {@code Capacitor.addListener} — no {@code @capacitor/core}
 * proxy, for the same reason the rest of this plugin is called through
 * {@code nativePromise}: this repo has no bundler.
 */
@CapacitorPlugin(
    name = "ForayAudio",
    /* DECLARED SO IT CAN BE ASKED FOR, and #244 was right to leave it out until now.
       A foreground service runs whether or not the notification is shown, so #244's
       process-importance and audio-focus properties never needed this. #27's do: the
       transport controls ARE the notification, and from Android 13 a notification the
       user has not permitted is not shown. So the permission stops being cosmetic and
       becomes the difference between a lock screen with controls and one without.

       The runtime request is `requestNotifications` below, called once by the web half
       after the first accepted start — which is the first `play()`, a user gesture, with
       the app in the foreground and the reason for the prompt one press old. That is the
       most explicable moment reachable without new UI, and new UI would be `app.js` or
       `player/`, neither of which this change touches. */
    permissions = {
        @Permission(alias = ForayAudioPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class ForayAudioPlugin extends Plugin {

    private static final String TAG = "ForayAudio";

    static final String NOTIFICATIONS = "notifications";

    /** Raised on every transport press. The name is duplicated in
     *  {@code foray-media-session.js} as {@code TRANSPORT_EVENT} and asserted equal by
     *  {@code shell-invariants.test.mjs} — if the two ever disagree, every press is
     *  delivered to nobody and every test stays green. */
    static final String TRANSPORT_EVENT = "transport";

    /** Registered with the hub so a press can reach the page. Held as a field so
     *  {@code handleOnDestroy} can clear exactly the one it registered. */
    private NowPlayingHub.TransportSink sink;

    /**
     * Register the two things that must outlive a single bridge call.
     *
     * <p>{@code load()} runs once per plugin instance, which is once per Activity.
     */
    @Override
    public void load() {
        super.load();
        sink = (action, positionMs, offsetMs) -> {
            JSObject event = new JSObject();
            event.put("action", action);
            event.put("positionMs", positionMs);
            event.put("offsetMs", offsetMs);
            notifyListeners(TRANSPORT_EVENT, event);
        };
        NowPlayingHub.setSink(sink);

    }

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        /* READ BEFORE THE CALL, AND THIS IS THE WHOLE POINT OF THE FIELD NAME.
           `startForegroundService` only asks ActivityManager to start the service;
           `PlaybackKeepAliveService.onStartCommand` — the thing that sets `running` —
           is dispatched later, on the app's MAIN thread, while this method runs on the
           bridge's worker pool. So reading `isRunning()` after the call is a race that
           answers false on every first start, and a review pass found this reported as
           `running` and gated on by the web half: `ensureStarted`'s short-circuit could
           never fire, so every play() re-issued `start` — including the play() on the
           far side of a hidden seam, which is a BACKGROUND foreground-service start and
           the one call the web half's settle window exists to avoid.

           So nothing here reports the post-call state. `alreadyRunning` is a truthful
           synchronous fact — whether this start is a no-op re-start — and `state()` is
           the method that answers "is it running?" honestly, because by the time
           anyone calls it, onStartCommand has run. */
        result.put("alreadyRunning", PlaybackKeepAliveService.isRunning());
        try {
            ContextCompat.startForegroundService(context, serviceIntent(context));
            result.put("started", true);
            result.put("reason", "");
        } catch (Exception e) {
            /* See the class comment. Broad because the interesting exceptions —
               ForegroundServiceStartNotAllowedException (API 31+) and the API 34
               type mismatches — are unchecked and only exist on newer platforms, so
               a narrow catch list would either not compile on minSdk 24 or would
               miss whatever the next release adds. */
            Log.w(TAG, "could not start the playback foreground service", e);
            result.put("started", false);
            result.put("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        /* NOT reported: whether the service is running now. `started` means "the
           request was accepted", which is the strongest thing knowable at this
           instant, and it is what the web half gates on. The weaker guarantee is
           stated rather than faked: a service that is started can still fail its own
           `startForeground()` a moment later (an API 34 type mismatch, a missing
           permission), and `state()` is what sees that. */
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        /* Same race, inverted: `stopService` is asynchronous, so `onDestroy` — which
           clears the flag — has not run yet. Read BEFORE, and named for what it is. */
        result.put("wasRunning", PlaybackKeepAliveService.isRunning());
        try {
            context.stopService(serviceIntent(context));
            result.put("stopped", true);
            result.put("reason", "");
        } catch (Exception e) {
            Log.w(TAG, "could not stop the playback foreground service", e);
            result.put("stopped", false);
            result.put("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        call.resolve(result);
    }

    /**
     * Whether the service is running, and the only method here that can answer that
     * truthfully.
     *
     * <p>It is truthful precisely because it is a SEPARATE call: by the time anything
     * asks, the main-thread dispatch of {@code onStartCommand} or {@code onDestroy}
     * has happened. {@code start()} and {@code stop()} deliberately do not try to
     * answer it — see the comment in {@code start}.
     *
     * <p>No side effects, and the reason {@code HUMAN-ACTIONS.md}'s Android device
     * pass can report something better than "the audio kept playing":
     * {@code await Capacitor.nativePromise("ForayAudio", "state", {})} from
     * {@code chrome://inspect}, or {@code await window.ForayAudioShell.refresh()}.
     */
    @PluginMethod
    public void state(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", PlaybackKeepAliveService.isRunning());
        result.put("platform", "android");
        /* #27's three diagnostics, and each answers a question a device pass would
           otherwise have to guess at from the absence of a lock screen:
             sessionActive         — is there a MediaSession at all, or did building one
                                     throw? The service runs either way.
             notificationsEnabled  — is the notification being SHOWN? On Android 13+ a
                                     denied POST_NOTIFICATIONS means no notification and
                                     therefore no media panel, with the service running
                                     perfectly.
             notificationPermission— can it still be asked for, or is asking pointless?
           "The lock screen is blank" has at least three causes and only one of them is
           a bug in this code. */
        result.put("sessionActive", PlaybackKeepAliveService.isSessionActive());
        result.put("notificationsEnabled", notificationsEnabled());
        result.put("notificationPermission", notificationPermission());
        call.resolve(result);
    }

    /**
     * Everything the lock screen should say, from the page's own
     * {@code navigator.mediaSession} writes.
     *
     * <p>RESOLVES ALWAYS, like every other method here, and for a sharper version of
     * the same reason: this one is called on every metadata change and once a second
     * while a Foray plays, from inside the page's render path. A rejection there would
     * be an unhandled promise on a 1 Hz timer.
     *
     * <p>It does not touch the service or the session directly. The value goes to
     * {@link NowPlayingHub}, which posts to the main thread — this method runs on
     * Capacitor's worker pool, and both {@code SimpleBasePlayer.invalidateState} and
     * {@code NotificationManager} require otherwise.
     */
    @PluginMethod
    public void setNowPlaying(PluginCall call) {
        JSObject result = new JSObject();
        try {
            NowPlayingHub.set(NowPlaying.from(call.getData()));
            result.put("ok", true);
            result.put("reason", "");
        } catch (Exception e) {
            Log.w(TAG, "could not apply the now-playing state", e);
            result.put("ok", false);
            result.put("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        /* Reported so the web half can log the one combination that means "the lock
           screen will be blank and nothing is wrong here": state accepted, service not
           running yet, because nothing has played. */
        result.put("running", PlaybackKeepAliveService.isRunning());
        result.put("sessionActive", PlaybackKeepAliveService.isSessionActive());
        call.resolve(result);
    }

    /**
     * A new document has loaded: forget the last one and stop any service it left.
     *
     * <h3>Why this is a plugin method and not a native page hook</h3>
     *
     * <p><b>Because the native page hook does not work, and a review pass proved it by
     * reading Capacitor's own source.</b> The first version of this registered a
     * {@code WebViewListener} from {@code load()} — and in Capacitor 8.5.0
     * {@code Bridge}'s constructor calls {@code registerAllPlugins()} (which is where
     * {@code load()} runs), and then {@code Bridge.Builder.create()} calls
     * {@code bridge.setWebViewListeners(webViewListeners)}, which <b>replaces the whole
     * list</b> with the Builder's own. So the listener was silently discarded and
     * {@code onPageLoaded} could never fire — dead code that the documentation claimed
     * as one of two fixes, and that a source-scanning test happily asserted the shape
     * of. Registering a listener that way needs {@code Bridge.Builder} in
     * {@code MainActivity}, which belongs to the generated project this plugin must not
     * reach into.
     *
     * <p>So the page announces itself instead, from {@code foray-audio-shell.js}'s
     * install — which runs exactly once per document, by construction, and which a Node
     * test can actually drive.
     *
     * <h3>What it fixes</h3>
     *
     * <p><b>A reloaded page must not inherit a running service.</b> The hole predates
     * #27 and #27 widens it: under #244 a reload mid-playback left the service up until
     * the settle window (25 s) in a page that no longer existed, and now the service
     * lives as long as the transport is usable, while the new page starts with
     * {@code wanted} and {@code mediaLoaded} both false — so nothing in JS is in a
     * position to stop it at all.
     *
     * <p>It also clears {@link NowPlayingHub}, which a second review finding named: the
     * hub is a process singleton that nothing clears in normal operation, so after a
     * reload the new page's first {@code play()} would build a session and a
     * notification from the PREVIOUS document's title, with a
     * {@code playWhenReady} playhead extrapolating forward, until its first
     * {@code setNowPlaying} landed.
     *
     * <p>Safe on a first load, which is what makes it safe at all: stopping a service
     * that is not running is a no-op, and clearing a hub that is already empty is too.
     */
    @PluginMethod
    public void newDocument(PluginCall call) {
        JSObject result = new JSObject();
        /* Read BEFORE, like `stop`'s `wasRunning`, and for the same reason: `stopService`
           is asynchronous, so a post-call read is a race. This one is also the only
           evidence a device pass has that a reload ever leaked a service. */
        result.put("wasRunning", PlaybackKeepAliveService.isRunning());
        try {
            NowPlayingHub.set(NowPlaying.EMPTY);
            stopServiceQuietly();
            result.put("ok", true);
            result.put("reason", "");
        } catch (Exception e) {
            Log.w(TAG, "could not reset for a new document", e);
            result.put("ok", false);
            result.put("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        call.resolve(result);
    }

    /**
     * Ask for {@code POST_NOTIFICATIONS}, at most once, from the web half.
     *
     * <p>Three answers and only one of them is a prompt:
     * <ul>
     *   <li>below API 33 there is no runtime permission, so {@code granted} is whatever
     *       the user's notification settings say and nothing is asked;</li>
     *   <li>already granted (or already denied twice, which Android reports as denied
     *       and will not re-prompt) — no prompt;</li>
     *   <li>otherwise, one system dialog.</li>
     * </ul>
     *
     * <p>A denial is not a failure and must not read as one: the foreground service
     * runs, the audio keeps playing, and #244's whole reason for the service is
     * untouched. What is lost is the notification and, with it, the lock-screen
     * controls — so the web half logs it and carries on.
     */
    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject result = new JSObject();
            result.put("requested", false);
            result.put("granted", notificationsEnabled());
            result.put("reason", "no runtime notification permission below API 33");
            call.resolve(result);
            return;
        }
        if ("granted".equals(notificationPermission())) {
            JSObject result = new JSObject();
            result.put("requested", false);
            result.put("granted", true);
            result.put("reason", "");
            call.resolve(result);
            return;
        }
        try {
            requestPermissionForAlias(NOTIFICATIONS, call, "notificationsResult");
        } catch (Exception e) {
            /* A permission request needs a live Activity. If there is not one — the call
               raced a teardown — the honest answer is "not asked", not a rejected
               promise inside the player's event path. */
            Log.w(TAG, "could not request the notification permission", e);
            JSObject result = new JSObject();
            result.put("requested", false);
            result.put("granted", false);
            result.put("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
            call.resolve(result);
        }
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("requested", true);
        result.put("granted", "granted".equals(notificationPermission()));
        result.put("reason", "");
        call.resolve(result);
    }

    /** Whether a notification we post would actually be SHOWN. Broader than the
     *  permission: a user can switch the app's notifications off in settings on any
     *  Android version, and that produces the same blank lock screen. */
    private boolean notificationsEnabled() {
        try {
            Context context = getContext();
            return context != null && NotificationManagerCompat.from(context).areNotificationsEnabled();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Capacitor's own {@code PermissionState} word, or {@code "unsupported"} below API
     * 33 where there is no such permission to have a state.
     *
     * <p><b>FOUR WORDS, NOT THREE:</b> {@code granted}, {@code denied}, {@code prompt}
     * and {@code prompt-with-rationale}. An earlier comment here promised three and a
     * review pass caught it — worth fixing rather than shrugging at, because this string
     * is passed straight through to a device pass as a diagnostic, and a reader told to
     * expect three words will read the fourth as a bug in the plugin.
     */
    private String notificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "unsupported";
        try {
            return getPermissionState(NOTIFICATIONS).toString();
        } catch (Exception e) {
            return "unsupported";
        }
    }

    /** Stop the service without an answer and without a throw. Used by the page-load
     *  listener, where there is no {@code PluginCall} to resolve. */
    private void stopServiceQuietly() {
        try {
            Context context = getContext();
            if (context != null) context.stopService(serviceIntent(context));
        } catch (Exception e) {
            Log.w(TAG, "could not stop the playback service", e);
        }
    }

    /**
     * Stop the service when the Activity hosting the bridge goes away.
     *
     * <p>Without this, a destroyed Activity leaves a foreground service — and its
     * notification — running with no WebView left to ask it to stop, which is a
     * battery bug that looks exactly like the thing this plugin was added to fix.
     * The manifest's {@code stopWithTask="true"} covers the swipe-away case; this
     * covers the rest.
     */
    @Override
    protected void handleOnDestroy() {
        /* IDENTITY-CHECKED inside the hub, not cleared unconditionally: an Activity
           recreation constructs the new plugin — and its sink — BEFORE destroying the
           old one, so an unconditional clear here would unregister the live sink and
           every transport press after a rotation would reach nobody. */
        NowPlayingHub.clearSink(sink);
        sink = null;
        stopServiceQuietly();
        super.handleOnDestroy();
    }

    private static Intent serviceIntent(Context context) {
        return new Intent(context, PlaybackKeepAliveService.class);
    }
}

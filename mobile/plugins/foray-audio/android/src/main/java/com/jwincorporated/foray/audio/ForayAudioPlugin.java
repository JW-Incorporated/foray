package com.jwincorporated.foray.audio;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The bridge half of `foray-audio`: three methods that start, stop and report the
 * {@link PlaybackKeepAliveService}.
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
 */
@CapacitorPlugin(name = "ForayAudio")
public class ForayAudioPlugin extends Plugin {

    private static final String TAG = "ForayAudio";

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
        call.resolve(result);
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
        try {
            Context context = getContext();
            if (context != null) context.stopService(serviceIntent(context));
        } catch (Exception e) {
            Log.w(TAG, "could not stop the playback service on destroy", e);
        }
        super.handleOnDestroy();
    }

    private static Intent serviceIntent(Context context) {
        return new Intent(context, PlaybackKeepAliveService.class);
    }
}

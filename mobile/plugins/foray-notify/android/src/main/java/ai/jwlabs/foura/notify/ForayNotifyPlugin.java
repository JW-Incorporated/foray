package ai.jwlabs.foura.notify;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * {@code ForayNotify} on Android: local new-episode alerts for followed shows, and
 * the tap that opens the show (issue #761; docs/roadmap/player-features.md PQ-29).
 * The twin of {@code ios/Sources/ForayNotifyPlugin/ForayNotifyPlugin.swift}
 * (PQ-28): the same name, the same four calls, the same event. Like the iOS half
 * it has no JS entry of its own: the web half is {@code player/alert-open.js}
 * ({@code ALERT_PLUGIN}, {@code ALERT_EVENT}).
 * <pre>
 *   requestPermission()             -> { granted }   the ONE place that asks
 *   status()                        -> { status, granted }
 *   scheduleRefresh()               -> { periodic, intervalMs }  the WorkManager chain, once
 *   notifyNow({ title, body, showId })                post one alert now
 * </pre>
 * and one event, {@code alertOpened { showId }}, when the listener taps an alert.
 *
 * <p><b>UNDECLARED, SO INERT.</b> Nothing in {@code mobile/package.json} names this
 * plugin yet, so {@code cap sync} does not include this module, no APK contains
 * it and nothing here runs on a phone. Its JVM tests run in android-build.yml's
 * {@code foray-notify} step, which includes the module for that step only. PQ-30
 * declares it.
 *
 * <p><b>THE PERMISSION</b> is {@code POST_NOTIFICATIONS} under the alias
 * {@code "notifications"}, the alias {@code ForayAudioPlugin} already declares for
 * the same permission, asked the same way: below API 33 there is nothing to ask;
 * already granted asks nothing; otherwise one system dialog. The page asks when
 * the listener turns a show's alerts on, never at launch.
 *
 * <p><b>THE TAP.</b> {@link AlertPoster} puts the show in the launch intent's
 * extras. A warm tap arrives as {@link #handleOnNewIntent}; a cold one is the
 * activity's own intent, read in {@link #load()}. Either way the extras are
 * removed once read (a configuration change or a page reload re-runs nothing),
 * and {@code alertOpened} is emitted. On a cold start the tap arrives before the
 * page has attached its listener, so it is HELD until one attaches, and only the
 * last one is held: two held taps would route twice and land where the last one
 * says anyway (iOS keeps the same rule). Capacitor's own
 * {@code retainUntilConsumed} keeps every event in a private list this class
 * cannot trim, so the hold is this class's own, released by {@link #addListener}.
 */
@CapacitorPlugin(
    name = "ForayNotify",
    permissions = {
        @Permission(alias = ForayNotifyPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class ForayNotifyPlugin extends Plugin {

    /** The same alias {@code ForayAudioPlugin.NOTIFICATIONS} uses for the same permission. */
    static final String NOTIFICATIONS = "notifications";

    /** The last tap no listener has heard yet, or null. */
    private String heldShowId;

    @Override
    public void load() {
        Context context = getContext();
        if (context != null) AlertsRefresh.pruneLedger(context); // the ledger names only shows still followed
        Activity activity = launchActivity();
        if (activity != null) consumeAlertIntent(activity.getIntent());
    }

    /** The activity the bridge runs in, or null (no bridge yet, or none at all). */
    private Activity launchActivity() {
        try {
            return getBridge() == null ? null : getActivity();
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ── calls ─────────────────────────────────────────────────────────────────

    /** The permission prompt, and the only {@code requestPermissionForAlias} here. */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || "granted".equals(permissionWord())) {
            JSObject result = new JSObject();
            result.put("granted", notificationsEnabled());
            call.resolve(result);
            return;
        }
        try {
            requestPermissionForAlias(NOTIFICATIONS, call, "permissionResult");
        } catch (Exception e) {
            /* A request needs a live Activity; one that raced a teardown is "not granted",
               not a rejected promise in the show page's switch. */
            JSObject result = new JSObject();
            result.put("granted", false);
            call.resolve(result);
        }
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", "granted".equals(permissionWord()) && notificationsEnabled());
        call.resolve(result);
    }

    /** {@code status}: iOS's words where Android has them ({@code granted}, {@code denied},
     *  {@code prompt}), Capacitor's {@code prompt-with-rationale} where it adds one; an app
     *  whose notifications are switched off in settings is {@code denied} whatever the
     *  permission says, because nothing it posts is shown. */
    @PluginMethod
    public void status(PluginCall call) {
        boolean enabled = notificationsEnabled();
        String word = permissionWord();
        String token;
        if ("unsupported".equals(word)) {
            token = enabled ? "granted" : "denied";
        } else if ("granted".equals(word)) {
            token = enabled ? "granted" : "denied";
        } else {
            token = word;
        }
        JSObject result = new JSObject();
        result.put("status", token);
        result.put("granted", "granted".equals(token));
        call.resolve(result);
    }

    /** Enqueue the six-hour WorkManager chain; a chain already there is kept, not restarted. */
    @PluginMethod
    public void scheduleRefresh(PluginCall call) {
        try {
            AlertsWorker.schedule(getContext());
            JSObject result = new JSObject();
            result.put("periodic", true);
            result.put("intervalMs", AlertRules.CHECK_INTERVAL_MS);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("ForayNotify.scheduleRefresh failed: " + e.getClass().getSimpleName());
        }
    }

    @PluginMethod
    public void notifyNow(PluginCall call) {
        String showId = call.getString("showId");
        if (showId == null || showId.isEmpty()) {
            call.reject("showId is required");
            return;
        }
        AlertPoster.post(getContext(), orEmpty(call.getString("title")), orEmpty(call.getString("body")), showId);
        call.resolve();
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }

    // ── the tap ───────────────────────────────────────────────────────────────

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        consumeAlertIntent(intent);
    }

    /** Read a tap out of an intent once: emit it, then strip the extras. */
    void consumeAlertIntent(Intent intent) {
        if (intent == null) return;
        String showId = AlertRules.showIdFromExtras(
            intent.getStringExtra(AlertRules.EXTRA_MARKER), intent.getStringExtra(AlertRules.EXTRA_SHOW_ID));
        if (showId == null) return;
        intent.removeExtra(AlertRules.EXTRA_MARKER);
        intent.removeExtra(AlertRules.EXTRA_SHOW_ID);
        emitAlertOpened(showId);
    }

    /** {@code alertOpened { showId }} now, or held until a listener attaches; the last tap wins. */
    void emitAlertOpened(String showId) {
        if (hasListeners(AlertRules.EVENT_ALERT_OPENED)) {
            notifyListeners(AlertRules.EVENT_ALERT_OPENED, payload(showId));
        } else {
            heldShowId = showId;
        }
    }

    private static JSObject payload(String showId) {
        JSObject data = new JSObject();
        data.put("showId", showId);
        return data;
    }

    /** Capacitor's {@code addListener}, then the held tap, if any, to the new listener. */
    @Override
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void addListener(PluginCall call) {
        super.addListener(call);
        if (AlertRules.EVENT_ALERT_OPENED.equals(call.getString("eventName")) && heldShowId != null
                && hasListeners(AlertRules.EVENT_ALERT_OPENED)) {
            String showId = heldShowId;
            heldShowId = null;
            notifyListeners(AlertRules.EVENT_ALERT_OPENED, payload(showId));
        }
    }

    // ── permission words ──────────────────────────────────────────────────────

    /** Whether a notification we post would actually be SHOWN (permission and the app's switch). */
    private boolean notificationsEnabled() {
        try {
            Context context = getContext();
            return context != null && NotificationManagerCompat.from(context).areNotificationsEnabled();
        } catch (Exception e) {
            return false;
        }
    }

    /** Capacitor's {@code PermissionState} word, or {@code "unsupported"} below API 33. */
    private String permissionWord() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "unsupported";
        try {
            return getPermissionState(NOTIFICATIONS).toString();
        } catch (Exception e) {
            return "unsupported";
        }
    }
}

package ai.jwlabs.foura.notify;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * Posts one alert. Shared by the plugin's {@code notifyNow} and the background
 * refresh, so there is one shape of notification (iOS: {@code AlertPoster}).
 *
 * <p>THE CHANNEL is {@link AlertRules#CHANNEL_ID} ("New episodes"), created on the
 * first post and never at launch, so a listener who never turns alerts on never
 * sees an empty channel in the app's settings.
 *
 * <p>THE TAP opens the app's own launcher activity with two extras, the marker
 * that says the launch is one of OUR alerts and the {@code showId}; the plugin
 * reads them on a cold start ({@code load}) and on a warm one
 * ({@code handleOnNewIntent}) and emits {@code alertOpened { showId }}. No
 * {@code data} URI on the intent on purpose: {@code @capacitor/app} turns any
 * intent data into an {@code appUrlOpen} event, and this is not a link.
 *
 * <p>Posting asks for nothing: on Android 13+ a device that has not granted
 * {@code POST_NOTIFICATIONS} drops the post, silently, as iOS does.
 */
public final class AlertPoster {
    private AlertPoster() {}

    /** Create (or update, which is what a second call does) the alerts channel. */
    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            AlertRules.CHANNEL_ID, AlertRules.CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT);
        manager.createNotificationChannel(channel);
    }

    /** The launch intent a tap fires: the app's launcher activity, carrying the show. */
    static Intent tapIntent(Context context, String showId) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) launch = new Intent(Intent.ACTION_MAIN).setPackage(context.getPackageName());
        /* CLEAR_TOP | SINGLE_TOP: a running app gets the tap as onNewIntent on the
           activity it already has (the plugin's handleOnNewIntent), never a second
           WebView. */
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launch.putExtra(AlertRules.EXTRA_MARKER, AlertRules.EXTRA_MARKER_VALUE);
        launch.putExtra(AlertRules.EXTRA_SHOW_ID, showId);
        return launch;
    }

    /** The request code is per show: PendingIntents that differ only in extras are
     *  the SAME PendingIntent, so one code for all would make every alert open the
     *  show of the last one posted. */
    static int requestCode(String showId) {
        return AlertRules.notificationTag(showId).hashCode();
    }

    /** Hand one alert to the system now. Never throws. */
    public static void post(Context context, String title, String body, String showId) {
        try {
            ensureChannel(context);
            PendingIntent tap = PendingIntent.getActivity(context, requestCode(showId), tapIntent(context, showId),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, AlertRules.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(AlertRules.notificationTag(showId), 0, builder.build());
        } catch (RuntimeException e) {
            // a denied permission or a missing service drops the alert, as on iOS
        }
    }
}

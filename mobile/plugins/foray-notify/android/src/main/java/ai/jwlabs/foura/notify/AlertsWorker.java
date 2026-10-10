package ai.jwlabs.foura.notify;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/**
 * The periodic check (issue #761; docs/roadmap/player-features.md PQ-29): every
 * six hours, only on a connected network, one {@link AlertsRefresh} pass. The
 * Android twin of iOS's {@code BGAppRefreshTask}.
 *
 * <p>REGISTERED ONCE. {@link #schedule(Context)} enqueues UNIQUE periodic work
 * named {@link AlertRules#WORK_NAME} with {@code KEEP}: calling it again (every
 * launch, every time a show's alerts are turned on) keeps the chain already
 * there instead of stacking a second one or restarting its clock. WorkManager
 * persists the chain across reboots and app updates on its own.
 *
 * <p>Six hours is {@code CHECK_INTERVAL_MS}; the pass itself still asks
 * {@code dueForCheck} per show, so a run that lands early (or the page's own
 * check an hour ago) never re-checks a show sooner than the page would.
 *
 * <p>The pass always reports success: a failed request leaves that show's record
 * untouched (still due), so the next period retries it; {@code retry()} would
 * only stack WorkManager's backoff on top of the period.
 */
public final class AlertsWorker extends Worker {

    public AlertsWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            AlertsRefresh.forContext(getApplicationContext()).run();
        } catch (RuntimeException e) {
            // one bad pass must not end the chain; the next period runs again
        }
        return Result.success();
    }

    /** The periodic request: every {@code CHECK_INTERVAL_MS}, on a connected network. */
    static PeriodicWorkRequest request() {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        return new PeriodicWorkRequest.Builder(AlertsWorker.class, AlertRules.CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
            .setConstraints(constraints)
            .build();
    }

    /** Enqueue the chain once; a second call keeps the first. */
    public static void schedule(Context context) {
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(AlertRules.WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request());
    }
}

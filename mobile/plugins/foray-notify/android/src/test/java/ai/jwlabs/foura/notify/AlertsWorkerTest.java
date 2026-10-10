package ai.jwlabs.foura.notify;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.test.core.app.ApplicationProvider;
import androidx.work.Configuration;
import androidx.work.ListenableWorker;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import androidx.work.testing.SynchronousExecutor;
import androidx.work.testing.TestWorkerBuilder;
import androidx.work.testing.WorkManagerTestInitHelper;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;

/**
 * The WorkManager chain (issue #761; PQ-29): every six hours, on a connected
 * network, enqueued ONCE however often {@code scheduleRefresh} is called, and a
 * run that finds nothing to check succeeds without touching anything.
 * WorkManager's own test artifact supplies a synchronous WorkManager.
 *
 * <p>Each test names the one-line mutation it exists to catch.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AlertsWorkerTest {

    private Context app;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        Configuration config = new Configuration.Builder().setExecutor(new SynchronousExecutor()).build();
        WorkManagerTestInitHelper.initializeTestWorkManager(app, config);
        AlertsRefresh.pageStore(app).edit().clear().commit();
        AlertsRefresh.ledgerStore(app).edit().clear().commit();
    }

    private List<WorkInfo> live() throws Exception {
        List<WorkInfo> out = new ArrayList<>();
        for (WorkInfo info : WorkManager.getInstance(app).getWorkInfosForUniqueWork(AlertRules.WORK_NAME).get()) {
            if (info.getState() != WorkInfo.State.CANCELLED) out.add(info);
        }
        return out;
    }

    /** The request: periodic at {@code CHECK_INTERVAL_MS}, only on a connected network.
     *  MUTATION: {@code NetworkType.CONNECTED} -> {@code NetworkType.NOT_REQUIRED}.
     *  MUTATION 2: the period {@code CHECK_INTERVAL_MS} -> {@code CHECK_INTERVAL_MS / 2}. */
    @Test
    public void theRequestIsSixHourlyOnAConnectedNetwork() {
        PeriodicWorkRequest request = AlertsWorker.request();
        assertEquals(6L * 3600 * 1000, request.getWorkSpec().intervalDuration);
        assertEquals(NetworkType.CONNECTED, request.getWorkSpec().constraints.getRequiredNetworkType());
        assertEquals(AlertsWorker.class.getName(), request.getWorkSpec().workerClassName);
    }

    /** Registered once: a second {@code schedule} keeps the first chain, same id.
     *  MUTATION: {@code ExistingPeriodicWorkPolicy.KEEP} -> {@code CANCEL_AND_REENQUEUE}
     *  (a new id every call, and the six-hour clock restarts on every launch). */
    @Test
    public void theChainIsEnqueuedOnceHoweverOftenItIsScheduled() throws Exception {
        AlertsWorker.schedule(app);
        List<WorkInfo> first = live();
        assertEquals(1, first.size());
        UUID id = first.get(0).getId();
        AlertsWorker.schedule(app);
        AlertsWorker.schedule(app);
        List<WorkInfo> after = live();
        assertEquals(1, after.size());
        assertEquals(id, after.get(0).getId());
        assertEquals(WorkInfo.State.ENQUEUED, after.get(0).getState());
    }

    /** A run with nothing followed succeeds, posts nothing and writes no row.
     *  MUTATION: {@code Result.success()} -> {@code Result.retry()} in {@code doWork}. */
    @Test
    public void aRunWithNothingFollowedSucceedsAndWritesNothing() {
        AlertsWorker worker = TestWorkerBuilder.from(app, AlertsWorker.class, Executors.newSingleThreadExecutor()).build();
        ListenableWorker.Result result = worker.doWork();
        assertEquals(ListenableWorker.Result.success(), result);
        SharedPreferences page = AlertsRefresh.pageStore(app);
        assertNull(page.getString(AlertRules.STARRED_SHOWS_KEY, null));
    }
}

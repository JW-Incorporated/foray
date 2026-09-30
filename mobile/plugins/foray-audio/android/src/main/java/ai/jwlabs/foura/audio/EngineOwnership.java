package ai.jwlabs.foura.audio;

import ai.jwlabs.foura.audio.engine.EngineBridge;
import ai.jwlabs.foura.audio.engine.EngineLane;
import ai.jwlabs.foura.audio.engine.EngineLog;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.content.ContextCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * WHO PLAYS THIS PROCESS on Android (card A-28, docs/plans/android-assessment.md §5.4): the
 * bridge's {@link EngineBridge.Owner}, one per process, on main. The Android counterpart of the
 * iOS {@code EngineOwnership} (NE-17), cut to what A-28 needs:
 * <ul>
 *   <li>the lane, decided ONCE per process from the build's default and the Developer engine
 *       setting ({@link EngineLane}); the crash-loop sentinel and the hello watchdog are A-29's;</li>
 *   <li>in the native lane, the engine: {@link ForayPlaybackService}, bound with a
 *       {@link MediaController} (the Media3 way; the service is created bound, and Media3 promotes
 *       it to the foreground when it plays). The binding is held for the life of the process, so
 *       the engine outlives a hidden page, and a bridge call waits for it
 *       ({@link #whenReady});</li>
 *   <li>the Developer setting, stored for the next launch;</li>
 *   <li>the one-way relinquish: the core goes terminal, the binding is released and the service
 *       stopped, so the legacy {@code PlaybackKeepAliveService} is the only session again. The
 *       torn-down host is remembered, so the bridge keeps answering {@code relinquished} and a
 *       later hello {@code downgrade}.</li>
 * </ul>
 */
@OptIn(markerClass = UnstableApi.class)
final class EngineOwnership implements EngineBridge.Owner {
    private static final String TAG = "ForayEngine.owner";
    /** How long a bridge call waits for the service before it is answered without one. */
    static final long CONNECT_TIMEOUT_MS = 3000;

    @Nullable private static EngineOwnership shared;

    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    @Nullable private EngineBridge.Decision decided;
    @Nullable private MediaController controller;
    @Nullable private ListenableFuture<MediaController> connecting;
    private final List<Runnable> waiting = new ArrayList<>();
    private boolean connectFailed;
    /** The host this process's engine ran on, kept after a relinquish tore it down. */
    @Nullable private ForayEngineHost lastHost;
    private boolean relinquished;

    private EngineOwnership(Context context) {
        app = context.getApplicationContext();
    }

    /** The process's owner. Main thread. */
    static EngineOwnership shared(@NonNull Context context) {
        if (shared == null) shared = new EngineOwnership(context);
        return shared;
    }

    private SharedPreferences prefs() {
        return app.getSharedPreferences(EngineLane.PREFS, Context.MODE_PRIVATE);
    }

    // ---- EngineBridge.Owner

    @Override
    public EngineBridge.Decision decideOnce() {
        if (decided == null) {
            String raw = null;
            try {
                raw = prefs().getString(EngineLane.OVERRIDE_KEY, null);
            } catch (RuntimeException e) {
                Log.w(TAG, "could not read the engine setting; the build's default decides", e);
            }
            decided = EngineLane.decide(EngineLane.BUILD_DEFAULT_NATIVE, raw);
            Log.i(TAG, "ForayEngine.owner mode=" + decided.mode() + " reason=" + decided.reason().token);
        }
        return decided;
    }

    @Nullable
    @Override
    public ForayEngineHost engine() {
        ForayPlaybackService service = ForayPlaybackService.current();
        ForayEngineHost host = service == null ? null : service.host();
        if (host != null) lastHost = host;
        return host != null ? host : lastHost;
    }

    @Override
    public void helloReceived() {
        // The hello watchdog (a page that never says hello gives the audio back) is A-29's.
    }

    @Override
    public void setModeOverride(String mode) {
        try {
            prefs().edit().putString(EngineLane.OVERRIDE_KEY, EngineLane.storedOverride(mode)).commit();
        } catch (RuntimeException e) {
            Log.w(TAG, "could not store the engine setting", e);
        }
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("kind", JsonNode.str("set-override")));
        fields.add(JsonNode.member("override", JsonNode.str(EngineLane.storedOverride(mode))));
        if (engine() != null) EngineLog.process().diag(new EngineCommand.DiagEntry("mode", fields));
        Log.i(TAG, "ForayEngine.owner set-override=" + EngineLane.storedOverride(mode));
    }

    @Override
    public ForayEngineHost.Verdict relinquish(EngineContract.RelinquishCap cap, Vocabulary.Source source) {
        ForayEngineHost host = engine();
        if (host == null || host.isTornDown()) {
            return new ForayEngineHost.Verdict(Collections.singletonList(EngineContract.Refusal.RELINQUISHED.token), false);
        }
        ForayEngineHost.Verdict verdict = host.handle(new EngineInput.Command(new EngineContract.Command.Relinquish(cap), source));
        // Queued behind a turn in progress: the host tears down when the core gets to it.
        if (!verdict.deferred()) host.teardown();
        handOver();
        return verdict;
    }

    /**
     * The process belongs to the legacy lane from here: the binding is released and the service
     * stopped (its session and notification with it), so the legacy service may start and is the
     * only media session. Posted, so the answer to the relinquish leaves first.
     */
    private void handOver() {
        if (relinquished) return;
        relinquished = true;
        main.post(() -> {
            MediaController c = controller;
            controller = null;
            try {
                if (c != null) c.release();
            } catch (RuntimeException e) {
                Log.w(TAG, "releasing the engine's controller failed", e);
            }
            try {
                app.stopService(new Intent(app, ForayPlaybackService.class));
            } catch (RuntimeException e) {
                Log.w(TAG, "stopping the engine's service failed", e);
            }
        });
    }

    // ---- the service

    /**
     * Run {@code then} once a bridge call can be answered: at once in the legacy lane, after a
     * relinquish, or when the service is already hosting; otherwise once the service is bound, or
     * after {@link #CONNECT_TIMEOUT_MS} without it (the hello then says {@code not-built}, and the
     * page runs its own player). Main thread.
     */
    void whenReady(@NonNull Runnable then) {
        if (!decideOnce().isNative() || relinquished || connectFailed
                || (controller != null && ForayPlaybackService.current() != null)) {
            then.run();
            return;
        }
        waiting.add(then);
        if (connecting != null) return;
        try {
            SessionToken token = new SessionToken(app, new ComponentName(app, ForayPlaybackService.class));
            ListenableFuture<MediaController> future = new MediaController.Builder(app, token).buildAsync();
            connecting = future;
            future.addListener(() -> {
                try {
                    controller = future.get();
                    decidedRow();
                } catch (Exception e) {
                    Log.w(TAG, "could not bind ForayPlaybackService; this process runs the page's player", e);
                    connectFailed = true;
                }
                flush();
            }, ContextCompat.getMainExecutor(app));
        } catch (RuntimeException e) {
            Log.w(TAG, "could not start binding ForayPlaybackService", e);
            connectFailed = true;
            flush();
            return;
        }
        main.postDelayed(() -> {
            if (controller == null && !waiting.isEmpty()) {
                Log.w(TAG, "ForayPlaybackService did not bind in " + CONNECT_TIMEOUT_MS + " ms");
                connectFailed = true;
                flush();
            }
        }, CONNECT_TIMEOUT_MS);
    }

    private void flush() {
        List<Runnable> run = new ArrayList<>(waiting);
        waiting.clear();
        for (Runnable r : run) {
            try {
                r.run();
            } catch (RuntimeException e) {
                Log.w(TAG, "a bridge call failed after the service bound", e);
            }
        }
    }

    /** The lane's decision, as the ring's {@code mode} row (the Copy header reads it), once the engine exists. */
    private void decidedRow() {
        EngineBridge.Decision d = decideOnce();
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("kind", JsonNode.str("decide")));
        fields.add(JsonNode.member("mode", JsonNode.str(d.mode())));
        fields.add(JsonNode.member("reason", JsonNode.str(d.reason().token)));
        fields.add(JsonNode.member("build", JsonNode.str(ForayPlaybackService.buildName(app))));
        EngineLog.process().diag(new EngineCommand.DiagEntry("mode", fields));
    }
}

package ai.jwlabs.foura.audio;

import ai.jwlabs.foura.audio.engine.EngineBridge;
import ai.jwlabs.foura.audio.engine.EngineFaults;
import ai.jwlabs.foura.audio.engine.EngineLane;
import ai.jwlabs.foura.audio.engine.EngineLog;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.audio.engine.HandlerTiming;
import ai.jwlabs.foura.audio.engine.OwnershipCore;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineMode;
import ai.jwlabs.foura.engine.Vocabulary;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.content.ContextCompat;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * WHO PLAYS THIS PROCESS on Android (cards A-28 and A-29, docs/plans/android-assessment.md §5.4):
 * the bridge's {@link EngineBridge.Owner}, one per process, on main. The Android counterpart of the
 * iOS {@code EngineOwnership} (NE-17). Every rule is {@link OwnershipCore}'s (pure JVM, tested
 * whole); this class moves values in and out of it and does what only Android can:
 * <ul>
 *   <li>the lane, decided ONCE per process ({@link OwnershipCore#decideOnce}, A-29): the build's
 *       default, the Developer engine setting, and the crash-loop sentinel and strikes, over the
 *       engine-private keys in the {@code ForayEngine} SharedPreferences file (iOS's key names),
 *       a sticky pin pinned to the build's versionCode. Whichever entry point runs first decides:
 *       the plugin's {@code load()} ({@link #launched}) or a bridge call;</li>
 *   <li>in the native lane, the engine: {@link ForayPlaybackService}, bound with a
 *       {@link MediaController} as soon as the lane is decided at a launch (the Media3 way; the
 *       service is created bound, and Media3 promotes it to the foreground when it plays). The
 *       binding is held for the life of the process, so the engine outlives a hidden page, and a
 *       bridge call waits for it ({@link #whenReady});</li>
 *   <li>the healthy markers, the hello watchdog and the page-health strike (A-29), on the main
 *       looper's timing;</li>
 *   <li>the Developer setting, stored for the next launch;</li>
 *   <li>the one-way relinquish: the core goes terminal, the binding is released and the service
 *       stopped, so the legacy {@code PlaybackKeepAliveService} is the only session again. The
 *       torn-down host is remembered, so the bridge keeps answering {@code relinquished} and a
 *       later hello {@code downgrade}. A fault while answering the hello takes the same path
 *       (A-29): the page runs its own player, never silence.</li>
 * </ul>
 */
@OptIn(markerClass = UnstableApi.class)
final class EngineOwnership implements EngineBridge.Owner {
    private static final String TAG = "ForayEngine.owner";
    /** How long a bridge call waits for the service before it is answered without one. */
    static final long CONNECT_TIMEOUT_MS = 3000;
    /**
     * The debug-only fault the emulator's fallback scenario arms ({@link EngineFaults}). Written
     * only by the debug build's {@code EngineDriveReceiver}, and read only when the app is
     * debuggable.
     */
    static final String DEBUG_FAULT_KEY = "ForayEngine.debugFault";

    @Nullable private static EngineOwnership shared;

    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OwnershipCore core;
    @Nullable private MediaController controller;
    @Nullable private ListenableFuture<MediaController> connecting;
    private final List<Runnable> waiting = new ArrayList<>();
    private boolean connectFailed;
    /** The host this process's engine ran on, kept after a relinquish tore it down. */
    @Nullable private ForayEngineHost lastHost;
    private boolean handedOver;
    private boolean decidedLogged;

    private EngineOwnership(Context context) {
        app = context.getApplicationContext();
        core = new OwnershipCore(new PrefsKeys(), launchOf(app), new HandlerTiming(Looper.getMainLooper()),
                entry -> EngineLog.process().diag(entry), new OwnershipCore.Platform() {
                    @Override
                    public ForayEngineHost engine() {
                        return EngineOwnership.this.engine();
                    }

                    @Override
                    public void handOver() {
                        EngineOwnership.this.handOver();
                    }
                });
    }

    /** The process's owner. Main thread. */
    static EngineOwnership shared(@NonNull Context context) {
        if (shared == null) shared = new EngineOwnership(context);
        return shared;
    }

    /**
     * Whether this process's lane is the native engine's (A-27 review), asked by the doors that
     * are not a launch: {@link ForayMediaButtonReceiver} before it starts the service for a car's
     * PLAY, and {@link ForayPlaybackService} before it answers a media button start or switches
     * the receiver on. The process's own decision when it made one (and not after a relinquish);
     * otherwise the one {@link OwnershipCore#decideOnce} WOULD make from the stored keys, read and
     * never written ({@link OwnershipCore#peekDecision}), so a press counts no strike and a
     * process a car started decides nothing for the page that may load in it later.
     *
     * <p>WHY. The restore record outlives the lane. A listener who set the Developer engine back
     * to Automatic, or a build the crash-loop guard pinned to the JS lane, still has the record
     * the native engine wrote; without this a car's PLAY would boot the native engine from it in
     * a process whose lane is the page's player. On iOS the cold path is the native lane's alone.
     * Main thread; never throws (false when the keys cannot be read).
     */
    static boolean engineLane(@NonNull Context context) {
        try {
            Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
            EngineOwnership owner = shared;
            if (owner != null && owner.app == app) {
                return !owner.core.isRelinquished() && owner.core.peekDecision().isNative();
            }
            SharedPreferences prefs = app.getSharedPreferences(EngineLane.PREFS, Context.MODE_PRIVATE);
            EngineMode.Stored stored = OwnershipCore.stored(new OwnershipCore.Keys() {
                @Override
                public String get(String key) {
                    return prefs.getString(key, null);
                }

                @Override
                public void put(String key, String value) {
                    throw new UnsupportedOperationException("the lane is only read here");
                }
            });
            return OwnershipCore.wouldDecide(stored, launchOf(app)).isNative();
        } catch (RuntimeException e) {
            Log.w(TAG, "could not read the lane; the engine answers no press", e);
            return false;
        }
    }

    private SharedPreferences prefs() {
        return app.getSharedPreferences(EngineLane.PREFS, Context.MODE_PRIVATE);
    }

    /** The engine-private keys: synchronous ({@code commit}), so a strike cannot be lost to a crash a moment later. */
    private final class PrefsKeys implements OwnershipCore.Keys {
        @Override
        public String get(String key) {
            return prefs().getString(key, null);
        }

        @Override
        public void put(String key, String value) {
            SharedPreferences.Editor e = prefs().edit();
            if (value == null) e.remove(key);
            else e.putString(key, value);
            e.commit();
        }
    }

    /** The launch's inputs: the build's default (mobile/ENGINE_DEFAULT.json, pinned in EngineLane) and its versionCode. */
    private static OwnershipCore.Launch launchOf(Context app) {
        String build = "";
        try {
            PackageInfo info = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            build = Long.toString(PackageInfoCompat.getLongVersionCode(info));
        } catch (Exception e) {
            Log.w(TAG, "could not read the build's versionCode; a sticky pin has nothing to pin to", e);
        }
        return new OwnershipCore.Launch(EngineLane.BUILD_DEFAULT_NATIVE ? EngineMode.BuildDefault.NATIVE : EngineMode.BuildDefault.JS,
                build, UUID.randomUUID().toString(), true);
    }

    private boolean debuggable() {
        return (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /**
     * The plugin loaded, which is a new Activity and so a new page (main thread): decide, boot the
     * engine in the native lane, and arm the page's hello watchdog. The decision is once per
     * process; the page's watchdog is once per Activity.
     */
    void launched() {
        decideOnce();
        if (core.isNative() && !core.isRelinquished()) {
            whenReady(() -> { });
            core.pageLoaded(true);
        }
    }

    /** The Activity paused: the resign-or-background healthy marker. Main thread. */
    void backgrounded() {
        core.backgrounded();
    }

    // ---- EngineBridge.Owner

    @Override
    public EngineBridge.Decision decideOnce() {
        if (!decidedLogged) {
            decidedLogged = true;
            if (debuggable()) {
                // The emulator's mutation (A-29). A release build is never debuggable, and nothing
                // in it writes the key.
                try {
                    EngineFaults.arm(prefs().getString(DEBUG_FAULT_KEY, null));
                } catch (RuntimeException e) {
                    Log.w(TAG, "could not read the debug fault", e);
                }
                if (EngineFaults.armed() != null) Log.w(TAG, "ForayEngine.owner DEBUG fault armed: " + EngineFaults.armed());
            }
            EngineMode.Stored before = core.stored();
            EngineMode.Decision d = core.decideOnce();
            Log.i(TAG, "ForayEngine.owner mode=" + d.mode().token + " reason=" + d.reason().token + " strikes=" + d.strikes()
                    + " sentinelWasSet=" + (before.sentinel() ? "y" : "n") + " sticky=" + d.stickyLegacyBuild());
            if (!d.isNative()) {
                /* A-27 review: a JS-lane process switches the media button receiver off before its
                   own session is built (the page's first play), because Media3 hands an enabled
                   manifest receiver to every session the app builds. An earlier native process
                   may have left it on, with a record behind it. */
                ForayMediaButtonReceiver.setEnabled(app, false);
            }
        }
        return core.laneDecision();
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
        core.helloReceived();
    }

    @Override
    public void engineTurned() {
        core.engineTurned();
    }

    @Override
    public void engineFaulted(String at, RuntimeException error) {
        Log.w(TAG, "ForayEngine.owner fault at=" + at + "; the process goes back to the page's player", error);
        core.engineFaulted(at, error);
    }

    @Override
    public void setModeOverride(String mode) {
        try {
            core.setModeOverride(mode);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not store the engine setting", e);
        }
        Log.i(TAG, "ForayEngine.owner set-override=" + EngineLane.storedOverride(mode));
    }

    @Override
    public ForayEngineHost.Verdict relinquish(EngineContract.RelinquishCap cap, Vocabulary.Source source) {
        ForayEngineHost.Verdict verdict = core.relinquish(cap, source);
        Log.i(TAG, "ForayEngine.owner relinquish cap=" + cap.token + " source=" + source.token + " failures=" + verdict.failures());
        return verdict;
    }

    /**
     * The process belongs to the legacy lane from here: the binding is released and the service
     * stopped (its session and notification with it), so the legacy service may start and is the
     * only media session. Posted, so the answer to the relinquish leaves first.
     */
    private void handOver() {
        if (handedOver) return;
        handedOver = true;
        main.post(() -> {
            MediaController c = controller;
            controller = null;
            if (c != null) releaseQuietly(c);
            stopServiceQuietly();
        });
    }

    // ---- the service

    /**
     * Run {@code then} once a bridge call can be answered: at once in the legacy lane, after a
     * relinquish, after the binding failed, or once the binding exists; otherwise once the service
     * is bound, or after {@link #CONNECT_TIMEOUT_MS} without it (the hello then says
     * {@code not-built}, and the page runs its own player). Main thread.
     *
     * <p>EVERY CALL IS ANSWERED. Once the controller is connected the call runs at once, even if
     * the service is gone by then (its host was torn down with it: the bridge answers from the
     * owner's record, {@code relinquished} / {@code downgrade}). Waiting on the service there
     * would park the call behind a connection that already happened, and the plugin's promise
     * would never resolve.
     *
     * <p>A LATE BINDING IS UNDONE. When the timeout answered first, the page was told there is no
     * engine and runs its own player; a binding that completes after that is released and the
     * service stopped, so the process never holds a second media session beside the legacy one.
     */
    void whenReady(@NonNull Runnable then) {
        if (!decideOnce().isNative() || core.isRelinquished() || connectFailed || controller != null) {
            then.run();
            return;
        }
        waiting.add(then);
        if (connecting != null) return;
        final ListenableFuture<MediaController> future;
        try {
            SessionToken token = new SessionToken(app, new ComponentName(app, ForayPlaybackService.class));
            future = new MediaController.Builder(app, token).buildAsync();
        } catch (RuntimeException e) {
            Log.w(TAG, "could not start binding ForayPlaybackService", e);
            connectFailed = true;
            flush();
            return;
        }
        connecting = future;
        future.addListener(() -> {
            MediaController bound = null;
            try {
                bound = future.get();
            } catch (Exception e) {
                if (!connectFailed) Log.w(TAG, "could not bind ForayPlaybackService; this process runs the page's player", e);
            }
            if (bound != null && (connectFailed || core.isRelinquished())) {
                // Too late: the page was already answered without the engine (or gave it back).
                Log.w(TAG, "ForayPlaybackService bound after the page was answered; releasing it");
                releaseQuietly(bound);
                stopServiceQuietly();
                bound = null;
            }
            if (bound != null) {
                controller = bound;
                /* A-27, NE-24's order: the engine boots from its restore record BEFORE the page's
                   first bridge call is answered, so the hello's snapshot carries the restored
                   queue and the page drains the pending events a process death left. Once per
                   service, and a no-op after any input. */
                ForayPlaybackService service = ForayPlaybackService.current();
                if (service != null) service.restoreIfCold();
                // The engine exists: the healthy marker's run-loop leg starts now (A-29).
                core.engineBooted();
            } else {
                connectFailed = true;
            }
            flush();
        }, ContextCompat.getMainExecutor(app));
        main.postDelayed(() -> {
            if (controller == null && !connectFailed) {
                Log.w(TAG, "ForayPlaybackService did not bind in " + CONNECT_TIMEOUT_MS + " ms");
                connectFailed = true;
                // Cancels a binding still in flight, or releases one that completed unseen.
                MediaController.releaseFuture(future);
                stopServiceQuietly();
                flush();
            }
        }, CONNECT_TIMEOUT_MS);
    }

    private static void releaseQuietly(MediaController c) {
        try {
            c.release();
        } catch (RuntimeException e) {
            Log.w(TAG, "releasing the engine's controller failed", e);
        }
    }

    private void stopServiceQuietly() {
        try {
            app.stopService(new Intent(app, ForayPlaybackService.class));
        } catch (RuntimeException e) {
            Log.w(TAG, "stopping the engine's service failed", e);
        }
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
}

package ai.jwlabs.foura.audio;

import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.Vocabulary;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import android.util.Log;
import androidx.annotation.OptIn;
import androidx.core.content.ContextCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.google.common.util.concurrent.ListenableFuture;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * DEBUG BUILDS ONLY (src/debug; a release build does not contain this class or its manifest
 * entry). The native-mode leg of {@code android-playback.yml} (card A-26) drives the native engine
 * with it over adb, because the page cannot reach the engine until A-28's bridge:
 *
 * <pre>
 *   adb shell am broadcast -n ai.jwlabs.foura/ai.jwlabs.foura.audio.EngineDriveReceiver \
 *       --es cmd load --es queue &lt;base64 JSON array of items&gt; --ei index 0
 *   adb shell am broadcast -n … --es cmd pause|play|next|previous
 *   adb shell am broadcast -n … --es cmd task-removed
 * </pre>
 *
 * <p>{@code task-removed} (A-27) is the listener swiping 4a away, as the service hears it: the
 * driver lets go of its binding and hands the service {@code onTaskRemoved}, Media3's own
 * default (a paused player is paused and the service stops itself). Scenario (j) then ends the
 * process and presses play, the device check "Bluetooth car play after swiping the app away".
 *
 * It binds {@code ForayPlaybackService} with a {@link MediaController}, the way a client of a
 * Media3 session service does (A-28's bridge will too), keeps that controller for the life of
 * the process so the service stays bound, and hands the engine one input as a listener's TAP
 * would (a queue load and a play of its index, or a transport command). The answer is the
 * broadcast's result data: {@code {"ok":…,"failures":[…]}}, which {@code am broadcast} prints.
 *
 * <p>It decides nothing and bypasses nothing: every input goes through
 * {@code ForayEngineHost.handle}, so the audible-start invariant, the session and the deck are
 * exactly the ones a real client would get.
 */
@OptIn(markerClass = UnstableApi.class)
public final class EngineDriveReceiver extends BroadcastReceiver {
    private static final String TAG = "ForayEngine.drive";
    /** Held for the process's life: the binding that keeps the service alive between broadcasts. */
    private static MediaController controller;
    private static ListenableFuture<MediaController> connecting;

    @Override
    public void onReceive(Context context, Intent intent) {
        PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        Runnable drive = () -> {
            String answer;
            try {
                answer = run(intent);
            } catch (RuntimeException e) {
                answer = "{\"ok\":false,\"failures\":[" + JSWriter.quote("exception:" + e.getClass().getSimpleName()) + "]}";
                Log.w(TAG, "drive failed", e);
            }
            Log.i(TAG, "cmd=" + intent.getStringExtra("cmd") + " " + answer);
            pending.setResultCode(1);
            pending.setResultData(answer);
            pending.finish();
        };
        if (controller != null && controller.isConnected() && ForayPlaybackService.current() != null) {
            drive.run();
            return;
        }
        if (connecting == null) {
            SessionToken token = new SessionToken(app, new ComponentName(app, ForayPlaybackService.class));
            connecting = new MediaController.Builder(app, token).buildAsync();
        }
        ListenableFuture<MediaController> future = connecting;
        future.addListener(() -> {
            try {
                controller = future.get();
            } catch (Exception e) {
                Log.w(TAG, "could not connect to ForayPlaybackService", e);
                connecting = null;
            }
            drive.run();
        }, ContextCompat.getMainExecutor(app));
    }

    /** One input, on main. */
    private static String run(Intent intent) {
        ForayPlaybackService service = ForayPlaybackService.current();
        if (service == null) return "{\"ok\":false,\"failures\":[\"no-service\"]}";
        String cmd = intent.getStringExtra("cmd");
        if (cmd == null) cmd = "";
        List<ForayEngineHost.Verdict> verdicts = new ArrayList<>();
        switch (cmd) {
            case "load" -> {
                String b64 = intent.getStringExtra("queue");
                if (b64 == null) return "{\"ok\":false,\"failures\":[\"no-queue\"]}";
                String json = new String(Base64.decode(b64, Base64.DEFAULT), StandardCharsets.UTF_8);
                List<EngineItem> items = ForayPlaybackService.items(json);
                verdicts.add(service.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(items))));
                if (intent.getBooleanExtra("play", true)) {
                    int index = intent.getIntExtra("index", 0);
                    verdicts.add(service.handle(new EngineInput.Queue(
                            new EngineInput.QueueInput.PlayIndex(index, null, Vocabulary.Source.TAP))));
                }
            }
            case "play" -> verdicts.add(tap(service, new EngineContract.Command.Play()));
            case "pause" -> verdicts.add(tap(service, new EngineContract.Command.Pause()));
            case "next" -> verdicts.add(tap(service, new EngineContract.Command.Next()));
            case "previous" -> verdicts.add(tap(service, new EngineContract.Command.Previous()));
            case "task-removed" -> {
                // Let go of the binding first: a bound service outlives its own stopSelf.
                MediaController held = controller;
                controller = null;
                connecting = null;
                if (held != null) held.release();
                service.onTaskRemoved(null);
                return "{\"ok\":true,\"failures\":[]}";
            }
            default -> {
                return "{\"ok\":false,\"failures\":[" + JSWriter.quote("unknown-cmd:" + cmd) + "]}";
            }
        }
        List<String> failures = new ArrayList<>();
        for (ForayEngineHost.Verdict v : verdicts) {
            if (v == null) failures.add("no-engine");
            else failures.addAll(v.failures());
        }
        StringBuilder out = new StringBuilder("{\"ok\":").append(failures.isEmpty()).append(",\"failures\":[");
        for (int i = 0; i < failures.size(); i++) {
            if (i > 0) out.append(',');
            out.append(JSWriter.quote(failures.get(i)));
        }
        return out.append("]}").toString();
    }

    private static ForayEngineHost.Verdict tap(ForayPlaybackService service, EngineContract.Command command) {
        return service.handle(new EngineInput.Command(command, Vocabulary.Source.TAP));
    }
}

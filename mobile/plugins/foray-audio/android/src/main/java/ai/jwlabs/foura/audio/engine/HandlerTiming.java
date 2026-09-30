package ai.jwlabs.foura.audio.engine;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

/**
 * {@link EngineSeams.Timing} on a {@link Handler} (card A-26): wall time from
 * {@code System.currentTimeMillis}, monotonic time from {@code SystemClock.elapsedRealtime}
 * (it keeps counting in deep sleep, which a screen-off span is), and timers posted to the host's
 * looper, so a timer's input is handled on the same thread as every other.
 *
 * <p>A POSTED TIMER IS ON UPTIME, and uptime stops while the CPU sleeps. The engine's timers are
 * the position tick, the pause hold and grace's; each fires while audio plays (a wake lock is
 * held: the deck's wake mode) or measures a span that sleeping would only lengthen, which is why
 * uptime is acceptable here and the load deadline (the deck's own, on the player's clock) is not
 * one of them.
 */
public final class HandlerTiming implements EngineSeams.Timing {
    private final Handler handler;

    public HandlerTiming(Looper looper) {
        handler = new Handler(looper);
    }

    @Override
    public double wallMs() {
        return System.currentTimeMillis();
    }

    @Override
    public double monoMs() {
        return SystemClock.elapsedRealtime();
    }

    @Override
    public EngineSeams.Cancellable schedule(double afterMs, boolean repeating, Runnable fire) {
        long delay = Math.max(0, Math.round(afterMs));
        Runnable[] self = new Runnable[1];
        boolean[] cancelled = new boolean[1];
        self[0] = () -> {
            if (cancelled[0]) return;
            if (repeating) handler.postDelayed(self[0], Math.max(1, delay));
            fire.run();
        };
        handler.postDelayed(self[0], delay);
        return () -> {
            cancelled[0] = true;
            handler.removeCallbacks(self[0]);
        };
    }
}

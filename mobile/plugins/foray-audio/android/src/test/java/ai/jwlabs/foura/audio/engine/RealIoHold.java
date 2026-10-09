package ai.jwlabs.foura.audio.engine;

import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;
import android.net.Uri;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * Keeps the harness's VIRTUAL time still while a REAL thread reads a file.
 *
 * <h2>The race this closes (the android-shell flake)</h2>
 *
 * <p>{@link DeckHarness} runs the player on an auto-advancing {@code FakeClock}: whenever the
 * player's next message is due in the future, the clock jumps there at once. While a load is
 * buffering, ExoPlayer re-schedules its work loop every 10 ms, so virtual time runs as fast as the
 * playback thread can spin, with no relation to real time. But the BYTES come from Media3's
 * {@code Loader} thread, a real thread reading the fixture with real IO ({@code FileDataSource}
 * under {@code DefaultDataSource}), which the fake clock knows nothing about. On a quiet machine
 * the file is read before much virtual time has passed; on a loaded CI runner the loader thread
 * is starved while the main and playback threads spin, and the clock runs through the deck's P-13
 * load deadline (20 s virtual) before the first sample arrives. The deck then detaches the load,
 * {@code ready} can never come, and {@code DeckHarness.await} times out after its 60 s wall bound
 * ({@code TimeoutException} at {@code ExoDeckTest}'s and {@code ExoDeckMeasurementTest}'s
 * awaits). The same race in a smaller dose is the 1x playhead check failing: a load declared
 * READY on 2.5 s of buffer, then the buffer draining in virtual time faster than the loader could
 * refill it (an "AssertionError at ExoDeckTest.java:81").
 *
 * <p>The measurement report from the failing runs shows it directly: {@code readyVirtualMs}, the
 * virtual time a LOCAL FILE took to reach READY, ran from 0 to 15,180 ms across one run's trials
 * (android-build runs 37506425901, 37537560646, 37578008823) when it should be a few work-loop
 * ticks. Earlier patches raised the wall bound to 60 s and moved one load's deadline to 600 s:
 * both change how often the race is lost, not whether it is run.
 *
 * <h2>How the hold works</h2>
 *
 * <p>The FakeClock hands its messages to the real loopers one at a time and advances only when
 * the one it handed over has run. So a REAL message that blocks the playback looper freezes the
 * player's virtual time: the clock's next playback message queues behind it and nothing else
 * fires. This class posts exactly such a message, from the moment Media3 creates a load's data
 * source (on the playback thread, in the same work pass that starts the loader thread) until that
 * source is closed (the loader read the file to its end or gave up). Media3's own progress reports
 * from the loader thread ({@code setSeekMap}, {@code maybeFinishPrepare}, the load's completion)
 * are real posts to the same looper, so they queue behind the hold too: {@code maybeFinishPrepare}
 * cannot close the loader's {@code loadCondition} before the whole file is in, which is what lets
 * the loader thread run to the end without waiting on the frozen player. When the hold lifts, the
 * player finds the file buffered and becomes READY a few virtual ticks after the load began,
 * every time, on any machine.
 *
 * <p>A source that blocks ON PURPOSE ({@link GatedDataSource}, the network that stops answering)
 * is a {@link Participant}: it drives its own {@link Source} span and lets the hold go while it is
 * shut, so the deadline and the stall still fire in virtual time, and takes it back when the gate
 * opens and real bytes flow again.
 *
 * <p>Invariant that makes the hold safe: a {@link Source} is created inside the player's work
 * pass that also starts its loader thread ({@code ProgressiveMediaSource.createPeriod} runs the
 * factory; {@code ProgressiveMediaPeriod.prepare} starts the loader in the same
 * {@code maybeUpdateLoadingPeriod}), and that thread cannot be cancelled while the playback thread
 * is held, so every created source is opened, and every open is followed by a close
 * ({@code ExtractingLoadable.load}'s {@code finally}). {@link #close()} is the backstop at
 * teardown.
 */
@OptIn(markerClass = UnstableApi.class)
final class RealIoHold {
    /** A data source factory that drives its own {@link Source} spans; the harness attaches the hold. */
    interface Participant {
        void attach(RealIoHold hold);
    }

    private final Handler playback;
    private final Object lock = new Object();
    /** Sources created whose loader thread has not opened them yet. */
    private int awaitingOpen;
    /** Sources delivering real bytes right now. */
    private int deliveringCount;
    private boolean holdPosted;
    private boolean closed;

    RealIoHold(Looper playbackLooper) {
        playback = new Handler(playbackLooper);
    }

    /** {@code inner}'s sources, each holding from its creation until its bytes are delivered. */
    DataSource.Factory wrap(DataSource.Factory inner) {
        if (inner instanceof Participant participant) {
            participant.attach(this);
            return inner;
        }
        return () -> new Holding(inner.createDataSource(), source());
    }

    /** A new source's span. Call from {@code createDataSource}, on the playback thread. */
    Source source() {
        return new Source();
    }

    /** Lets a held thread go and ignores every later span: the player is being released. */
    void close() {
        synchronized (lock) {
            closed = true;
            awaitingOpen = 0;
            deliveringCount = 0;
            lock.notifyAll();
        }
    }

    private void postHoldIfNeeded() {
        if (holdPosted || closed) return;
        holdPosted = true;
        playback.post(this::holdPlaybackThread);
    }

    /** The real message: it occupies the playback looper while a loader thread is at work. */
    private void holdPlaybackThread() {
        synchronized (lock) {
            while (!closed && (awaitingOpen > 0 || deliveringCount > 0)) {
                try {
                    lock.wait();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            holdPosted = false;
        }
    }

    /** One data source's span: created, opened, delivering or not. Every transition is idempotent. */
    final class Source {
        private boolean opened;
        private boolean delivering;

        private Source() {
            synchronized (lock) {
                if (closed) return;
                awaitingOpen++;
                postHoldIfNeeded();
            }
        }

        /** The loader thread opened the source: bytes are about to flow. */
        void opened() {
            synchronized (lock) {
                if (!opened) {
                    opened = true;
                    if (awaitingOpen > 0) awaitingOpen--;
                }
            }
            delivering(true);
        }

        /** Whether real bytes are flowing: off while a {@link Participant} blocks on purpose, and at close. */
        void delivering(boolean on) {
            synchronized (lock) {
                if (closed || on == delivering) return;
                delivering = on;
                if (on) {
                    deliveringCount++;
                    postHoldIfNeeded();
                } else {
                    deliveringCount--;
                    lock.notifyAll();
                }
            }
        }
    }

    /** A plain source under the hold: from its creation until it is closed. */
    private static final class Holding implements DataSource {
        private final DataSource inner;
        private final Source span;

        Holding(DataSource inner, Source span) {
            this.inner = inner;
            this.span = span;
        }

        @Override
        public void addTransferListener(@NonNull TransferListener transferListener) {
            inner.addTransferListener(transferListener);
        }

        @Override
        public long open(@NonNull DataSpec dataSpec) throws IOException {
            // Before the open: a failed open is still followed by a close (the loadable's finally).
            span.opened();
            return inner.open(dataSpec);
        }

        @Override
        public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
            return inner.read(buffer, offset, length);
        }

        @Nullable
        @Override
        public Uri getUri() {
            return inner.getUri();
        }

        @NonNull
        @Override
        public Map<String, List<String>> getResponseHeaders() {
            return inner.getResponseHeaders();
        }

        @Override
        public void close() throws IOException {
            try {
                inner.close();
            } finally {
                span.delivering(false);
            }
        }
    }
}

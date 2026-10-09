package ai.jwlabs.foura.audio.engine;

import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.FileDataSource;
import androidx.media3.datasource.TransferListener;
import java.io.IOException;
import java.io.InterruptedIOException;

/**
 * A file source that delivers only the first {@link Gate#limit} bytes of every load and then
 * BLOCKS, as a network that stops answering does, until the test opens the gate: a load that
 * never becomes ready (limit 0, the deadline test) or a playback that runs its buffer dry (a
 * few seconds' worth, the stall test). The block waits in short slices and gives up on an
 * interrupt, which is how Media3's loader cancels a load, so a released player never hangs.
 *
 * <p>Under the harness's {@link RealIoHold} it is a {@link RealIoHold.Participant}: the bytes it
 * does deliver are real IO and hold virtual time still, like any source's; the block is the
 * network's silence, the very thing the deadline and the stall measure, so the hold is let go
 * while the gate is shut and taken back when it opens and bytes flow again.
 */
@OptIn(markerClass = UnstableApi.class)
final class GatedDataSource implements DataSource {
    /** Shared by every source the factory makes. */
    static final class Gate {
        private long limit;
        private boolean open;
        private long delivered;

        Gate(long limit) {
            this.limit = limit;
        }

        synchronized void open() {
            open = true;
            notifyAll();
        }

        synchronized long delivered() {
            return delivered;
        }

        /** How many of {@code wanted} bytes may be read without waiting: 0 when the gate is shut and the limit spent. */
        synchronized int allowNow(int wanted) {
            if (open) return wanted;
            return (int) Math.min(wanted, limit - delivered);
        }

        /** Blocks until the gate opens; the loader's interrupt ends the wait. */
        synchronized void awaitOpen() throws InterruptedIOException {
            while (!open) {
                try {
                    wait(20);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new InterruptedIOException("gated read interrupted");
                }
            }
        }

        synchronized void count(int read) {
            if (read > 0) delivered += read;
        }
    }

    static Factory factory(Gate gate) {
        return new Factory(gate);
    }

    /** The factory; the harness attaches its hold. Without one (none in these tests) sources run free. */
    static final class Factory implements DataSource.Factory, RealIoHold.Participant {
        private final Gate gate;
        @Nullable
        private RealIoHold hold;

        private Factory(Gate gate) {
            this.gate = gate;
        }

        @Override
        public void attach(RealIoHold hold) {
            this.hold = hold;
        }

        @NonNull
        @Override
        public DataSource createDataSource() {
            return new GatedDataSource(gate, hold == null ? null : hold.source());
        }
    }

    private final Gate gate;
    @Nullable
    private final RealIoHold.Source span;
    private final FileDataSource inner = new FileDataSource();

    private GatedDataSource(Gate gate, @Nullable RealIoHold.Source span) {
        this.gate = gate;
        this.span = span;
    }

    @Override
    public void addTransferListener(@NonNull TransferListener transferListener) {
        inner.addTransferListener(transferListener);
    }

    @Override
    public long open(@NonNull DataSpec dataSpec) throws IOException {
        if (span != null) span.opened();
        return inner.open(dataSpec);
    }

    @Override
    public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        int allowed = gate.allowNow(length);
        if (allowed == 0) {
            // Shut: the network's silence. Virtual time must pass over it, so the hold goes.
            if (span != null) span.delivering(false);
            gate.awaitOpen();
            if (span != null) span.delivering(true);
            allowed = length;
        }
        int read = inner.read(buffer, offset, allowed);
        gate.count(read);
        return read;
    }

    @Nullable
    @Override
    public Uri getUri() {
        return inner.getUri();
    }

    @Override
    public void close() throws IOException {
        try {
            inner.close();
        } finally {
            if (span != null) span.delivering(false);
        }
    }
}

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

        /** How many of {@code wanted} bytes may be read now; blocks while none may. */
        synchronized int allow(int wanted) throws InterruptedIOException {
            while (!open && delivered >= limit) {
                try {
                    wait(20);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new InterruptedIOException("gated read interrupted");
                }
            }
            if (open) return wanted;
            return (int) Math.min(wanted, limit - delivered);
        }

        synchronized void count(int read) {
            if (read > 0) delivered += read;
        }
    }

    static DataSource.Factory factory(Gate gate) {
        return () -> new GatedDataSource(gate);
    }

    private final Gate gate;
    private final FileDataSource inner = new FileDataSource();

    private GatedDataSource(Gate gate) {
        this.gate = gate;
    }

    @Override
    public void addTransferListener(@NonNull TransferListener transferListener) {
        inner.addTransferListener(transferListener);
    }

    @Override
    public long open(@NonNull DataSpec dataSpec) throws IOException {
        return inner.open(dataSpec);
    }

    @Override
    public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        int allowed = gate.allow(length);
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
        inner.close();
    }
}

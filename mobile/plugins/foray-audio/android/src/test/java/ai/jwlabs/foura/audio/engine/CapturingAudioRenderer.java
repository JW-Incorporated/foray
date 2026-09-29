package ai.jwlabs.foura.audio.engine;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.decoder.DecoderInputBuffer;
import androidx.media3.exoplayer.BaseRenderer;
import androidx.media3.exoplayer.RendererCapabilities;
import java.util.ArrayList;
import java.util.List;

/**
 * An audio renderer that keeps every sample it consumes: the media time Media3 LABELLED it
 * with, whether it was decode-only (before the position the player last reset to, so never
 * heard), and its bytes. The click-track measurements (A-25) match those bytes against the
 * file to find where the first sample the listener hears REALLY sits.
 *
 * <p>It consumes samples the way media3-test-utils' {@code FakeRenderer} does (up to 250 ms
 * ahead of the playback position, so the player's own standalone clock is the position), but
 * that class keeps its buffer private, and the bytes are the point here.
 *
 * <p>Written on the playback thread, read by the test after the player has stopped;
 * {@link #samples()} copies under the lock.
 */
@OptIn(markerClass = UnstableApi.class)
final class CapturingAudioRenderer extends BaseRenderer {
    static final long READAHEAD_US = 250_000;

    /** One consumed sample. {@code timeUs} is media time (the stream offset removed). */
    static final class Sample {
        final long timeUs;
        final boolean decodeOnly;
        final byte[] data;

        Sample(long timeUs, boolean decodeOnly, byte[] data) {
            this.timeUs = timeUs;
            this.decodeOnly = decodeOnly;
            this.data = data;
        }
    }

    private final DecoderInputBuffer buffer = new DecoderInputBuffer(DecoderInputBuffer.BUFFER_REPLACEMENT_MODE_NORMAL);
    private final List<Sample> samples = new ArrayList<>();
    private boolean hasPendingBuffer;
    private boolean ended;

    CapturingAudioRenderer() {
        super(C.TRACK_TYPE_AUDIO);
    }

    @NonNull
    @Override
    public String getName() {
        return "CapturingAudioRenderer";
    }

    @Override
    public int supportsFormat(@NonNull Format format) {
        return RendererCapabilities.create(MimeTypes.isAudio(format.sampleMimeType) ? C.FORMAT_HANDLED : C.FORMAT_UNSUPPORTED_TYPE);
    }

    @Override
    protected void onPositionReset(long positionUs, boolean joining, boolean sampleStreamIsResetToKeyFrame) {
        hasPendingBuffer = false;
        ended = false;
    }

    @Override
    public void render(long positionUs, long elapsedRealtimeUs) {
        if (ended) return;
        while (true) {
            if (!hasPendingBuffer) {
                buffer.clear();
                int result = readSource(getFormatHolder(), buffer, /* readFlags= */ 0);
                if (result == C.RESULT_FORMAT_READ) continue;
                if (result != C.RESULT_BUFFER_READ) return;
                if (buffer.isEndOfStream()) {
                    ended = true;
                    return;
                }
                hasPendingBuffer = true;
            }
            if (buffer.timeUs >= positionUs + READAHEAD_US) return;
            buffer.flip();
            byte[] data = new byte[buffer.data == null ? 0 : buffer.data.remaining()];
            if (buffer.data != null) buffer.data.get(data);
            boolean decodeOnly = buffer.timeUs < getLastResetPositionUs();
            synchronized (samples) {
                samples.add(new Sample(buffer.timeUs - getStreamOffsetUs(), decodeOnly, data));
            }
            hasPendingBuffer = false;
        }
    }

    @Override
    public boolean isReady() {
        return hasPendingBuffer || isSourceReady();
    }

    @Override
    public boolean isEnded() {
        return ended;
    }

    List<Sample> samples() {
        synchronized (samples) {
            return new ArrayList<>(samples);
        }
    }
}

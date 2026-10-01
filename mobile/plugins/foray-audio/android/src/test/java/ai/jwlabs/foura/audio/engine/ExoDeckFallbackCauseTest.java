package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.NarrationFallbackCauseReading;
import ai.jwlabs.foura.engine.Vocabulary.NarrationFallbackCause;
import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.TransferListener;
import androidx.media3.exoplayer.ExoPlaybackException;
import androidx.media3.test.utils.FakeClock;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-64 (mirrors NE-39n's AVDeckTests {@code testFallbackCauseMapsEachCauseFromASyntheticNSError}
 * and NarrationFallbackCauseTests' reading): the {@code cause=} of a {@code narration
 * kind=fallback} row, from Media3's {@link PlaybackException}.
 *
 * <p>Three layers. The core's copied code constants are Media3's. Every {@code ERROR_CODE_*}
 * Media3 declares maps to its cause through {@link ExoDeck#fallbackCause} (a code added by a
 * Media3 bump lands in a group and is mapped, or this sweep names it). And a real load through
 * the deck, whose source answers 404, 503, or is not there, emits the failure or the deadline
 * with that cause, the row beside it carrying the values it was read from.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
@OptIn(markerClass = UnstableApi.class)
public class ExoDeckFallbackCauseTest {
    private static final DataSpec SPEC = new DataSpec(Uri.parse("https://audio.test/n/line.m4a"));

    private static HttpDataSource.InvalidResponseCodeException status(int code) {
        return new HttpDataSource.InvalidResponseCodeException(code, null, null, Collections.emptyMap(), SPEC, new byte[0]);
    }

    private static HttpDataSource.HttpDataSourceException io(IOException cause, int errorCode) {
        return new HttpDataSource.HttpDataSourceException(cause, SPEC, errorCode, HttpDataSource.HttpDataSourceException.TYPE_OPEN);
    }

    /** As ExoPlayer reports a source's I/O error: {@code createForSource}, the source's reason as the code. */
    private static ExoPlaybackException fromSource(IOException e, int errorCode) {
        return ExoPlaybackException.createForSource(e, errorCode);
    }

    private static NarrationFallbackCause failed(PlaybackException error) {
        return ExoDeck.fallbackCause(error, null, false);
    }

    /**
     * The core module has no Media3, so its reading carries the codes as ints. TO SEE IT FAIL:
     * change one constant in NarrationFallbackCauseReading.
     */
    @Test
    public void theCoresCodesAreMedia3s() {
        assertEquals(PlaybackException.ERROR_CODE_TIMEOUT, NarrationFallbackCauseReading.TIMEOUT);
        assertEquals(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, NarrationFallbackCauseReading.IO_UNSPECIFIED);
        assertEquals(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, NarrationFallbackCauseReading.IO_NETWORK_CONNECTION_FAILED);
        assertEquals(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT, NarrationFallbackCauseReading.IO_NETWORK_CONNECTION_TIMEOUT);
        assertEquals(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, NarrationFallbackCauseReading.IO_BAD_HTTP_STATUS);
        assertEquals(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, NarrationFallbackCauseReading.IO_FILE_NOT_FOUND);
    }

    /** Every {@code ERROR_CODE_*} constant Media3 declares, by name. */
    private static Map<String, Integer> media3Codes() throws IllegalAccessException {
        Map<String, Integer> codes = new LinkedHashMap<>();
        for (Field f : PlaybackException.class.getFields()) {
            if (!Modifier.isStatic(f.getModifiers()) || f.getType() != int.class || !f.getName().startsWith("ERROR_CODE_")) continue;
            codes.put(f.getName().substring("ERROR_CODE_".length()), f.getInt(null));
        }
        return codes;
    }

    /** The cause each Media3 code reads as on its own (no HTTP status, no deadline). */
    private static NarrationFallbackCause expected(String name) {
        if (name.equals("IO_NETWORK_CONNECTION_FAILED")) return NarrationFallbackCause.OFFLINE;
        if (name.equals("IO_NETWORK_CONNECTION_TIMEOUT") || name.equals("TIMEOUT")) return NarrationFallbackCause.TIMEOUT;
        if (name.startsWith("PARSING_") || name.startsWith("DECODER_") || name.startsWith("DECODING_")) return NarrationFallbackCause.DECODE;
        return NarrationFallbackCause.OTHER;
    }

    /**
     * Every PlaybackException class, one synthetic failure each, maps to its cause: the
     * connection failing is {@code offline}, its timeout {@code timeout}, every parsing and
     * decoding code {@code decode}, and the rest {@code other}. TO SEE IT FAIL: drop the decode
     * ranges from the reading (every PARSING_/DECODING_ code reads {@code other}).
     */
    @Test
    public void everyMedia3ErrorCodeMapsToItsCause() throws Exception {
        Map<String, Integer> codes = media3Codes();
        assertTrue("the sweep found Media3's codes: " + codes, codes.size() > 20);
        assertTrue(codes.containsKey("PARSING_CONTAINER_MALFORMED") && codes.containsKey("DECODING_FAILED"));
        for (Map.Entry<String, Integer> code : codes.entrySet()) {
            PlaybackException error = new PlaybackException("synthetic", null, code.getValue());
            assertEquals(code.getKey() + " (" + code.getValue() + ")", expected(code.getKey()), failed(error));
        }
    }

    /**
     * The source's exception under the failure: an HTTP status answers first (4xx, 5xx); a
     * connection that failed is offline, one that timed out a timeout. TO SEE IT FAIL: read the
     * status off the PlaybackException itself rather than its cause chain (every one is
     * {@code other}).
     */
    @Test
    public void aSourcesExceptionUnderTheFailureIsRead() {
        assertEquals(NarrationFallbackCause.HTTP4XX, failed(fromSource(status(404), PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)));
        assertEquals(NarrationFallbackCause.HTTP4XX, failed(fromSource(status(403), PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)));
        assertEquals(NarrationFallbackCause.HTTP5XX, failed(fromSource(status(503), PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)));
        assertEquals(NarrationFallbackCause.HTTP5XX, failed(fromSource(status(500), PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)));
        assertEquals("a bad status with no status is not guessed", NarrationFallbackCause.OTHER,
                failed(new PlaybackException("synthetic", null, PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)));
        assertEquals("airplane mode: no host resolves", NarrationFallbackCause.OFFLINE, failed(fromSource(
                io(new UnknownHostException("audio.test"), PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED),
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)));
        assertEquals(NarrationFallbackCause.TIMEOUT, failed(fromSource(
                io(new SocketTimeoutException(), PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT),
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT)));
        assertEquals("the source's reason counts even under an unspecified failure", NarrationFallbackCause.OFFLINE, failed(fromSource(
                io(new UnknownHostException("audio.test"), PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED),
                PlaybackException.ERROR_CODE_IO_UNSPECIFIED)));
        assertEquals("no error at all (the deck's no-url)", NarrationFallbackCause.OTHER, ExoDeck.fallbackCause(null, null, false));
    }

    /**
     * A deadline has no failure: it is {@code timeout} unless the load error the player retried
     * through says the server answered or the network was gone (iOS reads its error log the same
     * way). TO SEE IT FAIL: check the deadline before the load error's status.
     */
    @Test
    public void aDeadlineReadsTheLastLoadError() {
        assertEquals(NarrationFallbackCause.TIMEOUT, ExoDeck.fallbackCause(null, null, true));
        assertEquals(NarrationFallbackCause.HTTP4XX, ExoDeck.fallbackCause(null, status(404), true));
        assertEquals(NarrationFallbackCause.HTTP5XX, ExoDeck.fallbackCause(null, status(502), true));
        assertEquals(NarrationFallbackCause.OFFLINE, ExoDeck.fallbackCause(null,
                io(new UnknownHostException("audio.test"), PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED), true));
    }

    /** Precedence, the Swift order: a server's status, then offline, then timeout, then decode. */
    @Test
    public void precedenceIsStatusThenOfflineThenTimeoutThenDecode() {
        PlaybackException offline = fromSource(io(new UnknownHostException("audio.test"),
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED), PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED);
        assertEquals(NarrationFallbackCause.HTTP4XX, ExoDeck.fallbackCause(offline, status(404), false));
        assertEquals(NarrationFallbackCause.OFFLINE, ExoDeck.fallbackCause(offline, null, true));
        PlaybackException decode = new PlaybackException("synthetic", null, PlaybackException.ERROR_CODE_DECODING_FAILED);
        assertEquals(NarrationFallbackCause.TIMEOUT, ExoDeck.fallbackCause(decode, null, true));
    }

    /** Every token in the closed set is reachable from a Media3 failure. */
    @Test
    public void everyCauseIsReachable() {
        Set<NarrationFallbackCause> reached = EnumSet.noneOf(NarrationFallbackCause.class);
        reached.add(ExoDeck.fallbackCause(null, null, true));
        reached.add(failed(fromSource(status(404), PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)));
        reached.add(failed(fromSource(status(503), PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)));
        reached.add(failed(new PlaybackException("synthetic", null, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)));
        reached.add(failed(new PlaybackException("synthetic", null, PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED)));
        reached.add(failed(new PlaybackException("synthetic", null, PlaybackException.ERROR_CODE_IO_UNSPECIFIED)));
        assertEquals(EnumSet.allOf(NarrationFallbackCause.class), reached);
    }

    // ---- through the deck, on a real player

    /** A source that answers every open with {@code status} (a server that is up and says no). */
    static final class AnsweringSource implements DataSource {
        final int status;

        AnsweringSource(int status) {
            this.status = status;
        }

        @Override
        public void addTransferListener(@NonNull TransferListener transferListener) {}

        @Override
        public long open(@NonNull DataSpec dataSpec) throws IOException {
            throw new HttpDataSource.InvalidResponseCodeException(status, null, null, Collections.emptyMap(), dataSpec, new byte[0]);
        }

        @Override
        public int read(@NonNull byte[] buffer, int offset, int length) {
            throw new IllegalStateException("never opened");
        }

        @Nullable
        @Override
        public Uri getUri() {
            return null;
        }

        @Override
        public void close() {}
    }

    private static DeckCommand.Load line(int token) {
        return new DeckCommand.Load(token, "f1#1", "https://audio.test/n/line.m4a", 0, false);
    }

    /**
     * A rendered line whose host answers 404: ExoPlayer retries, then fails the item, and the
     * deck's {@code failed} says {@code http-4xx}, its row carrying the status it read. TO SEE IT
     * FAIL: emit {@code failed} without the deck's cause (it reads {@code other}).
     */
    @Test
    public void aLineWhoseHostAnswers404FailsAsHttp4xx() throws Exception {
        try (DeckHarness h = new DeckHarness(() -> new AnsweringSource(404), c -> {})) {
            h.deck.send(line(1));
            DeckEvent.Failed failed = h.await(DeckEvent.Failed.class);
            assertEquals(1, failed.token());
            assertEquals(NarrationFallbackCause.HTTP4XX, failed.cause());
            EngineCommand.DiagEntry row = h.deckRows("failed").get(0);
            assertEquals(Double.valueOf(404), DeckHarness.num(row, "httpStatus"));
            assertEquals(Double.valueOf(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS), DeckHarness.num(row, "errCode"));
        }
    }

    /** A file that is not there is not a server's answer: {@code other}, as iOS's fileDoesNotExist. */
    @Test
    public void aLocalFileThatIsNotThereIsOther() throws Exception {
        try (DeckHarness h = new DeckHarness()) {
            h.deck.send(new DeckCommand.Load(1, "f1#1", "file:///nowhere/line-none.m4a", 0, false));
            DeckEvent.Failed failed = h.await(DeckEvent.Failed.class);
            assertEquals(NarrationFallbackCause.OTHER, failed.cause());
        }
    }

    /**
     * A line whose host answers 503 while ExoPlayer retries, until the P-13 deadline runs out
     * first: the deadline says {@code http-5xx}, not {@code timeout}, because the server answered,
     * and its row carries the load error's code and status. On a MANUAL clock (A-60's deadline
     * tests), so the deadline fires at its own second and the loader thread has real time to
     * fail. TO SEE IT FAIL: drop the deck's analytics listener (the deadline reads
     * {@code timeout}).
     */
    @Test
    public void aDeadlineAfterA503SaysHttp5xx() throws Exception {
        try (DeckHarness h = new DeckHarness(new FakeClock(/* isAutoAdvancing= */ false), () -> new AnsweringSource(503),
                c -> c.loadDeadlineSec = 1.5)) {
            h.deck.send(line(1));
            boolean fired = h.stepTo(2_500, 50, 30, () -> h.find(DeckEvent.DeadlineExceeded.class) != null);
            assertTrue("the deadline fired: " + h.events, fired);
            DeckEvent.DeadlineExceeded deadline = h.find(DeckEvent.DeadlineExceeded.class);
            assertNotNull(deadline);
            assertEquals(NarrationFallbackCause.HTTP5XX, deadline.cause());
            EngineCommand.DiagEntry row = h.deckRows("deadline").get(0);
            assertEquals(Double.valueOf(503), DeckHarness.num(row, "loadStatus"));
            assertEquals(Double.valueOf(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS), DeckHarness.num(row, "loadErrCode"));
        }
    }
}

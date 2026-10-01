package ai.jwlabs.foura.engine;

import java.util.List;

/**
 * WHY A RENDERED LINE FELL BACK TO THE PHONE'S VOICE: the JVM twin of
 * {@code NarrationFallbackCauseReading} (ForayEngineCore, Policy/NarrationFallbackCause.swift,
 * NE-39n), card A-64.
 *
 * <p>A {@code narration kind=fallback} row says a rendered narration FILE failed and the script
 * was spoken instead. {@code reason=} only says whether the load ran out of time or failed;
 * {@code cause=} says why, as one of the closed {@code narrationFallbackCause} tokens
 * (player/engine-vocabulary.js NARRATION_FALLBACK_CAUSES, the JS vocabulary first):
 *
 * <pre>
 *   timeout   the load passed its deadline (P-13), or the connection timed out
 *   http-4xx  the server answered 4xx (a missing or refused file)
 *   http-5xx  the server answered 5xx
 *   offline   no network (airplane mode, no signal)
 *   decode    the bytes arrived and are not playable audio
 *   other     none of the above
 * </pre>
 *
 * <p>The reading is made from plain values ExoDeck takes off Media3, never from free text: the
 * {@code PlaybackException} error codes of the failure and of its source's
 * {@code DataSourceException} ({@code reason}), and an HTTP status when the cause chain carries
 * an {@code InvalidResponseCodeException}. A deadline has no failure, so it reads the last LOAD
 * error the player retried through by then (the Android counterpart of AVPlayerItem's error log,
 * which the iOS deadline reads). The core module has no Media3 dependency, so the codes are
 * copied here as ints; the Robolectric {@code ExoDeckFallbackCauseTest} pins each one to
 * Media3's constant, and maps each {@code PlaybackException} class to its cause through ExoDeck.
 *
 * <p>PRECEDENCE, when more than one applies (the Swift order): a server's status first (it
 * answered, so the network was up), then offline, then timeout, then decode. A deadline is
 * {@code timeout} unless a load error says the server answered or the network was gone by then.
 *
 * <p>THE TABLE, by Media3's code groups ({@code 2xxx} I/O, {@code 3xxx} parsing, {@code 4xxx}
 * decoding):
 * <ul>
 *   <li>{@code IO_BAD_HTTP_STATUS} with a status: {@code http-4xx} or {@code http-5xx}; with no
 *       status, {@code other}.
 *   <li>{@code IO_NETWORK_CONNECTION_FAILED}: {@code offline}. Media3 folds "no network" and "the
 *       host would not connect" into this one code (an {@code UnknownHostException} is both), so
 *       unlike iOS (which keeps {@code cannotFindHost} as {@code other}) a dead host reads as
 *       offline here. // MEASURE: the first drives with rendered narration say whether that is
 *       ever the host (A-67's script).
 *   <li>{@code IO_NETWORK_CONNECTION_TIMEOUT} and the generic {@code TIMEOUT}: {@code timeout}.
 *   <li>Every {@code PARSING_*} and {@code DECODER_*}/{@code DECODING_*}: {@code decode}.
 *   <li>Everything else ({@code IO_UNSPECIFIED}, {@code IO_FILE_NOT_FOUND} for a local file, as
 *       iOS's {@code fileDoesNotExist} is, cleartext, audio-track, ...): {@code other}, and the
 *       deck's {@code failed} row beside it still carries {@code errCode}/{@code errToken} to
 *       extend the table from.
 * </ul>
 */
public final class NarrationFallbackCauseReading {
    private NarrationFallbackCauseReading() {}

    /** {@code PlaybackException.ERROR_CODE_TIMEOUT}. */
    public static final int TIMEOUT = 1003;
    /** {@code PlaybackException.ERROR_CODE_IO_UNSPECIFIED}. */
    public static final int IO_UNSPECIFIED = 2000;
    /** {@code PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED}. */
    public static final int IO_NETWORK_CONNECTION_FAILED = 2001;
    /** {@code PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT}. */
    public static final int IO_NETWORK_CONNECTION_TIMEOUT = 2002;
    /** {@code PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS}. */
    public static final int IO_BAD_HTTP_STATUS = 2004;
    /** {@code PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND}. */
    public static final int IO_FILE_NOT_FOUND = 2005;
    /** The parsing group: {@code ERROR_CODE_PARSING_*} (3001..3004 in Media3 1.11). */
    public static final int PARSING_FIRST = 3000;
    public static final int PARSING_LAST = 3999;
    /** The decoding group: {@code ERROR_CODE_DECODER_*} and {@code ERROR_CODE_DECODING_*} (4001..4006). */
    public static final int DECODING_FIRST = 4000;
    public static final int DECODING_LAST = 4999;

    /**
     * The cause of a rendered line's fallback.
     *
     * @param codes the failure's {@code PlaybackException} code and its source's
     *     {@code DataSourceException} reason, then the last load error's reason; empty for a
     *     deadline with no load error
     * @param httpStatus the HTTP status the failure (or, for a deadline, the last load error)
     *     carried, or null
     * @param deadline the deck's P-13 deadline fired (the {@code deadline} row)
     */
    public static Vocabulary.NarrationFallbackCause cause(List<Integer> codes, Integer httpStatus, boolean deadline) {
        if (httpStatus != null) {
            if (httpStatus >= 400 && httpStatus <= 499) return Vocabulary.NarrationFallbackCause.HTTP4XX;
            if (httpStatus >= 500 && httpStatus <= 599) return Vocabulary.NarrationFallbackCause.HTTP5XX;
        }
        if (codes.contains(IO_NETWORK_CONNECTION_FAILED)) return Vocabulary.NarrationFallbackCause.OFFLINE;
        if (deadline || codes.contains(IO_NETWORK_CONNECTION_TIMEOUT) || codes.contains(TIMEOUT)) {
            return Vocabulary.NarrationFallbackCause.TIMEOUT;
        }
        for (Integer code : codes) {
            if (code == null) continue;
            if ((code >= PARSING_FIRST && code <= PARSING_LAST) || (code >= DECODING_FIRST && code <= DECODING_LAST)) {
                return Vocabulary.NarrationFallbackCause.DECODE;
            }
        }
        return Vocabulary.NarrationFallbackCause.OTHER;
    }
}

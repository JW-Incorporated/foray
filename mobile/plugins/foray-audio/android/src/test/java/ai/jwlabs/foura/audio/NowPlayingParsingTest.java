package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;

import org.json.JSONException;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * M5 (full-repo-review-report.md, 2026-08-31): {@code NowPlaying.from(JSObject)} is
 * the one place a malformed `setNowPlaying` payload from the web half either becomes
 * the honest empty value or reaches Media3 and crashes the app on the main thread
 * (see the class's own "AUDIT" javadoc on `number`/`clampMs`). This exercises that
 * parsing for real, on the JVM, instead of trusting the comments.
 *
 * <p>{@code @RunWith(RobolectricTestRunner.class)} only because {@link JSObject}
 * (a {@code JSONObject} subclass) needs `org.json`, which on a plain JVM is the
 * Android stub jar that throws "not mocked" from every method — Robolectric swaps
 * in a real implementation.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class NowPlayingParsingTest {

    private static JSObject payload(String json) throws JSONException {
        return new JSObject(json);
    }

    @Test
    public void nullPayload_isEmpty() {
        NowPlaying np = NowPlaying.from(null);
        assertEquals(NowPlaying.IDLE, np.state);
        assertFalse(np.isLoaded());
        assertFalse(np.acceptsTransport());
    }

    @Test
    public void unknownStateWord_isIdle() throws JSONException {
        NowPlaying np = NowPlaying.from(payload("{\"state\":\"buffering\",\"title\":\"x\"}"));
        assertEquals(NowPlaying.IDLE, np.state);
        // idle carries none of the rest, even though the payload had a title —
        // see the class comment on why an idle state renders no metadata.
        assertEquals("", np.title);
    }

    @Test
    public void playingState_carriesEveryField() throws JSONException {
        NowPlaying np = NowPlaying.from(payload(
            "{\"state\":\"playing\",\"title\":\"Episode 4\",\"artist\":\"Show\","
            + "\"album\":\"Foray part 2 of 3\",\"durationMs\":3600000,\"positionMs\":120000,"
            + "\"playbackRate\":1.0,\"canPlay\":true,\"canPause\":true,\"canStop\":true,"
            + "\"hasNext\":true,\"hasPrevious\":false,\"canSeekBack\":true,"
            + "\"canSeekForward\":true,\"canSeekTo\":true,\"seekBackMs\":15000,\"seekForwardMs\":30000}"));
        assertEquals(NowPlaying.PLAYING, np.state);
        assertTrue(np.isLoaded());
        assertTrue(np.acceptsTransport());
        assertEquals("Episode 4", np.title);
        assertEquals("Show", np.artist);
        assertEquals("Foray part 2 of 3", np.album);
        // 3,600,000 exceeds Integer.MAX_VALUE's neighbourhood territory in spirit —
        // this is the exact case the class javadoc calls out: org.json parses this
        // into an Integer, and `PluginCall.getLong` would silently return null for
        // it. `NowPlaying.number()` must still read it correctly.
        assertEquals(3600000L, np.durationMs);
        assertEquals(120000L, np.positionMs);
        assertEquals(1f, np.playbackRate, 0.0001f);
        assertTrue(np.hasNext);
        assertFalse(np.hasPrevious);
        assertEquals(15000L, np.seekBackMs);
        assertEquals(30000L, np.seekForwardMs);
    }

    @Test
    public void endedState_declinesTransport() throws JSONException {
        NowPlaying np = NowPlaying.from(payload(
            "{\"state\":\"ended\",\"title\":\"Episode 4\",\"canPlay\":true,\"canPause\":true}"));
        assertTrue(np.isLoaded());
        // Per the class javadoc: ENDED is loaded but must not accept transport —
        // a play button that does nothing is worse than none.
        assertFalse(np.acceptsTransport());
    }

    @Test
    public void negativeOrNonFiniteDuration_clampsToZeroRatherThanThrowing() throws JSONException {
        NowPlaying np = NowPlaying.from(payload(
            "{\"state\":\"playing\",\"durationMs\":-500,\"positionMs\":-1}"));
        assertEquals(0L, np.durationMs);
        assertEquals(0L, np.positionMs);
    }

    @Test
    public void absurdlyLargeDuration_clampsToTheDayCeiling() throws JSONException {
        // 9223372036854775807 (Long.MAX_VALUE) is exactly the value the class
        // comment says used to wrap negative after WebViewPlayer's *1000 conversion
        // to microseconds and crash Media3's setDurationUs on the main thread.
        NowPlaying np = NowPlaying.from(payload(
            "{\"state\":\"playing\",\"durationMs\":9223372036854775807}"));
        assertEquals(24L * 60L * 60L * 1000L, np.durationMs);
    }

    @Test
    public void zeroOrNegativePlaybackRate_fallsBackToOne() throws JSONException {
        NowPlaying zero = NowPlaying.from(payload("{\"state\":\"playing\",\"playbackRate\":0}"));
        assertEquals(1f, zero.playbackRate, 0.0001f);

        NowPlaying negative = NowPlaying.from(payload("{\"state\":\"playing\",\"playbackRate\":-2}"));
        assertEquals(1f, negative.playbackRate, 0.0001f);
    }

    @Test
    public void missingBooleans_defaultToFalse() throws JSONException {
        NowPlaying np = NowPlaying.from(payload("{\"state\":\"paused\"}"));
        assertFalse(np.canPlay);
        assertFalse(np.canPause);
        assertFalse(np.hasNext);
        assertFalse(np.hasPrevious);
        // paused + neither canPlay nor canPause means no transport is offered —
        // matches acceptsTransport()'s definition (state-based) but WebViewPlayer's
        // commandsFor() would then declare no COMMAND_PLAY_PAUSE either.
        assertEquals(NowPlaying.PAUSED, np.state);
    }
}

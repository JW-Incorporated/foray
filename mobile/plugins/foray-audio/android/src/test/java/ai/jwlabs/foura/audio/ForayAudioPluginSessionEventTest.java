package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;

import com.getcapacitor.JSObject;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * A-08: the Android plugin's {@code SESSION_EVENT} carries the same four keys as the
 * iOS plugin's ({@code ForayAudioPlugin.swift}'s {@code sessionEvent}), so
 * {@code player/client.js} and {@code player/diagnostic-log.js} read an Android route
 * loss exactly as they read an iOS one.
 *
 * <p>{@code @RunWith(RobolectricTestRunner.class)} only because {@link JSObject} is an
 * {@code org.json.JSONObject}, which the plain JVM stubs.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ForayAudioPluginSessionEventTest {

    @Test
    public void theEventNameIsTheWebHalfs() {
        // shell-invariants.test.mjs also pins this against foray-media-session.js.
        assertEquals("session", ForayAudioPlugin.SESSION_EVENT);
    }

    @Test
    public void theWireShapeIsKindReasonProducerAt() throws Exception {
        // MUTATION: drop `at` -> client.js's sessionLagMs reads Infinity; drop
        // `producer` -> the record files it as whatever its default is, not by name.
        JSObject event = ForayAudioPlugin.sessionEvent(
            PlaybackKeepAliveService.SESSION_ROUTE_CHANGE,
            PlaybackKeepAliveService.REASON_OLD_DEVICE_GONE,
            1_700_000_000_000L
        );
        List<String> keys = new ArrayList<>();
        for (Iterator<String> it = event.keys(); it.hasNext(); ) keys.add(it.next());
        Collections.sort(keys);
        assertEquals(List.of("at", "kind", "producer", "reason"), keys);
        assertEquals("routeChange", event.getString("kind"));
        assertEquals("old-device-gone", event.getString("reason"));
        assertEquals("audio", event.getString("producer"));
        assertEquals(1_700_000_000_000L, event.getLong("at"));
    }
}

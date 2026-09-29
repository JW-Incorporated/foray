package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/**
 * A-21's one test: the trivial type runs on a plain JVM, with no Robolectric and no
 * android.jar. The expected values are the Swift core's EngineHandshake, so a drift
 * between the two cores shows here before the parity runner (A-22) exists.
 */
public class EngineHandshakeTest {
    @Test
    public void theStubAnswerIsLegacyNotBuiltOnProtocolOne() {
        assertEquals(1, EngineHandshake.PROTOCOL_VERSION);

        Map<String, String> wire = EngineHandshake.toWire(EngineHandshake.notBuilt());
        assertEquals("legacy", wire.get("mode"));
        assertEquals("not-built", wire.get("reason"));
        // Exactly these two keys, in the Swift literal's order.
        assertEquals(List.of("mode", "reason"), new ArrayList<>(wire.keySet()));
        // The plugin copies the map across the bridge; nothing may write into it.
        assertThrows(UnsupportedOperationException.class, () -> wire.put("mode", "native"));
    }
}

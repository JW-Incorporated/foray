package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.Vocabulary.NarrationFallbackCause;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

/**
 * Card A-64 (mirrors NE-39n's NarrationFallbackCauseTests): the {@code narration kind=fallback}
 * row's {@code cause=} on the JVM.
 *
 * <p>Two halves. The pure reading ({@link NarrationFallbackCauseReading}) maps each closed token
 * from a synthetic deck failure: Media3's {@code PlaybackException} codes and an HTTP status, the
 * values ExoDeck's {@code failed} and {@code deadline} rows print. Then the core: a deck failure
 * under a rendered line writes the deck's cause on the fallback row, the gate keeps it, and a
 * clip's failure writes no fallback row at all.
 *
 * <p>The Media3 end (ExoDeck.fallbackCause, every {@code PlaybackException} class) is the
 * Robolectric {@code ExoDeckFallbackCauseTest}.
 */
public class NarrationFallbackCauseTest {
    private static NarrationFallbackCause read(List<Integer> codes, Integer status, boolean deadline) {
        return NarrationFallbackCauseReading.cause(codes, status, deadline);
    }

    private static List<Integer> codes(Integer... codes) {
        return Arrays.asList(codes);
    }

    // ---- the reading, one synthetic failure per cause

    /** TO SEE IT FAIL: drop {@code deadline ||} from the timeout test in the reading. */
    @Test
    public void timeout() {
        assertEquals("the P-13 deadline, nothing seen", NarrationFallbackCause.TIMEOUT, read(codes(), null, true));
        assertEquals("the connection's own timeout", NarrationFallbackCause.TIMEOUT,
                read(codes(NarrationFallbackCauseReading.IO_NETWORK_CONNECTION_TIMEOUT), null, false));
        assertEquals("Media3's generic timeout", NarrationFallbackCause.TIMEOUT, read(codes(NarrationFallbackCauseReading.TIMEOUT), null, false));
    }

    /** TO SEE IT FAIL: read the status only when the code is IO_BAD_HTTP_STATUS. */
    @Test
    public void http4xxAnd5xx() {
        int bad = NarrationFallbackCauseReading.IO_BAD_HTTP_STATUS;
        assertEquals("a missing file", NarrationFallbackCause.HTTP4XX, read(codes(bad, bad), 404, false));
        assertEquals("a refused file", NarrationFallbackCause.HTTP4XX, read(codes(bad), 403, false));
        assertEquals("a deadline after the server answered 404 is the 404", NarrationFallbackCause.HTTP4XX, read(codes(bad), 404, true));
        assertEquals(NarrationFallbackCause.HTTP5XX, read(codes(bad), 503, false));
        assertEquals(NarrationFallbackCause.HTTP5XX, read(codes(), 500, true));
        assertEquals("a bad status with none to read is not guessed", NarrationFallbackCause.OTHER, read(codes(bad), null, false));
        assertEquals("a 3xx is no answer of the two", NarrationFallbackCause.OTHER, read(codes(bad), 302, false));
    }

    /** Airplane mode during a line. TO SEE IT FAIL: check timeout before offline. */
    @Test
    public void offline() {
        int failed = NarrationFallbackCauseReading.IO_NETWORK_CONNECTION_FAILED;
        assertEquals(NarrationFallbackCause.OFFLINE, read(codes(failed, failed), null, false));
        assertEquals("a deadline after the network went is offline, not a timeout", NarrationFallbackCause.OFFLINE,
                read(codes(failed), null, true));
    }

    @Test
    public void decode() {
        assertEquals("PARSING_CONTAINER_MALFORMED", NarrationFallbackCause.DECODE, read(codes(3001), null, false));
        assertEquals("PARSING_CONTAINER_UNSUPPORTED", NarrationFallbackCause.DECODE, read(codes(3003), null, false));
        assertEquals("DECODER_INIT_FAILED", NarrationFallbackCause.DECODE, read(codes(4001), null, false));
        assertEquals("DECODING_FAILED", NarrationFallbackCause.DECODE, read(codes(4003), null, false));
        assertEquals("DECODING_FORMAT_UNSUPPORTED", NarrationFallbackCause.DECODE, read(codes(4005), null, false));
    }

    @Test
    public void other() {
        assertEquals("no error at all (the deck's no-url)", NarrationFallbackCause.OTHER, read(codes(), null, false));
        assertEquals("IO_UNSPECIFIED", NarrationFallbackCause.OTHER, read(codes(NarrationFallbackCauseReading.IO_UNSPECIFIED), null, false));
        assertEquals("a local file that is not there", NarrationFallbackCause.OTHER,
                read(codes(NarrationFallbackCauseReading.IO_FILE_NOT_FOUND), null, false));
        assertEquals("AUDIO_TRACK_INIT_FAILED", NarrationFallbackCause.OTHER, read(codes(5001), null, false));
        assertEquals("a null code is skipped", NarrationFallbackCause.OTHER, read(codes((Integer) null), null, false));
    }

    /** A server's status outranks the rest: it answered, so the network was up. */
    @Test
    public void precedenceIsStatusThenOfflineThenTimeoutThenDecode() {
        int failed = NarrationFallbackCauseReading.IO_NETWORK_CONNECTION_FAILED;
        assertEquals(NarrationFallbackCause.HTTP4XX, read(codes(failed), 404, false));
        assertEquals(NarrationFallbackCause.OFFLINE, read(codes(failed), null, true));
        assertEquals(NarrationFallbackCause.TIMEOUT, read(codes(4003), null, true));
    }

    /** Every token in the closed set is reachable. */
    @Test
    public void everyCauseIsReachable() {
        Set<NarrationFallbackCause> reached = EnumSet.noneOf(NarrationFallbackCause.class);
        reached.add(read(codes(), null, true));
        reached.add(read(codes(), 404, false));
        reached.add(read(codes(), 502, false));
        reached.add(read(codes(NarrationFallbackCauseReading.IO_NETWORK_CONNECTION_FAILED), null, false));
        reached.add(read(codes(4003), null, false));
        reached.add(read(codes(), null, false));
        assertEquals(EnumSet.allOf(NarrationFallbackCause.class), reached);
    }

    // ---- the core writes the deck's cause on the fallback row

    static JsonNode rendered(int index) {
        return EngineCoreTest.obj("id", JsonNode.str("f1#" + index), "kind", JsonNode.str("tts"), "type", JsonNode.str("narration"),
                "script", JsonNode.str("Read me instead."), "audio_url", JsonNode.str("https://audio.test/n/line" + index + ".m4a"),
                "duration_sec", JsonNode.num(4));
    }

    /** A Foray of {@code items} on the tape, its first load issued. */
    static EngineCoreTest.Host foray(JsonNode... items) {
        EngineCoreTest.Host host = new EngineCoreTest.Host(new EngineConfig("test").withForayTape(true, false));
        host.send(new EngineContract.Command.PlayForay("f1", "A Foray", Arrays.asList(items), new JsonNode.Obj(List.of()), null,
                false, false, null));
        assertNotNull("the Foray's first load", host.lastLoad);
        return host;
    }

    static List<EngineCommand.DiagEntry> fallbackRows(List<EngineCommand> out) {
        List<EngineCommand.DiagEntry> rows = new ArrayList<>();
        for (EngineCommand.DiagEntry row : EngineCoreTest.rows("narration", out)) {
            if (row.field("kind") instanceof JsonNode.Str s && s.value().equals("fallback")) rows.add(row);
        }
        return rows;
    }

    /**
     * A rendered line whose file fails (as the deck reads it) falls back with that cause; a
     * deadline with no reading of its own is {@code timeout}. TO SEE IT FAIL: drop the
     * {@code cause} member from {@code fallBackToScript}'s row.
     */
    @Test
    public void theFallbackRowCarriesTheDecksCauseForEveryToken() {
        for (NarrationFallbackCause cause : NarrationFallbackCause.values()) {
            EngineCoreTest.Host host = foray(rendered(0), EngineCoreTest.forayClip(1, 100, 200));
            List<EngineCommand> out = host.send(new EngineInput.Deck(new DeckEvent.Failed(host.lastLoad, "synthetic", cause)), 0);
            List<EngineCommand.DiagEntry> rows = fallbackRows(out);
            assertEquals(cause + ": " + out, 1, rows.size());
            assertEquals(cause.toString(), cause.token, rows.get(0).field("cause").stringValue());
            assertEquals(cause + ": reason= is unchanged", "failed", rows.get(0).field("reason").stringValue());
            assertEquals("load", rows.get(0).field("where").stringValue());
            assertNull("`at` is the ring's wall clock, never a field", rows.get(0).field("at"));
        }
        EngineCoreTest.Host host = foray(rendered(0), EngineCoreTest.forayClip(1, 100, 200));
        List<EngineCommand> out = host.send(new EngineInput.Deck(new DeckEvent.DeadlineExceeded(host.lastLoad, 8_000)), 0);
        List<EngineCommand.DiagEntry> rows = fallbackRows(out);
        assertEquals(out.toString(), 1, rows.size());
        assertEquals("timeout", rows.get(0).field("cause").stringValue());
        assertEquals("timeout", rows.get(0).field("reason").stringValue());
    }

    /**
     * The row reaches the paste with its cause: every row passes DiagGate on its way into the
     * ring, and a {@code narration} row's {@code cause} is admitted through the fallback's set,
     * not {@code stopCause}, of which no fallback cause is a member. TO SEE IT FAIL: drop the
     * {@code narration} case from {@code DiagGate.vocabularySet} (every cause is then withheld and
     * named in {@code dropped}), or name the row's {@code where} field {@code at} again.
     */
    @Test
    public void theGateKeepsEveryFallbackCauseOnTheRow() {
        for (NarrationFallbackCause cause : NarrationFallbackCause.values()) {
            EngineCoreTest.Host host = foray(rendered(0), EngineCoreTest.forayClip(1, 100, 200));
            List<EngineCommand> out = host.send(new EngineInput.Deck(new DeckEvent.Failed(host.lastLoad, "synthetic", cause)), 0);
            EngineCommand.DiagEntry admitted = DiagGate.admit(fallbackRows(out).get(0));
            assertNotNull(cause.toString(), admitted);
            assertEquals(cause + ": " + admitted, cause.token, admitted.field("cause").stringValue());
            assertEquals(cause + ": " + admitted, "load", admitted.field("where").stringValue());
            assertNull(cause + ": nothing withheld: " + admitted, admitted.field(DiagGate.DROPPED_FIELD));
        }
        // Still a closed set: a stop cause is not a fallback cause.
        EngineCommand.DiagEntry stray = DiagGate.admit(new EngineCommand.DiagEntry("narration",
                List.of(JsonNode.member("kind", JsonNode.str("fallback")), JsonNode.member("cause", JsonNode.str("load-deadline")))));
        assertNull(stray.field("cause"));
        assertEquals(new JsonNode.Arr(List.of(JsonNode.str("cause"))), stray.field(DiagGate.DROPPED_FIELD));
        // And a stop row's cause is still a stop cause.
        assertEquals("stopCause", DiagGate.vocabularySet("stop", null, "cause"));
        assertEquals("narrationFallbackCause", DiagGate.vocabularySet("narration", "fallback", "cause"));
    }

    /** A clip that fails writes no fallback row, whatever the deck read. */
    @Test
    public void aClipsFailureWritesNoFallbackRow() {
        EngineCoreTest.Host host = foray(EngineCoreTest.forayClip(0, 100, 200), rendered(1));
        List<EngineCommand> out = host.send(new EngineInput.Deck(new DeckEvent.Failed(host.lastLoad, "synthetic",
                NarrationFallbackCause.OFFLINE)), 0);
        assertEquals(out.toString(), List.of(), fallbackRows(out));
        assertTrue("the clip's failure is the load error it always was: " + out,
                out.stream().anyMatch(c -> c instanceof EngineCommand.Emit e && e.event() instanceof EngineCommand.EngineEvent.Error));
    }
}

package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * Card A-60: the JVM port of the ring's gate (Diag/DiagGate.swift; the Swift DiagRingTests' gate
 * cases, ported), and the deadline class the core names on every load (NE-38's
 * {@code DeckDeadlineClass}).
 */
public class DiagGateTest {
    private static JsonNode.Member m(String key, JsonNode value) {
        return JsonNode.member(key, value);
    }

    private static EngineCommand.DiagEntry entry(String kind, JsonNode.Member... fields) {
        return new EngineCommand.DiagEntry(kind, Arrays.asList(fields));
    }

    private static List<String> dropped(EngineCommand.DiagEntry admitted) {
        List<String> out = new ArrayList<>();
        JsonNode list = admitted.field(DiagGate.DROPPED_FIELD);
        if (list instanceof JsonNode.Arr a) for (JsonNode n : a.items()) out.add(n.stringValue());
        return out;
    }

    /** The deck rows NE-38e reads go through whole, the sub-kind as {@code event}, in place. */
    @Test
    public void aDeckRowGoesThroughWholeWithItsSubKindAsEvent() {
        EngineCommand.DiagEntry row = entry("deck", m("kind", JsonNode.str("attach")), m("token", JsonNode.num(3)),
                m("startSec", JsonNode.num(812.5)), m("precise", JsonNode.TRUE), m("host", JsonNode.NULL),
                m("cold", JsonNode.str("stale")), m("idleSec", JsonNode.num(610.25)), m("class", JsonNode.str("line")),
                m("marks", new JsonNode.Obj(List.of(m("duration", JsonNode.num(87)), m("ready", JsonNode.num(117))))));
        EngineCommand.DiagEntry admitted = DiagGate.admit(row);
        assertEquals("deck", admitted.kind());
        assertNull(admitted.field(DiagGate.DROPPED_FIELD));
        assertEquals("attach", admitted.field("event").stringValue());
        assertNull("no field shadows the header's kind", admitted.field("kind"));
        assertEquals("event", admitted.fields().get(0).key());
        assertEquals("line", admitted.field("class").stringValue());
        assertEquals(row.fields().size(), admitted.fields().size());
    }

    /** A URL, a sentence, a name-bearing key: each withheld and named, never silently lost. */
    @Test
    public void whatIsNotATokenIsWithheldAndNamed() {
        EngineCommand.DiagEntry admitted = DiagGate.admit(entry("deck", m("kind", JsonNode.str("failed")),
                m("where", JsonNode.str("https://cdn.example/a.mp3")), m("errName", JsonNode.str("ERROR_CODE_IO")),
                m("audio_url", JsonNode.str("x")), m("why", JsonNode.str("two words")), m("errToken", JsonNode.str("ERROR_CODE_IO_NETWORK")),
                m("seq", JsonNode.num(1)), m("n", JsonNode.num(Double.NaN))));
        assertEquals(Arrays.asList("where", "errName", "audio_url", "why", "seq", "n"), dropped(admitted));
        assertEquals("ERROR_CODE_IO_NETWORK", admitted.field("errToken").stringValue());
        assertEquals("a non-finite number is kept as null, and said", JsonNode.NULL, admitted.field("n"));
        assertNull(admitted.field("where"));
    }

    /** A closed vocabulary admits its own tokens exactly; a misspelt one is dropped, never fixed. */
    @Test
    public void aVocabularyFieldTakesOnlyItsOwnTokens() {
        EngineCommand.DiagEntry stop = DiagGate.admit(entry("stop", m("cause", JsonNode.str("load-deadline")),
                m("source", JsonNode.str("tapp"))));
        assertEquals("load-deadline", stop.field("cause").stringValue());
        assertEquals(List.of("source"), dropped(stop));
        EngineCommand.DiagEntry mode = DiagGate.admit(entry("mode", m("reason", JsonNode.str("page-health"))));
        assertNull(mode.field(DiagGate.DROPPED_FIELD));
        EngineCommand.DiagEntry seam = DiagGate.admit(entry("seam",
                m("stages", new JsonNode.Arr(List.of(JsonNode.str("attach"), JsonNode.str("bogus"), JsonNode.str("ready"))))));
        assertEquals(2, ((JsonNode.Arr) seam.field("stages")).items().size());
        assertEquals(List.of("stages"), dropped(seam));
    }

    @Test
    public void aRowWhoseKindIsNotATokenIsRefusedWhole() {
        assertNull(DiagGate.admit(entry("two words")));
        assertNull(DiagGate.admit(entry("")));
        assertTrue(DiagGate.isToken("time-control"));
        assertFalse(DiagGate.isToken("a".repeat(65)));
        assertTrue(DiagGate.isPortType("bluetoothA2DP"));
        assertFalse(DiagGate.isPortType("Joey's car"));
    }

    @Test
    public void nowPlayingTextIsTrimmedAndCappedAtForty() {
        EngineCommand.DiagEntry np = DiagGate.admit(entry("nowplaying", m("title", JsonNode.str("  " + "x".repeat(50) + " ")),
                m("artist", JsonNode.str("A show"))));
        assertEquals(40, np.field("title").stringValue().length());
        assertTrue(np.field("title").stringValue().endsWith("…"));
        assertEquals("the only free text", "A show", np.field("artist").stringValue());
    }

    /** NE-38: a narration item's load is a line, everything else a clip; a load with no class is a clip. */
    @Test
    public void theDeadlineClassOfAnItem() {
        EngineItem line = EngineItem.of(new JsonNode.Obj(List.of(m("id", JsonNode.str("f1#1")), m("kind", JsonNode.str("tts")),
                m("audio_url", JsonNode.str("https://audio.test/l.m4a")))));
        EngineItem clip = EngineItem.of(new JsonNode.Obj(List.of(m("id", JsonNode.str("f1#0")), m("kind", JsonNode.str("episode")),
                m("audio_url", JsonNode.str("https://audio.test/c.mp3")))));
        assertEquals(DeckDeadlineClass.LINE, DeckDeadlineClass.of(line));
        assertEquals(DeckDeadlineClass.CLIP, DeckDeadlineClass.of(clip));
        assertEquals("line", DeckDeadlineClass.LINE.token);
        assertEquals("clip", DeckDeadlineClass.CLIP.token);
        assertEquals(DeckDeadlineClass.CLIP, new DeckCommand.Load(1, "a", "u", 0, false, null).deadlineClass());
        assertEquals(new DeckCommand.Load(1, "a", "u", 0, false), new DeckCommand.Load(1, "a", "u", 0, false, DeckDeadlineClass.CLIP));
        assertTrue("the provisional P-14 display, tagged // MEASURE", EngineCore.BUFFERING_WHILE_WAITING);
    }
}

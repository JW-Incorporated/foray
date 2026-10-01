package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand.NarrationCommand;
import ai.jwlabs.foura.engine.EngineCoreTest.Host;
import ai.jwlabs.foura.engine.EngineInput.NarratorEvent;
import ai.jwlabs.foura.engine.EngineInput.QueueInput;
import ai.jwlabs.foura.engine.Vocabulary.Source;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * Card A-62 (mirrors NE-45s): a rendered narration line's seams are deck seams, in the JVM core. The
 * JVM twin of the NE-45s cases in the Swift ForayCatchUpTests, ForayTapeTests and RowsTests.
 *
 * <p>Warming follows the FILE, not the beat ({@link DeckPolicy#warmsAcross}): the clip's window
 * prepares a rendered line, the line's own window (from its duration: it has no out-point)
 * prepares the clip after it while it plays, and a spoken line prepares the clip after it at the
 * line's START. Every seam packs one {@code seam} row naming what it joins and whether the standby
 * deck was ready ({@code from=clip|line to=clip|line prepare=hit|miss|none}).
 */
public class NarrationSeamCoreTest {
    static final EngineConfig TAPE = new EngineConfig("test").withForayTape(true, true);

    static EngineItem clip(int index, String name, double start, double end) {
        return EngineItem.of(EngineCoreTest.obj("id", JsonNode.str("f1#" + index), "kind", JsonNode.str("episode"),
                "audio_url", JsonNode.str("https://cdn.test/" + name + ".mp3"), "start_sec", JsonNode.num(start),
                "end_sec", JsonNode.num(end), "duration_sec", JsonNode.num(3600)));
    }

    /** A RENDERED narration line: a file, and its script. */
    static EngineItem rendered(int index) {
        return EngineItem.of(EngineCoreTest.obj("id", JsonNode.str("f1#" + index), "kind", JsonNode.str("tts"),
                "type", JsonNode.str("narration"), "audio_url", JsonNode.str("https://audio.test/f1-" + index + ".mp3"),
                "duration_sec", JsonNode.num(4), "script", JsonNode.str("the line read aloud")));
    }

    /** A SPOKEN (script-only) narration line. */
    static EngineItem spoken(int index, String script) {
        return EngineItem.of(EngineCoreTest.obj("id", JsonNode.str("f1#" + index), "kind", JsonNode.str("tts"),
                "type", JsonNode.str("narration"), "script", JsonNode.str(script), "audio_url", JsonNode.NULL,
                "duration_sec", JsonNode.num(4)));
    }

    /** A host with {@code items} queued as the manager's Foray and the first asked to play. */
    static Host host(List<EngineItem> items) {
        Host host = new Host(TAPE);
        host.send(new EngineInput.Queue(new QueueInput.LoadForay(items, false, false)));
        host.send(new EngineInput.Queue(new QueueInput.PlayIndex(0, null, Source.TAP)));
        return host;
    }

    /** The clip on the deck ends (its out-point or its file), in one instant. */
    static List<EngineCommand> endClip(Host host) {
        host.reading.audible = false;
        host.reading.ended = true;
        return host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad != null ? host.lastLoad : 0)), 0);
    }

    /** {@code <item>@<in-point>:<deadline class>} for every standby prepare. */
    static List<String> prepares(List<EngineCommand> out) {
        List<String> found = new ArrayList<>();
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Prepare p) {
                found.add(p.itemId() + "@" + JSWriter.numberToString(p.startSec()) + ":" + p.deadlineClass().token);
            }
        }
        return found;
    }

    /** {@code <item>@<in-point>} for every load. */
    static List<String> loads(List<EngineCommand> out) {
        List<String> found = new ArrayList<>();
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Load l) {
                found.add(l.itemId() + "@" + JSWriter.numberToString(l.startSec()));
            }
        }
        return found;
    }

    static List<EngineCommand.DiagEntry> seamRows(List<EngineCommand> out) {
        List<EngineCommand.DiagEntry> rows = new ArrayList<>();
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.Diag d && d.entry().kind().equals(SeamRow.KIND)) rows.add(d.entry());
        }
        return rows;
    }

    static EngineCommand.DiagEntry firstSeam(List<EngineCommand> out) {
        List<EngineCommand.DiagEntry> rows = seamRows(out);
        assertFalse("a seam row: " + out, rows.isEmpty());
        return rows.get(0);
    }

    static String text(EngineCommand.DiagEntry row, String key) {
        JsonNode value = row.field(key);
        return value == null ? null : value.stringValue();
    }

    static Double number(EngineCommand.DiagEntry row, String key) {
        JsonNode value = row.field(key);
        return value == null ? null : value.numberValue();
    }

    static boolean pulses(List<EngineCommand> out) {
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.NarrationPulse) return true;
            if (c instanceof EngineCommand.TimerArm t && t.timer() == EngineTimer.NARRATION_TICK) return true;
        }
        return false;
    }

    static Integer spokenSeq(List<EngineCommand> out) {
        Integer seq = null;
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.Narration n && n.command() instanceof NarrationCommand.Speak s) seq = s.seq();
        }
        return seq;
    }

    static List<NarrationCommand.Speak> speaks(List<EngineCommand> out) {
        List<NarrationCommand.Speak> found = new ArrayList<>();
        for (EngineCommand c : out) {
            if (c instanceof EngineCommand.Narration n && n.command() instanceof NarrationCommand.Speak s) found.add(s);
        }
        return found;
    }

    static final List<Vocabulary.Stage> HIT_STAGES = List.of(Vocabulary.Stage.ATTACH, Vocabulary.Stage.DURATION,
            Vocabulary.Stage.READINESS, Vocabulary.Stage.SEEK, Vocabulary.Stage.PREROLL, Vocabulary.Stage.READY);

    static EngineInput deck(DeckEvent event) {
        return new EngineInput.Deck(event);
    }

    /**
     * THE CARD'S CASE, IN THE CORE: clip, rendered line, clip. The clip's window prepares the LINE
     * (it has a file, whatever the beat: the old rule, {@code gapSec > 0}, left it cold), the line's
     * load is the pair's hit, the line's OWN window (from its duration: it has no out-point)
     * prepares the clip after it WHILE it plays, and that clip's load is a hit too: no cold load on
     * the second clip. Each seam packs one row with its kinds, {@code prepare=hit} and the silence
     * the listener heard, and the rendered line is never pulsed: the deck has a position. TO SEE IT
     * FAIL: put {@code SeamGap.gapSec(...) > 0} back in {@code warmNextSegment}, or keep its
     * playing-only guard (the line's window then prepares nothing).
     */
    @Test
    public void clipRenderedLineClipIsTwoPreparedSeamsWithTheirRowsAndNoPulse() {
        Host host = host(List.of(clip(0, "a", 100, 200), rendered(1), clip(2, "b", 300, 400)));
        host.land();
        host.confirm();
        List<EngineCommand> clipWindow = host.send(deck(new DeckEvent.PrepareWindow(host.lastLoad)), 0);
        assertEquals("the line is prepared: " + clipWindow, List.of("f1#1@0:line"), prepares(clipWindow));

        List<EngineCommand> during = new ArrayList<>();
        List<EngineCommand> bridge = endClip(host);
        assertEquals(List.of("f1#1@0"), loads(bridge));
        int lineToken = host.lastLoad;
        during.addAll(host.send(deck(new DeckEvent.Prepared(lineToken, true, HIT_STAGES)), 0));
        List<EngineCommand> lineLanded = host.send(deck(new DeckEvent.Ready(lineToken, 0, true, 0)), 40);
        during.addAll(lineLanded);
        assertTrue(lineLanded.toString(), lineLanded.contains(new EngineCommand.Deck(DeckCommand.PLAY)));
        EngineCommand.DiagEntry intoLine = firstSeam(lineLanded);
        assertEquals("clip", text(intoLine, "from"));
        assertEquals("line", text(intoLine, "to"));
        assertEquals("hit", text(intoLine, "prepare"));
        assertEquals("out-point to the line's start", 40.0, number(intoLine, "observedGapMs"), 0);
        assertEquals("a line is its own marker: no beat", 0.0, number(intoLine, "askedGapMs"), 0);
        during.addAll(host.confirm());
        assertEquals("transitioning", host.core.state().stateType());

        List<EngineCommand> lineWindow = host.send(deck(new DeckEvent.PrepareWindow(lineToken)), 0);
        during.addAll(lineWindow);
        assertEquals("the clip after the line is prepared while the line plays: " + lineWindow, List.of("f1#2@300:clip"),
                prepares(lineWindow));
        assertFalse("a rendered line is a deck item, never pulsed: " + during, pulses(during));

        List<EngineCommand> intoClip = endClip(host);
        assertEquals(List.of("f1#2@300"), loads(intoClip));
        int clipToken = host.lastLoad;
        host.send(deck(new DeckEvent.Prepared(clipToken, true, HIT_STAGES)), 0);
        List<EngineCommand> clipLanded = host.send(deck(new DeckEvent.Ready(clipToken, 300, true, 0)), 30);
        assertTrue(clipLanded.toString(), clipLanded.contains(new EngineCommand.Deck(DeckCommand.PLAY)));
        EngineCommand.DiagEntry outOfLine = firstSeam(clipLanded);
        assertEquals("line", text(outOfLine, "from"));
        assertEquals("clip", text(outOfLine, "to"));
        assertEquals("the second clip was promoted, not loaded cold", "hit", text(outOfLine, "prepare"));
        assertEquals(30.0, number(outOfLine, "observedGapMs"), 0);
        assertEquals(JsonNode.bool(true), outOfLine.field("prepared"));
    }

    /**
     * A SPOKEN line leaves the deck idle, so the clip after it is prepared at the line's START
     * (queue-manager.js {@code _playTransitionBridge}, NE-45j), not at a window: nothing is prepared
     * before the line is audible, and the clip's load at the line's end is a hit. The seam into the
     * line says {@code prepare=none} (a spoken line has no file). TO SEE IT FAIL: drop the
     * {@code line-start} warm from {@code narrationStarted}.
     */
    @Test
    public void theClipAfterASpokenLineIsPreparedAtTheLinesStartAndIsAHit() {
        Host host = host(List.of(clip(0, "a", 100, 200), spoken(1, "a line"), clip(2, "b", 300, 400)));
        host.land();
        host.confirm();
        List<EngineCommand> window = host.send(deck(new DeckEvent.PrepareWindow(host.lastLoad)), 0);
        assertEquals("a spoken line has no file to prepare: " + window, List.of(), prepares(window));
        List<EngineCommand> bridge = endClip(host);
        Integer seq = spokenSeq(bridge);
        assertNotNull("the line is spoken: " + bridge, seq);
        assertEquals("nothing is prepared before the line is audible", List.of(), prepares(bridge));
        List<EngineCommand> started = host.send(new EngineInput.Narrator(new NarratorEvent.Started(seq, false)), 0);
        assertEquals(started.toString(), List.of("f1#2@300:clip"), prepares(started));
        EngineCommand.DiagEntry intoLine = firstSeam(started);
        assertEquals("clip", text(intoLine, "from"));
        assertEquals("line", text(intoLine, "to"));
        assertEquals("none", text(intoLine, "prepare"));

        List<EngineCommand> finished = host.send(new EngineInput.Narrator(new NarratorEvent.Finished(seq)), 3_000);
        assertEquals(finished.toString(), List.of("f1#2@300"), loads(finished));
        int clipToken = host.lastLoad;
        host.send(deck(new DeckEvent.Prepared(clipToken, true, HIT_STAGES)), 0);
        List<EngineCommand> landed = host.send(deck(new DeckEvent.Ready(clipToken, 300, true, 0)), 0);
        EngineCommand.DiagEntry row = firstSeam(landed);
        assertEquals("line", text(row, "from"));
        assertEquals("clip", text(row, "to"));
        assertEquals("the clip after a spoken line is prepare=hit", "hit", text(row, "prepare"));
    }

    /**
     * A prepared line whose file FAILS (the standby's warm load 404s; the deck pair keeps that to
     * itself) falls back to speech AT ITS TURN, exactly as a cold one does: the clip before it plays
     * on with no voice over it, the line's own load at the out-point is the pair's miss and fails
     * again, and the script is spoken on a FRESH token. The seam says {@code prepare=miss}, and the
     * spoken line prepares the clip after it. TO SEE IT FAIL: speak the fallback under the file's
     * token, or start speech from the {@code prepared(hit: false)} report.
     */
    @Test
    public void aPreparedLineWhoseFileFailsIsSpokenAtItsTurnAndNeverBefore() {
        Host host = host(List.of(clip(0, "a", 100, 200), rendered(1), clip(2, "b", 300, 400)));
        host.land();
        host.confirm();
        List<EngineCommand> early = new ArrayList<>(host.send(deck(new DeckEvent.PrepareWindow(host.lastLoad)), 0));
        assertEquals(List.of("f1#1@0:line"), prepares(early));
        early.addAll(host.send(deck(new DeckEvent.TimeControl(host.lastLoad, DeckEvent.TimeControlStatus.PLAYING, null)), 5_000));
        assertEquals("no voice while the clip still plays: " + early, List.of(), speaks(early));

        List<EngineCommand> bridge = endClip(host);
        int fileToken = host.lastLoad;
        assertEquals("the line's turn tries its file first", List.of("f1#1@0"), loads(bridge));
        assertEquals(List.of(), speaks(bridge));
        List<EngineCommand> missed = host.send(deck(new DeckEvent.Prepared(fileToken, false,
                List.of(Vocabulary.Stage.ATTACH, Vocabulary.Stage.DEADLINE))), 0);
        assertEquals("a miss is not a failure: the cold load runs", List.of(), speaks(missed));
        List<EngineCommand> fell = host.send(deck(new DeckEvent.Failed(fileToken, "HTTP 404")), 0);
        Integer seq = spokenSeq(fell);
        assertNotNull("the fallback speaks: " + fell, seq);
        assertTrue("the spoken line rides on a fresh token", host.core.state().lastToken > fileToken);
        for (EngineCommand c : fell) {
            assertFalse(fell.toString(), c instanceof EngineCommand.Emit e && e.event() instanceof EngineCommand.EngineEvent.Error);
        }
        List<EngineCommand> started = host.send(new EngineInput.Narrator(new NarratorEvent.Started(seq, false)), 0);
        EngineCommand.DiagEntry row = firstSeam(started);
        assertEquals("clip", text(row, "from"));
        assertEquals("line", text(row, "to"));
        assertEquals("prepared, and still not ready at its turn", "miss", text(row, "prepare"));
        assertEquals("the line is spoken now, so the clip after it is prepared at its start", List.of("f1#2@300:clip"),
                prepares(started));
    }

    /**
     * The M3 review (2026-09-30): an episode's natural end opens the prefetch window (from its
     * duration), but a plain episode queue's next WHOLE episode is never prepared on the standby:
     * M1's continuation stays a cold load at that episode's own resume position.
     */
    @Test
    public void anEpisodeQueuesWindowPreparesNoWholeEpisode() {
        Host host = new Host(TAPE);
        host.send(EngineCoreTest.load("a", "b"));
        host.send(EngineCoreTest.playIndex(0));
        host.land();
        host.confirm();
        assertEquals("playing", host.core.state().stateType());
        List<EngineCommand> window = host.send(deck(new DeckEvent.PrepareWindow(host.lastLoad)));
        assertEquals(window.toString(), List.of(), prepares(window));
        assertNull(host.core.state().preparedItemId);
    }

    /**
     * Two clips: the seam row names what it joins, and {@code prepare} is the deck pair's verdict
     * ({@code hit} or {@code miss}), or {@code none} when no standby deck said either.
     */
    @Test
    public void aClipSeamRowSaysClipToClipAndThePairsVerdict() {
        for (String verdict : List.of("hit", "miss", "none")) {
            Host host = host(List.of(clip(0, "a", 100, 200), clip(1, "b", 300, 400)));
            host.land();
            host.confirm();
            host.send(deck(new DeckEvent.PrepareWindow(host.lastLoad)), 0);
            endClip(host);
            int token = host.lastLoad;
            if (!verdict.equals("none")) {
                host.send(deck(new DeckEvent.Prepared(token, verdict.equals("hit"),
                        verdict.equals("hit") ? HIT_STAGES : List.of(Vocabulary.Stage.ATTACH))), 0);
            }
            host.send(deck(new DeckEvent.Ready(token, 300, true, 0)), 100);
            // The beat (0.5 s) still runs: its timer starts the clip.
            List<EngineCommand> landed = host.send(new EngineInput.Timer(EngineTimer.SEAM_BEAT), 400);
            EngineCommand.DiagEntry row = firstSeam(landed);
            assertEquals(verdict, "clip", text(row, "from"));
            assertEquals(verdict, "clip", text(row, "to"));
            assertEquals(verdict, verdict, text(row, "prepare"));
            assertEquals(verdict, 500.0, number(row, "askedGapMs"), 0);
        }
    }

    /** A line seam outside a Foray (M1's bridge between whole episodes) writes no row: the tape leaves episode paths unchanged. */
    @Test
    public void aBridgeBetweenWholeEpisodesWritesNoSeamRow() {
        assertFalse(EngineCore.isForaySeam(EngineCoreTest.item("a"), spoken(1, "a bridge")));
        assertTrue(EngineCore.isForaySeam(clip(0, "a", 100, 200), spoken(1, "a line")));
        assertTrue(EngineCore.isForaySeam(spoken(1, "a line"), clip(2, "b", 300, 400)));
    }

    /**
     * The row's NE-45s fields are appended AFTER the older ones (a reader of the old order is
     * unchanged), {@code prepare=none} is the token engine-report.mjs's {@code seam-kinds} reads,
     * and every field is a token the gate admits. TO SEE IT FAIL: write {@code NONE} under its Java
     * name.
     */
    @Test
    public void theSeamRowCarriesItsKindsAndThePrepareVerdict() {
        SeamRow seam = new SeamRow(60.0, 0, false, true, 25_000.0, List.of(Vocabulary.Stage.PLAY), SeamRow.ItemKind.CLIP,
                SeamRow.ItemKind.LINE, SeamRow.Prepare.NONE);
        String json = JSWriter.stringify(new JsonNode.Obj(seam.fields()));
        assertTrue(json, json.endsWith(",\"stages\":[\"play\"],\"from\":\"clip\",\"to\":\"line\",\"prepare\":\"none\"}"));
        EngineCommand.DiagEntry admitted = DiagGate.admit(seam.entry());
        assertNull("every A-62 field is a token the gate admits", admitted.field(DiagGate.DROPPED_FIELD));
        List<String> prepares = new ArrayList<>();
        for (SeamRow.Prepare p : SeamRow.Prepare.values()) prepares.add(p.token);
        assertEquals(List.of("hit", "miss", "none"), prepares);
        List<String> kinds = new ArrayList<>();
        for (SeamRow.ItemKind k : SeamRow.ItemKind.values()) kinds.add(k.token);
        assertEquals(List.of("clip", "line"), kinds);
        SeamRow old = new SeamRow(60.0, 500, true, false, null, List.of(Vocabulary.Stage.READY, Vocabulary.Stage.PLAY));
        assertNull("a row from before A-62 carries no kinds", old.entry().field("from"));
    }
}

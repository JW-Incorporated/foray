package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JsonNode;
import org.junit.Test;

/**
 * Card A-65: {@link ForegroundWatch}, the {@code fgs kind=left} row. Only the step from Media3's
 * "in the foreground" to "not" writes, and the row says whether a Foray was running and in a silent
 * seam. On a plain JVM, over the A-40 host rig's real core.
 */
public class ForegroundWatchTest {
    private static String field(EngineCommand.DiagEntry row, String key) {
        JsonNode value = row.field(key);
        return value instanceof JsonNode.Str s ? s.value() : null;
    }

    /** A Foray in its seam beat: the first clip played to its out-point, the second loading. */
    private static ForayEngineHostForayTest.Rig inTheBeat() {
        ForayEngineHostForayTest.Rig rig = new ForayEngineHostForayTest.Rig(true);
        rig.playForay(ForayEngineHostForayTest.clip(0, "a", 100, 200), ForayEngineHostForayTest.clip(1, "a", 300, 400));
        DeckCommand.Load first = null;
        for (DeckCommand c : rig.deck.sent) if (c instanceof DeckCommand.Load l) first = l;
        rig.deck.emit(new DeckEvent.Ready(first.token(), 100, true, 1));
        rig.deck.reading.positionSec = 200.0;
        rig.deck.emit(new DeckEvent.Ended(first.token()));
        assertTrue(rig.host.state().inSeamGap());
        return rig;
    }

    /**
     * Leaving the foreground in a running Foray's beat is the row the card asks for:
     * {@code fgs kind=left foray=y running=y inSeam=y}. TO SEE IT FAIL: write it on every decision, or
     * read {@code inSeam} after the seam (it would say n).
     */
    @Test
    public void leavingTheForegroundInTheBeatWritesTheRow() {
        ForayEngineHostForayTest.Rig rig = inTheBeat();
        ForegroundWatch watch = new ForegroundWatch();
        assertNull("not in the foreground yet: nothing left", watch.onDecision(false, rig.host.state()));
        assertNull("entering writes nothing", watch.onDecision(true, rig.host.state()));
        assertTrue(watch.inForeground());
        assertNull("staying writes nothing", watch.onDecision(true, rig.host.state()));
        EngineCommand.DiagEntry row = watch.onDecision(false, rig.host.state());
        assertEquals("fgs", row.kind());
        assertEquals("left", field(row, "kind"));
        assertEquals("y", field(row, "foray"));
        assertEquals("y", field(row, "running"));
        assertEquals("y", field(row, "inSeam"));
        assertEquals("n", field(row, "spoken"));
        assertFalse(watch.inForeground());
        assertNull("once per leave", watch.onDecision(false, rig.host.state()));
    }

    /** A paused engine leaving the foreground (Media3's ten-minute timeout) says so: running=n, the expected case. */
    @Test
    public void aPausedEngineLeavingSaysRunningN() {
        ForayEngineHostForayTest.Rig rig = inTheBeat();
        rig.host.handle(new ai.jwlabs.foura.engine.EngineInput.Command(ai.jwlabs.foura.engine.EngineContract.Command.PAUSE,
                ai.jwlabs.foura.engine.Vocabulary.Source.TAP));
        ForegroundWatch watch = new ForegroundWatch();
        watch.onDecision(true, rig.host.state());
        EngineCommand.DiagEntry row = watch.onDecision(false, rig.host.state());
        assertEquals("n", field(row, "running"));
        assertEquals("n", field(row, "inSeam"));
    }

    /** With no engine (none built, or torn down) there is nothing to say. */
    @Test
    public void noEngineNoRow() {
        ForegroundWatch watch = new ForegroundWatch();
        watch.onDecision(true, null);
        assertNull(watch.onDecision(false, null));
        assertFalse(watch.inForeground());
    }
}

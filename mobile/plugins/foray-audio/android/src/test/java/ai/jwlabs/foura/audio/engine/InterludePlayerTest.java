package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeTiming;
import ai.jwlabs.foura.engine.Interlude;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.junit.Test;

/**
 * Card A-41: the jingle player's three rules (the iOS InterludeSeamTests' twin), on a plain JVM
 * with a fake player: the audible-start invariant, the ceiling as an engine timer, and one end
 * per start.
 */
public class InterludePlayerTest {
    static final class FakeJingle implements InterludePlayer.Jingle {
        Consumer<Boolean> onFinish;
        boolean refuse;
        int plays;
        int stops;
        boolean released;

        @Override
        public void setOnFinish(Consumer<Boolean> onFinish) {
            this.onFinish = onFinish;
        }

        @Override
        public boolean playFromStart() {
            plays += 1;
            return !refuse;
        }

        @Override
        public void stop() {
            stops += 1;
        }

        @Override
        public void release() {
            released = true;
        }
    }

    static final class Rig {
        final FakeTiming timing = new FakeTiming();
        final FakeJingle jingle = new FakeJingle();
        final List<String> ends = new ArrayList<>();
        final List<String> rows = new ArrayList<>();
        boolean sessionActive = true;
        boolean hasAsset = true;
        final InterludePlayer player;

        Rig() {
            InterludePlayer.Config config = new InterludePlayer.Config();
            config.sessionIsActive = () -> sessionActive;
            config.diag = entry -> rows.add(entry.kind() + " " + JSWriter.stringify(new JsonNode.Obj(entry.fields())));
            config.timing = timing;
            config.makeJingle = () -> hasAsset ? jingle : null;
            player = new InterludePlayer(config);
            player.setOnEnded(ends::add);
        }

        void fireCeiling() {
            for (FakeTiming.Scheduled s : new ArrayList<>(timing.live())) s.fire.run();
        }
    }

    /**
     * A start plays from the first frame and arms the ceiling at INTERLUDE_CEILING_SEC; the file
     * running out ends it once ({@code ended}), and the ceiling is cancelled. TO SEE IT FAIL: arm no
     * ceiling, or report the end twice.
     */
    @Test
    public void aStartEndsOnceWhenTheFileRunsOut() {
        Rig rig = new Rig();
        assertTrue(rig.player.start());
        assertTrue(rig.player.isSounding());
        assertEquals(1, rig.jingle.plays);
        assertEquals(1, rig.timing.live().size());
        assertEquals(Interlude.CEILING_SEC * 1000, rig.timing.live().get(0).afterMs, 0);
        rig.jingle.onFinish.accept(true);
        rig.jingle.onFinish.accept(true);
        assertEquals(List.of("ended"), rig.ends);
        assertFalse(rig.player.isSounding());
        assertTrue("the ceiling goes with the end", rig.timing.live().isEmpty());
    }

    /**
     * THE CEILING: with no completion the jingle is stopped at the ceiling and reported
     * {@code ceiling}, with a row; a completion after that reports nothing. TO SEE IT FAIL: wait on
     * the player's callback alone (the seam would wait forever).
     */
    @Test
    public void theCeilingEndsAJingleThatNeverSaysSo() {
        Rig rig = new Rig();
        rig.player.start();
        rig.fireCeiling();
        assertEquals(List.of("ceiling"), rig.ends);
        assertEquals("the ceiling makes it true: the player is stopped", 1, rig.jingle.stops);
        assertTrue(rig.rows.contains("interlude {\"kind\":\"ceiling\"}"));
        rig.jingle.onFinish.accept(true);
        assertEquals(List.of("ceiling"), rig.ends);
    }

    /**
     * A stop (a transport action cut the beat) silences it with no report, and a late completion
     * of that start stays silent; a restart is a new start with its own end. TO SEE IT FAIL: report
     * an end for a stopped start (the core would shrink a seam that is already gone).
     */
    @Test
    public void aStoppedStartNeverReports() {
        Rig rig = new Rig();
        rig.player.start();
        Consumer<Boolean> first = rig.jingle.onFinish;
        rig.player.stop();
        assertFalse(rig.player.isSounding());
        first.accept(true);
        assertTrue(rig.ends.isEmpty());
        rig.player.start();
        first.accept(true);
        assertTrue("the first start's late end is not the second's", rig.ends.isEmpty());
        rig.jingle.onFinish.accept(false);
        assertEquals(List.of("error"), rig.ends);
    }

    /**
     * The audible-start invariant, a missing asset and a refusing player are all refusals (false,
     * and a row), never a sound; release lets the player go. TO SEE IT FAIL: play with no session.
     */
    @Test
    public void refusalsAreRowsAndReleaseLetsGo() {
        Rig rig = new Rig();
        rig.sessionActive = false;
        assertFalse(rig.player.start());
        assertEquals(0, rig.jingle.plays);
        assertTrue(rig.rows.contains("fault {\"kind\":\"implicit-activation\",\"at\":\"interlude\"}"));
        rig.sessionActive = true;
        rig.jingle.refuse = true;
        assertFalse(rig.player.start());
        assertTrue(rig.rows.contains("interlude {\"kind\":\"refused\",\"why\":\"player\"}"));
        assertTrue(rig.timing.live().isEmpty());
        rig.player.release();
        assertTrue(rig.jingle.released);

        Rig none = new Rig();
        none.hasAsset = false;
        assertFalse(none.player.start());
        assertTrue(none.rows.contains("interlude {\"kind\":\"refused\",\"why\":\"no-asset\"}"));
    }
}

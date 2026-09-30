package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineInput;
import androidx.media3.common.Player;
import java.util.List;
import org.junit.Test;

/**
 * Card A-26: the focus mapping's truth table (plain JUnit). What Media3 does with a focus change,
 * as the player shows it, becomes exactly the session event iOS would have delivered; everything
 * else becomes nothing. {@code FocusIntegrationTest} drives the same mapping from a real ExoPlayer.
 */
public class FocusMappingTest {
    private static final int READY = Player.STATE_READY;
    private static final int TRANSIENT = Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS;
    private static final int NONE = Player.PLAYBACK_SUPPRESSION_REASON_NONE;

    private static EngineInput.SessionEvent only(List<EngineInput.SessionEvent> events) {
        assertEquals("exactly one event: " + events, 1, events.size());
        return events.get(0);
    }

    /**
     * A-41 review: headphones out while a spoken line or the jingle sounds (no deck playing, so
     * Media3's own receiver is off) is a lost route; while the deck plays it is Media3's to report,
     * and with the engine not running it is nothing. TO SEE IT FAIL: answer nothing off the deck (the
     * line keeps talking out of the phone's speaker).
     */
    @Test
    public void becomingNoisyWithNoDeckPlayingIsALostRouteWhileTheEngineRuns() {
        EngineInput.SessionEvent lost = only(FocusMapping.onBecomingNoisyOffDeck(false, true));
        assertTrue(lost instanceof EngineInput.SessionEvent.Route);
        assertTrue(((EngineInput.SessionEvent.Route) lost).change().oldDeviceUnavailable());
        assertTrue("the deck plays: Media3 reports it", FocusMapping.onBecomingNoisyOffDeck(true, true).isEmpty());
        assertTrue("nothing runs: nothing to pause", FocusMapping.onBecomingNoisyOffDeck(false, false).isEmpty());
    }

    @Test
    public void aTransientLossBeginsAnInterruptionAndItsGainEndsItWithShouldResume() {
        FocusMapping f = new FocusMapping();
        EngineInput.SessionEvent began = only(f.onSuppressionChanged(TRANSIENT, READY));
        assertTrue(began instanceof EngineInput.SessionEvent.InterruptionBegan);
        assertTrue(f.transientOpen());
        assertTrue("the same loss again is not a second interruption", f.onSuppressionChanged(TRANSIENT, READY).isEmpty());
        EngineInput.SessionEvent ended = only(f.onSuppressionChanged(NONE, READY));
        assertTrue(ended instanceof EngineInput.SessionEvent.InterruptionEnded);
        assertTrue("focus given back after a transient loss says resume", ((EngineInput.SessionEvent.InterruptionEnded) ended).shouldResume());
        assertFalse(f.transientOpen());
        assertTrue("a lift with nothing open is nothing", f.onSuppressionChanged(NONE, READY).isEmpty());
    }

    @Test
    public void theEndIsHeardWhilePausedBecauseMedia3KeepsTheSuppressionThroughAPause() {
        FocusMapping f = new FocusMapping();
        only(f.onSuppressionChanged(TRANSIENT, READY));
        // The core pauses the deck: play-when-ready off by the user's (the engine's) request.
        assertTrue(f.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST).isEmpty());
        assertTrue("the pause does not close the interruption", f.transientOpen());
        assertTrue(only(f.onSuppressionChanged(NONE, READY)) instanceof EngineInput.SessionEvent.InterruptionEnded);
    }

    @Test
    public void aLiftIntoIdleIsFocusReleasedNotFocusGivenBack() {
        FocusMapping f = new FocusMapping();
        only(f.onSuppressionChanged(TRANSIENT, READY));
        assertTrue("an unload abandons focus; that is no reason to resume", f.onSuppressionChanged(NONE, Player.STATE_IDLE).isEmpty());
        assertFalse(f.transientOpen());
    }

    @Test
    public void aPermanentLossIsAnInterruptionWithNoEnd() {
        FocusMapping f = new FocusMapping();
        only(f.onSuppressionChanged(TRANSIENT, READY));
        EngineInput.SessionEvent began = only(f.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS));
        assertTrue(began instanceof EngineInput.SessionEvent.InterruptionBegan);
        assertFalse("a permanent loss closes any transient one: nothing will give focus back", f.transientOpen());
        assertTrue(f.onSuppressionChanged(NONE, READY).isEmpty());
    }

    @Test
    public void becomingNoisyIsALostRoute() {
        FocusMapping f = new FocusMapping();
        EngineInput.SessionEvent e = only(f.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY));
        assertTrue(e instanceof EngineInput.SessionEvent.Route);
        assertTrue("the old device is gone", ((EngineInput.SessionEvent.Route) e).change().oldDeviceUnavailable());
    }

    @Test
    public void everythingElseIsNothing() {
        FocusMapping f = new FocusMapping();
        assertTrue(f.onPlayWhenReadyChanged(true, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST).isEmpty());
        assertTrue(f.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST).isEmpty());
        assertTrue(f.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM).isEmpty());
        assertTrue(f.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE).isEmpty());
        assertTrue(f.onSuppressionChanged(Player.PLAYBACK_SUPPRESSION_REASON_UNSUITABLE_AUDIO_OUTPUT, READY).isEmpty());
        assertTrue(f.onSuppressionChanged(NONE, READY).isEmpty());
    }
}

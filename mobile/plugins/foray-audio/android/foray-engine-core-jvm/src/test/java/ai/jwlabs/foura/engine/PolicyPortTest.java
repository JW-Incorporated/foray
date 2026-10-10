package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import org.junit.Test;

/**
 * The ports' hand-typed closed sets held to the GENERATED constants (A-23), and the rules
 * the parity families reach only through their adapters: {@code commandAvailability}
 * (NP-5), the rate snap, the hold policy's spelling. The Swift PolicyPortTests and
 * MediaMappingTests, for the JVM port.
 */
public class PolicyPortTest {
    private static <E extends Enum<E>> List<String> tokens(E[] values, java.util.function.Function<E, String> token) {
        List<String> out = new ArrayList<>();
        for (E v : values) out.add(token.apply(v));
        return out;
    }

    /** Every closed set a port spells as an enum is, in order, the JS export it ports (EngineConstants is generated). */
    @Test
    public void theHandTypedSetsAreTheGeneratedOnesInOrder() {
        assertEquals(EngineConstants.EngineContract.SESSION_PHASES, tokens(SessionPolicy.Phase.values(), p -> p.token));
        assertEquals(EngineConstants.EngineContract.SESSION_INPUTS, tokens(SessionPolicy.InputKind.values(), k -> k.token));
        assertEquals(EngineConstants.EngineContract.PLAY_VIAS, tokens(SessionPolicy.PlayVia.values(), v -> v.token));
        assertEquals(EngineConstants.EngineContract.SESSION_ACTIONS, tokens(SessionPolicy.Action.values(), a -> a.token));
        assertEquals(EngineConstants.EngineContract.SESSION_ROWS, tokens(SessionPolicy.Row.values(), r -> r.token));
        assertEquals(EngineConstants.EngineContract.HOLD_POLICY_KINDS, SessionPolicy.HoldPolicy.KINDS);
        assertEquals(EngineConstants.EngineContract.DEFAULT_HOLD_POLICY, SessionPolicy.HoldPolicy.DEFAULT.text());
        assertEquals(EngineConstants.MediaSession.MEDIA_ACTIONS, tokens(MediaAction.values(), a -> a.token));
        assertEquals(EngineConstants.EngineContract.SNAPSHOT_MODES,
                tokens(MediaMapping.CommandSnapshot.Mode.values(), m -> m.token));
        assertEquals(Arrays.asList(EngineConstants.QueueState.EPISODE, EngineConstants.QueueState.TTS),
                tokens(PlayerItemKind.values(), k -> k.token));
    }

    /** The founder's 15/30 reaches the steps from the generated constants, and never from a literal. */
    @Test
    public void theSeekPairIsTheGeneratedOne() {
        assertEquals(EngineConstants.MediaSession.SEEK_BACKWARD_SEC, MediaMapping.SeekSteps.DEFAULT.backwardSec(), 0);
        assertEquals(EngineConstants.MediaSession.SEEK_FORWARD_SEC, MediaMapping.SeekSteps.DEFAULT.forwardSec(), 0);
        MediaMapping.Intent back = MediaMapping.intent(MediaAction.SEEK_BACKWARD, MediaMapping.PressDetails.NONE, MediaMapping.SeekSteps.DEFAULT);
        assertEquals(new MediaMapping.Intent.SeekBy(-EngineConstants.MediaSession.SEEK_BACKWARD_SEC), back);
        assertNull("a scrub with no time is not a seek to zero",
                MediaMapping.intent(MediaAction.SEEK_TO, MediaMapping.PressDetails.NONE, MediaMapping.SeekSteps.DEFAULT));
    }

    /**
     * NP-5: a paused, interrupted or ended EPISODE keeps every target; next / previous
     * follow the neighbours; stop is never enabled; only nothing-loaded and a finished
     * Foray clear Now Playing. TO SEE IT FAIL: enable STOP, or clear on an ended episode.
     */
    @Test
    public void commandAvailabilityFollowsTheSnapshot() {
        MediaMapping.CommandAvailability episode = MediaMapping.commandAvailability(
                new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.EPISODE, true, false, true, false),
                MediaMapping.SeekSteps.DEFAULT, true);
        assertFalse(episode.clearsNowPlaying());
        assertEquals(EnumSet.of(MediaMapping.RemoteCommand.PLAY, MediaMapping.RemoteCommand.PAUSE, MediaMapping.RemoteCommand.TOGGLE_PLAY_PAUSE,
                MediaMapping.RemoteCommand.PREVIOUS_TRACK, MediaMapping.RemoteCommand.SKIP_BACKWARD, MediaMapping.RemoteCommand.SKIP_FORWARD,
                MediaMapping.RemoteCommand.CHANGE_PLAYBACK_POSITION), episode.enabled());
        assertFalse(episode.isEnabled(MediaMapping.RemoteCommand.STOP));
        assertEquals(EngineConstants.MediaSession.SEEK_FORWARD_SEC, episode.skipForwardIntervalSec(), 0);

        MediaMapping.CommandAvailability foray = MediaMapping.commandAvailability(
                new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.FORAY, false, true, false, true),
                MediaMapping.SeekSteps.DEFAULT, true);
        assertTrue(foray.isEnabled(MediaMapping.RemoteCommand.NEXT_TRACK));
        assertFalse(foray.isEnabled(MediaMapping.RemoteCommand.PREVIOUS_TRACK));

        for (MediaMapping.CommandSnapshot done : new MediaMapping.CommandSnapshot[] {
            new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.FORAY, true, true, true, true),
            new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.UNLOADED, false, false, false, false)}) {
            MediaMapping.CommandAvailability a = MediaMapping.commandAvailability(done, MediaMapping.SeekSteps.DEFAULT, true);
            assertTrue(a.clearsNowPlaying());
            assertTrue(a.enabled().isEmpty());
        }
    }

    /**
     * CH3-10 (R1-03): the track pair only where a track button exists, in the core. With a
     * neighbour on both sides, no track route enables the skip pair and NOT the track pair; a
     * track route enables both. TO SEE IT FAIL: drop {@code && trackRoute} from either term.
     */
    @Test
    public void theTrackPairNeedsATrackRoute() {
        MediaMapping.CommandSnapshot upNext =
                new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.EPISODE, false, true, true, true);
        MediaMapping.CommandAvailability speaker = MediaMapping.commandAvailability(upNext, MediaMapping.SeekSteps.DEFAULT, false);
        assertFalse(speaker.isEnabled(MediaMapping.RemoteCommand.NEXT_TRACK));
        assertFalse(speaker.isEnabled(MediaMapping.RemoteCommand.PREVIOUS_TRACK));
        assertTrue(speaker.isEnabled(MediaMapping.RemoteCommand.SKIP_FORWARD));
        assertTrue(speaker.isEnabled(MediaMapping.RemoteCommand.SKIP_BACKWARD));
        MediaMapping.CommandAvailability car = MediaMapping.commandAvailability(upNext, MediaMapping.SeekSteps.DEFAULT, true);
        assertTrue(car.isEnabled(MediaMapping.RemoteCommand.NEXT_TRACK));
        assertTrue(car.isEnabled(MediaMapping.RemoteCommand.PREVIOUS_TRACK));
    }

    static MediaMapping.View bufferingView(Double durationSec) {
        MediaMapping.View v = new MediaMapping.View();
        v.item = new MediaMapping.Item("episode", "An episode", "A show");
        v.durationSec = durationSec;
        v.positionSec = 3.0;
        v.playbackRate = 1.5;
        v.playing = true;
        v.buffering = true;
        return v;
    }

    /**
     * CH3-22 characterization (survives): a buffering view with a known duration reports a rate
     * of 0; with no known duration it reports no position state at all, so the rate cannot be
     * where a reader learns the view is buffering (R5-08).
     */
    @Test
    public void aBufferingViewStopsTheClockOnlyWhereThereIsOne() {
        MediaMapping.SessionView known = MediaMapping.sessionView(bufferingView(90.0));
        assertEquals(0.0, known.positionState().playbackRate(), 0);
        assertEquals(MediaMapping.PLAYING, known.playbackState());
        MediaMapping.SessionView unknown = MediaMapping.sessionView(bufferingView(null));
        assertNull(unknown.positionState());
        assertEquals(MediaMapping.PLAYING, unknown.playbackState());
    }

    /**
     * CH3-22 (R5-08): the session view carries the view's {@code buffering} as is, duration or
     * not, so a reader never has to infer it from the rate.
     * MUTATION: pass {@code false} (or {@code positionState(...) != null && rate == 0}) for
     * {@code buffering} in sessionView: red here.
     */
    @Test
    public void theSessionViewCarriesBufferingDurationOrNot() {
        assertTrue(MediaMapping.sessionView(bufferingView(90.0)).buffering());
        assertTrue("no duration: still buffering", MediaMapping.sessionView(bufferingView(null)).buffering());
        MediaMapping.View steady = bufferingView(null);
        steady.buffering = false;
        assertFalse(MediaMapping.sessionView(steady).buffering());
    }

    /** {@code setRate}'s decision: snapped onto the ladder, and it SAYS it snapped. */
    @Test
    public void aSnappedRateSaysSo() {
        assertEquals(new PlaybackRate.Snap(1.25, true), PlaybackRate.snap(1.3));
        assertEquals(new PlaybackRate.Snap(1.5, false), PlaybackRate.snap(1.5));
        assertEquals(new PlaybackRate.Snap(1.0, true), PlaybackRate.snap(null));
        assertEquals(EngineConstants.PlaybackRate.RATES, PlaybackRate.RATES);
    }

    /** The hold policy's one-string spelling round-trips, and nothing outside the pattern parses. */
    @Test
    public void theHoldPolicyRoundTripsItsSpelling() {
        for (String text : new String[] {"forever", "none", "until:1", "until:999999"}) {
            assertEquals(text, SessionPolicy.HoldPolicy.parse(text).text());
        }
        for (String text : new String[] {"until:0", "until:01", "until:1000000", "until:", "until:5m", "Forever", "", "until:١"}) {
            assertNull(text, SessionPolicy.HoldPolicy.parse(text));
        }
    }

    /** The audible-start invariant: a result nobody asked for is not an activation, and a deactivate ends it. */
    @Test
    public void anUnaskedSuccessIsNotAnActivation() {
        assertEquals(Arrays.asList(new SessionPolicy.Violation(1, "deckPlay")), SessionPolicy.audibleStartViolations(
                SessionPolicy.Phase.INACTIVE, Arrays.asList("sessionResult:ok", "deckPlay")));
        assertTrue(SessionPolicy.audibleStartViolations(SessionPolicy.Phase.INACTIVE,
                Arrays.asList("sessionActivate", "sessionResult:ok", "deckPlay")).isEmpty());
        assertEquals(1, SessionPolicy.audibleStartViolations(SessionPolicy.Phase.ACTIVE,
                Arrays.asList("sessionDeactivate", "speak")).size());
    }

    /** Two segments of one episode are two queue items: identity includes the bounds. */
    @Test
    public void identityIncludesTheBounds() {
        QueueItemRef a = new QueueItemRef("ep", PlayerItemKind.EPISODE, ItemBounds.make(10.0, 20.0));
        QueueItemRef b = new QueueItemRef("ep", PlayerItemKind.EPISODE, ItemBounds.make(20.0, 30.0));
        assertFalse(QueueItemRef.sameRef(a, b));
        assertTrue(QueueItemRef.sameRef(a, new QueueItemRef("ep", PlayerItemKind.EPISODE, ItemBounds.make(10.0, 20.0))));
        assertTrue(QueueItemRef.sameRef(null, null));
        PlayerQueueStateMachine.Transition t = PlayerQueueStateMachine.reduce(new PlayerQueueState.Playing(a), new PlayerEvent.Play(b));
        assertEquals("the second segment is not a repeat of the first", new PlayerQueueState.LoadingItem(b, a), t.state());
        assertEquals("playing(ep[10-20])", PlayerQueueStateMachine.describe(new PlayerQueueState.Playing(a)));
    }
}

package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineInput;
import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * THE FOCUS MAPPING (card A-26): what the deck's ExoPlayer says about audio focus and the output,
 * as the audio-session events the core already knows from iOS ({@code interruptionBegan},
 * {@code interruptionEnded(shouldResume)}, {@code routeChange(oldDeviceUnavailable)}).
 *
 * <h2>WHY THIS READS THE PLAYER AND NOT AudioManager</h2>
 *
 * The deck's player is built with {@code setAudioAttributes(CONTENT_TYPE_SPEECH, USAGE_MEDIA,
 * handleAudioFocus = true)} and {@code setHandleAudioBecomingNoisy(true)}. So Media3 owns the one
 * focus request this app makes, and a second request of ours would take focus from our own
 * player. What Media3 does with a focus change is observable on the player, and that is the
 * whole input here (Media3 1.11, {@code AudioFocusManager} and
 * {@code ExoPlayerImplInternal.updatePlaybackSuppressionReason}, read from the source):
 * <ul>
 *   <li>{@code AUDIOFOCUS_LOSS} (another media app took over): play-when-ready goes false with
 *       {@link Player#PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS}, and Media3 abandons its
 *       request. Nothing will give it back: an interruption with no end, as iOS reports another
 *       app's playback.</li>
 *   <li>{@code AUDIOFOCUS_LOSS_TRANSIENT}, AND {@code _CAN_DUCK} because the content type is
 *       SPEECH ({@code willPauseWhenDucked}): the suppression reason becomes
 *       {@link Player#PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS}. A navigation
 *       prompt pauses a spoken Foray rather than ducking it under the prompt, which is the
 *       card's "a duck becomes pause-and-resume".</li>
 *   <li>{@code AUDIOFOCUS_GAIN} after a transient loss: the suppression lifts. It lifts EVEN
 *       WHILE PAUSED, because Media3 keeps its focus state through a pause
 *       ({@code updateAudioFocus(false, …)} answers WAIT_FOR_CALLBACK in LOSS_TRANSIENT) and the
 *       gain's PLAY_WHEN_READY command recomputes the reason. That matters: the core's answer
 *       to the loss is to pause the deck, and the end of the interruption still has to be
 *       heard afterwards.</li>
 *   <li>{@code ACTION_AUDIO_BECOMING_NOISY}: play-when-ready false with
 *       {@link Player#PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY}: the output went away
 *       (headphones out, Bluetooth gone), which the core reads as a lost route (pause, and no
 *       resume by itself, corner case #13).</li>
 * </ul>
 *
 * <h2>BECOMING NOISY WITH NO DECK PLAYING (A-41 review)</h2>
 *
 * Media3 listens for {@code ACTION_AUDIO_BECOMING_NOISY} only while its player has play-when-ready
 * on. A Foray is audible with no deck playing in two places: a SPOKEN line ({@code TextToSpeech}, in
 * another process) and the seam's JINGLE ({@code MediaPlayer}), both with the outgoing deck paused at
 * its out-point. Headphones pulled out there would leave the line or the jingle on the phone's
 * speaker, where iOS (whose route change is the session's, not a player's) pauses. So the service
 * keeps its own receiver and asks {@link #onBecomingNoisyOffDeck}: the lost route is fed only when
 * the engine is running and the deck is NOT playing (when it is, Media3's receiver already answers
 * through {@link #onPlayWhenReadyChanged}, and the core's pause makes a second report not running).
 *
 * <h2>WHAT IS NOT AN END</h2>
 *
 * The suppression also lifts when the player goes IDLE (an unload releases focus: Media3's
 * {@code shouldHandleAudioFocus(STATE_IDLE)} is false and it abandons), and that is not the
 * system giving focus back. So a lift is an end only while the player still holds a source.
 * With nothing loaded the pending interruption is dropped and the next play asks for focus
 * afresh, as a listener's press would.
 *
 * <p>Pure: no Android type is read here but {@link Player}'s int constants, so the mapping is a
 * plain JUnit truth table ({@code FocusMappingTest}); {@code FocusIntegrationTest} runs it on a
 * real ExoPlayer with Robolectric's AudioManager.
 */
@OptIn(markerClass = UnstableApi.class)
public final class FocusMapping {
    /** The row token for the reason of a focus interruption. The core's vocabulary has no focus reason, so it is {@code default}. */
    static final String REASON = "default";

    /** A transient loss is open: the next lift of the suppression, with a source held, is its end. */
    private boolean transientOpen;

    public boolean transientOpen() {
        return transientOpen;
    }

    /** {@code Player.Listener.onPlayWhenReadyChanged}. */
    public List<EngineInput.SessionEvent> onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
        if (playWhenReady) return Collections.emptyList();
        switch (reason) {
            case Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS: {
                // Permanent: whatever transient loss was open, nothing will end it now.
                transientOpen = false;
                return one(new EngineInput.SessionEvent.InterruptionBegan(REASON));
            }
            case Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY:
                return one(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true)));
            default:
                return Collections.emptyList();
        }
    }

    /**
     * {@code Player.Listener.onPlaybackSuppressionReasonChanged}, with the player's playback
     * state at that moment (a lift into IDLE is focus released, not focus given back).
     */
    public List<EngineInput.SessionEvent> onSuppressionChanged(int suppressionReason, int playbackState) {
        if (suppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS) {
            if (transientOpen) return Collections.emptyList();
            transientOpen = true;
            return one(new EngineInput.SessionEvent.InterruptionBegan(REASON));
        }
        if (!transientOpen) return Collections.emptyList();
        transientOpen = false;
        if (playbackState == Player.STATE_IDLE) return Collections.emptyList();
        return one(new EngineInput.SessionEvent.InterruptionEnded(true));
    }

    /**
     * The service's own {@code ACTION_AUDIO_BECOMING_NOISY} receiver (see BECOMING NOISY WITH NO
     * DECK PLAYING): a lost route when the engine is running ({@code EngineState.isRunning}) and the
     * active deck's play-when-ready is off, and nothing otherwise.
     */
    public static List<EngineInput.SessionEvent> onBecomingNoisyOffDeck(boolean deckPlayWhenReady, boolean engineRunning) {
        if (deckPlayWhenReady || !engineRunning) return Collections.emptyList();
        return one(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true)));
    }

    private static List<EngineInput.SessionEvent> one(EngineInput.SessionEvent event) {
        List<EngineInput.SessionEvent> out = new ArrayList<>(1);
        out.add(event);
        return out;
    }
}

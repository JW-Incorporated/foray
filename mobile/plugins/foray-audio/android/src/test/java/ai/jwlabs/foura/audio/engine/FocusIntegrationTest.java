package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import ai.jwlabs.foura.engine.EngineInput;
import android.content.Context;
import android.media.AudioManager;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.test.utils.FakeClock;
import androidx.media3.test.utils.TestExoPlayerBuilder;
import androidx.media3.test.utils.robolectric.RobolectricUtil;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAudioManager;

/**
 * Card A-26: the focus mapping on a REAL ExoPlayer configured as the service configures the
 * deck's ({@link EngineAudio#configure}), with Robolectric's AudioManager delivering the focus
 * changes. It pins the two things the mapping's truth table cannot: that Media3 1.11 really asks
 * for focus when the deck plays (the audible-start half the session seam leaves to it), and that
 * a DUCK on speech really comes back as a transient loss and its gain as the end of it, which is
 * the card's "a duck becomes pause-and-resume", while a permanent loss has no end.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
@OptIn(markerClass = UnstableApi.class)
public class FocusIntegrationTest {
    private final Context context = ApplicationProvider.getApplicationContext();
    private ExoPlayer player;
    private final FocusMapping focus = new FocusMapping();
    private final List<EngineInput.SessionEvent> events = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        player = new TestExoPlayerBuilder(context)
                .setClock(new FakeClock(/* isAutoAdvancing= */ true))
                .setRenderers(new CapturingAudioRenderer())
                .build();
        EngineAudio.configure(player);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                events.addAll(focus.onPlayWhenReadyChanged(playWhenReady, reason));
            }

            @Override
            public void onPlaybackSuppressionReasonChanged(int reason) {
                events.addAll(focus.onSuppressionChanged(reason, player.getPlaybackState()));
            }
        });
        ClickTracks.Fixture cbr = null;
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.file.equals("click-cbr.mp3")) cbr = f;
        assertNotNull(cbr);
        player.setMediaSource(new ProgressiveMediaSource.Factory(new DefaultDataSource.Factory(context))
                .createMediaSource(MediaItem.fromUri(cbr.uri())));
        player.prepare();
        player.play();
        RobolectricUtil.runMainLooperUntil(() -> player.isPlaying());
    }

    @After
    public void tearDown() {
        player.release();
    }

    private ShadowAudioManager.AudioFocusRequest request() {
        AudioManager am = context.getSystemService(AudioManager.class);
        ShadowAudioManager.AudioFocusRequest r = shadowOf(am).getLastAudioFocusRequest();
        assertNotNull("Media3 asked for audio focus when the deck played", r);
        return r;
    }

    private <T extends EngineInput.SessionEvent> T await(Class<T> type) throws Exception {
        RobolectricUtil.runMainLooperUntil(() -> events.stream().anyMatch(type::isInstance));
        for (EngineInput.SessionEvent e : events) if (type.isInstance(e)) return type.cast(e);
        throw new AssertionError("no " + type.getSimpleName());
    }

    @Test
    public void theDeckAsksForMediaFocusAsSpeech() {
        ShadowAudioManager.AudioFocusRequest r = request();
        assertNotNull(r.audioFocusRequest);
        assertEquals(AudioManager.AUDIOFOCUS_GAIN, r.audioFocusRequest.getFocusGain());
        assertEquals(android.media.AudioAttributes.CONTENT_TYPE_SPEECH, r.audioFocusRequest.getAudioAttributes().getContentType());
        assertEquals(android.media.AudioAttributes.USAGE_MEDIA, r.audioFocusRequest.getAudioAttributes().getUsage());
        assertTrue("a duck is a pause for speech", r.audioFocusRequest.willPauseWhenDucked());
    }

    @Test
    public void aDuckIsAPauseAndItsGainIsTheEndOfTheInterruption() throws Exception {
        ShadowAudioManager.AudioFocusRequest r = request();
        r.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK);
        await(EngineInput.SessionEvent.InterruptionBegan.class);
        RobolectricUtil.runMainLooperUntil(() -> !player.isPlaying());
        assertEquals("paused, not ducked", Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS,
                player.getPlaybackSuppressionReason());
        // The engine's answer to the interruption is to pause the deck; the end must still be heard.
        player.pause();
        r.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN);
        EngineInput.SessionEvent.InterruptionEnded ended = await(EngineInput.SessionEvent.InterruptionEnded.class);
        assertTrue("focus back after a transient loss says resume", ended.shouldResume());
        assertFalse("the mapping never plays: the core does, through the deck", player.getPlayWhenReady());
    }

    @Test
    public void aPermanentLossIsAnInterruptionThatNeverEnds() throws Exception {
        ShadowAudioManager.AudioFocusRequest r = request();
        r.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS);
        await(EngineInput.SessionEvent.InterruptionBegan.class);
        assertFalse(player.getPlayWhenReady());
        RobolectricUtil.runMainLooperUntil(() -> true);
        assertFalse("no end was mapped", events.stream().anyMatch(e -> e instanceof EngineInput.SessionEvent.InterruptionEnded));
    }
}

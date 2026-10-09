package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import ai.jwlabs.foura.engine.EngineInput;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.Clock;
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
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
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
    /** Every play-when-ready change the main thread was told of, as {@code "<pwr>/<reason>"}. */
    private final List<String> playWhenReadyChanges = new ArrayList<>();

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
                playWhenReadyChanges.add(playWhenReady + "/" + reason);
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
        until(() -> player.isPlaying());
    }

    @After
    public void tearDown() {
        player.release();
    }

    /**
     * Run the main looper until the condition holds. The FakeClock is virtual, but the bound is
     * wall time, and RobolectricUtil's 10 s default is what timed A-25's ExoDeckTest out on a
     * busy runner (android-build run 36650414482, attempt 1): a minute costs nothing when green.
     */
    static void until(BooleanSupplier condition) throws TimeoutException {
        RobolectricUtil.runMainLooperUntil(condition::getAsBoolean, DeckHarness.WAIT_MS, Clock.DEFAULT);
    }

    private ShadowAudioManager.AudioFocusRequest request() {
        AudioManager am = context.getSystemService(AudioManager.class);
        ShadowAudioManager.AudioFocusRequest r = shadowOf(am).getLastAudioFocusRequest();
        assertNotNull("Media3 asked for audio focus when the deck played", r);
        return r;
    }

    private <T extends EngineInput.SessionEvent> T await(Class<T> type) throws Exception {
        until(() -> events.stream().anyMatch(type::isInstance));
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
        until(() -> !player.isPlaying());
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
        until(() -> true);
        assertFalse("no end was mapped", events.stream().anyMatch(e -> e instanceof EngineInput.SessionEvent.InterruptionEnded));
    }

    @Test
    public void aTransientLossThatBecomesPermanentIsNeverEnded() throws Exception {
        /* The call that ends in another app's music: LOSS_TRANSIENT, the core pauses the deck,
           then AUDIOFOCUS_LOSS. Media3 1.11 lifts the transient suppression as it abandons focus,
           and the lift is not the system giving focus back. It reads right only because Media3
           reports the permanent loss (play-when-ready's reason becomes AUDIO_FOCUS_LOSS) BEFORE
           the lift, in the same update, which closes the transient span first. MUTATION: map
           the lift before the reason, or ignore a reason change with play-when-ready already
           false, and this resumes the deck over the other app. */
        ShadowAudioManager.AudioFocusRequest r = request();
        r.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT);
        await(EngineInput.SessionEvent.InterruptionBegan.class);
        player.pause();
        until(() -> !player.isPlaying());
        assertTrue(focus.transientOpen());
        r.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS);
        until(() -> events.stream().filter(e -> e instanceof EngineInput.SessionEvent.InterruptionBegan).count() >= 2);
        until(() -> player.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE);
        assertFalse("the permanent loss closed the transient span", focus.transientOpen());
        assertFalse("no end was mapped: nothing resumes over the app that took focus",
                events.stream().anyMatch(e -> e instanceof EngineInput.SessionEvent.InterruptionEnded));
    }

    @Test
    public void aPlayRefusedFocusReadsAsPlayingInItsTurnAndArrivesLaterAsAPermanentLoss() throws Exception {
        /* CH3-08 / R5-02, CHARACTERIZATION (today's behaviour, the card's premise checked): the
           driver is on a call and presses play. Focus was given up for good earlier (another
           app's playback: Media3 abandoned its request), so the play asks afresh and the system
           answers AUDIOFOCUS_REQUEST_FAILED.

           What it pins: Media3 1.11 asks for focus on the PLAYBACK thread (AudioFocusManager
           lives in ExoPlayerImplInternal; ExoPlayerImpl has none), so getPlayWhenReady() read in
           the same main-thread turn as play() is the masked TRUE: a read-back there sees no
           refusal. The refusal reaches the main thread a turn later as play-when-ready false
           with reason AUDIO_FOCUS_LOSS, the same signal as a permanent loss, and the mapping
           makes it an interruption: R5-02's "success + an interruption" instead of iOS's
           commandFailed. MUTATION: drop the AUDIO_FOCUS_LOSS case from
           FocusMapping.onPlayWhenReadyChanged and this times out awaiting the interruption. */
        AudioManager am = context.getSystemService(AudioManager.class);
        ShadowAudioManager.AudioFocusRequest held = request();
        held.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS);
        await(EngineInput.SessionEvent.InterruptionBegan.class);
        until(() -> !player.getPlayWhenReady());
        events.clear();
        playWhenReadyChanges.clear();

        shadowOf(am).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED);
        player.play();
        assertTrue("in the play's own turn the refusal is not visible: Media3 masks play-when-ready true",
                player.getPlayWhenReady());

        await(EngineInput.SessionEvent.InterruptionBegan.class);
        assertFalse("Media3 would not play without focus", player.getPlayWhenReady());
        assertTrue("the play asked for focus afresh", shadowOf(am).getLastAudioFocusRequest() != held);
        assertEquals("the refusal arrives as a permanent focus loss, after the masked true",
                List.of("true/" + Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST,
                        "false/" + Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS),
                playWhenReadyChanges);
        assertFalse("nothing sounds", player.isPlaying());
    }

    @Test
    public void becomingNoisyIsALostRouteAndThePlayerPauses() throws Exception {
        /* setHandleAudioBecomingNoisy(true) on the configured player, end to end: Media3 registers
           its receiver on the playback thread, so the broadcast is repeated until it lands.
           MUTATION: drop setHandleAudioBecomingNoisy from EngineAudio.configure and this times
           out with the player still playing. */
        until(() -> {
            if (events.stream().noneMatch(e -> e instanceof EngineInput.SessionEvent.Route)) {
                context.sendBroadcast(new Intent(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
            }
            return events.stream().anyMatch(e -> e instanceof EngineInput.SessionEvent.Route);
        });
        EngineInput.SessionEvent.Route route = await(EngineInput.SessionEvent.Route.class);
        assertTrue("headphones out is the old device gone", route.change().oldDeviceUnavailable());
        assertFalse("Media3 paused the deck's player", player.getPlayWhenReady());
    }
}

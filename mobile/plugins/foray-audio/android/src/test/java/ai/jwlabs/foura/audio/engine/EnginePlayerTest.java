package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.MediaMapping;
import android.os.Looper;
import androidx.media3.common.Player;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

/**
 * Card A-26: the session's player, the {@link EnginePlayer} facade. What the session commands
 * are (the core's command availability, one to one), what the lock screen reads (the core's
 * session view), and that every command a controller, a media button or the notification can
 * send arrives as the matching {@link EngineInput.RemotePress}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class EnginePlayerTest {
    /** The engine behind the facade: a surface the test sets, and every press it received. */
    static final class FakeEngine implements EnginePlayer.Engine {
        ForayEngineHost.Surface surface;
        final List<EngineInput.RemotePress> presses = new ArrayList<>();
        /** A-27: what {@code canResume} answers, and the surface a {@code resume} paints. */
        boolean resumable;
        ForayEngineHost.Surface painted;
        int resumes;

        @Override
        public ForayEngineHost.Surface surface() {
            return surface;
        }

        @Override
        public boolean canResume() {
            return resumable;
        }

        @Override
        public void resume() {
            resumes++;
            if (painted != null) surface = painted;
        }

        @Override
        public ForayEngineHost.Verdict remote(EngineInput.RemotePress press) {
            presses.add(press);
            return new ForayEngineHost.Verdict(Collections.<String>emptyList(), false);
        }
    }

    static ForayEngineHost.Surface idle() {
        MediaMapping.CommandSnapshot snap = new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.UNLOADED,
                false, false, false, false);
        return new ForayEngineHost.Surface(MediaMapping.commandAvailability(snap, MediaMapping.SeekSteps.DEFAULT), null, false, 0);
    }

    static ForayEngineHost.Surface episode(boolean playing, boolean canNext, boolean buffering) {
        MediaMapping.CommandSnapshot snap = new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.EPISODE,
                false, canNext, true, false);
        MediaMapping.View v = new MediaMapping.View();
        v.item = new MediaMapping.Item("episode", "An episode", "A show");
        v.showArtworkUrl = "https://cdn.example/art.jpg";
        v.durationSec = 90.0;
        v.positionSec = 12.0;
        v.playbackRate = 1.0;
        v.playing = playing;
        v.buffering = buffering;
        return new ForayEngineHost.Surface(MediaMapping.commandAvailability(snap, MediaMapping.SeekSteps.DEFAULT),
                MediaMapping.sessionView(v), buffering, 1);
    }

    /** An episode at the listener's {@code rate}, as the host publishes it (A-60): the view's clock rate is 0 through a stall, the listening rate is not. */
    static ForayEngineHost.Surface episodeAt(double rate, boolean playing, boolean buffering) {
        MediaMapping.CommandSnapshot snap = new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.EPISODE,
                false, true, true, false);
        MediaMapping.View v = new MediaMapping.View();
        v.item = new MediaMapping.Item("episode", "An episode", "A show");
        v.durationSec = 90.0;
        v.positionSec = 12.0;
        v.playbackRate = rate;
        v.playing = playing;
        v.buffering = buffering;
        return new ForayEngineHost.Surface(MediaMapping.commandAvailability(snap, MediaMapping.SeekSteps.DEFAULT),
                MediaMapping.sessionView(v), buffering, 1, rate);
    }

    /**
     * What Media3's session publishes as the platform speed for this player
     * ({@code MediaSessionLegacyStub.createPlaybackStateCompat}, media3 1.11.0:
     * {@code player.isPlaying() && canReadPositions ? speed : 0}). The session reads the facade;
     * this reads the facade the same way, so the pin is on what the facade tells it.
     */
    static float sessionSpeed(Player p) {
        boolean canReadPositions = p.isCommandAvailable(Player.COMMAND_GET_CURRENT_MEDIA_ITEM) && !p.isCurrentMediaItemLive();
        return p.isPlaying() && canReadPositions ? p.getPlaybackParameters().speed : 0f;
    }

    private static EnginePlayer facade(FakeEngine engine) {
        return new EnginePlayer(Looper.getMainLooper(), engine);
    }

    @Test
    public void nothingLoadedIsIdleWithNoTransport() {
        FakeEngine e = new FakeEngine();
        e.surface = idle();
        EnginePlayer p = facade(e);
        assertEquals(Player.STATE_IDLE, p.getPlaybackState());
        assertTrue(p.getCurrentTimeline().isEmpty());
        assertFalse("no play button with nothing to play", p.isCommandAvailable(Player.COMMAND_PLAY_PAUSE));
        assertTrue("the read-only commands are always there", p.isCommandAvailable(Player.COMMAND_GET_METADATA));
        p.release();
    }

    @Test
    public void thePlayingEpisodeIsWhatTheCoreSaysItIs() {
        FakeEngine e = new FakeEngine();
        e.surface = episode(true, true, false);
        EnginePlayer p = facade(e);
        assertEquals(Player.STATE_READY, p.getPlaybackState());
        assertTrue(p.getPlayWhenReady());
        assertEquals("An episode", String.valueOf(p.getMediaMetadata().title));
        assertEquals("A show", String.valueOf(p.getMediaMetadata().artist));
        assertEquals("https://cdn.example/art.jpg", String.valueOf(p.getMediaMetadata().artworkUri));
        assertEquals("previous, now, next: a neighbourhood of three", 3, p.getMediaItemCount());
        assertEquals(1, p.getCurrentMediaItemIndex());
        assertEquals(12_000, p.getCurrentPosition(), 1_000);
        assertEquals(90_000, p.getDuration());
        assertEquals("the founder's pair", 15_000, p.getSeekBackIncrement());
        assertEquals(30_000, p.getSeekForwardIncrement());
        for (int c : new int[] {Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_BACK,
                Player.COMMAND_SEEK_FORWARD, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM}) {
            assertTrue("command " + c + " is enabled by the core", p.isCommandAvailable(c));
        }
        assertFalse("a remote stop is never offered (T-7)", p.isCommandAvailable(Player.COMMAND_STOP));
        assertFalse("the rate is the listener's, not a controller's", p.isCommandAvailable(Player.COMMAND_SET_SPEED_AND_PITCH));
        p.release();
    }

    @Test
    public void noNextMeansNoNextButton() {
        FakeEngine e = new FakeEngine();
        e.surface = episode(false, false, false);
        EnginePlayer p = facade(e);
        assertFalse(p.getPlayWhenReady());
        assertEquals("paused is READY, play-when-ready off", Player.STATE_READY, p.getPlaybackState());
        assertFalse(p.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT));
        assertEquals("previous and now", 2, p.getMediaItemCount());
        p.release();
    }

    @Test
    public void aStallIsBufferingSoTheLockScreensClockStops() {
        FakeEngine e = new FakeEngine();
        e.surface = episode(true, false, true);
        EnginePlayer p = facade(e);
        assertEquals(Player.STATE_BUFFERING, p.getPlaybackState());
        assertTrue("the controls still say pause", p.getPlayWhenReady());
        p.release();
    }

    /**
     * Card A-60, the Android side of #866's rate latch. A Media3 session derives its state from the
     * player, so the latch iOS had (Now Playing's rate stuck at 0 while the clock ran) cannot recur
     * as such; what is pinned is what the facade tells the session: the LISTENING speed in its
     * playback parameters at all times, READY and playing while playing (published: the listening
     * speed), and BUFFERING through a stall (published: 0), and the listening speed again the moment
     * it plays. TO SEE IT FAIL: take the speed from the view's clock rate (a stall then says 1x,
     * and a 1.5x listener's session reads 1x while buffering), or leave a stall READY (published:
     * the speed, with the clock standing still).
     */
    @Test
    public void theSessionPublishesTheListeningSpeedWhilePlayingAndZeroOnlyWhileBuffering() {
        FakeEngine e = new FakeEngine();
        e.surface = episodeAt(1.5, true, false);
        EnginePlayer p = facade(e);
        assertEquals(Player.STATE_READY, p.getPlaybackState());
        assertTrue(p.isPlaying());
        assertEquals(1.5f, p.getPlaybackParameters().speed, 0);
        assertEquals("playing: the listening speed", 1.5f, sessionSpeed(p), 0);

        e.surface = episodeAt(1.5, true, true);
        p.refresh();
        assertEquals(Player.STATE_BUFFERING, p.getPlaybackState());
        assertTrue("the controls still say pause", p.getPlayWhenReady());
        assertFalse(p.isPlaying());
        assertEquals("the listener's speed is still the listener's", 1.5f, p.getPlaybackParameters().speed, 0);
        assertEquals("buffering: 0, the clock stands still", 0f, sessionSpeed(p), 0);

        e.surface = episodeAt(1.5, true, false);
        p.refresh();
        assertTrue(p.isPlaying());
        assertEquals("playing again: the listening speed, nothing latched", 1.5f, sessionSpeed(p), 0);

        e.surface = episodeAt(1.5, false, false);
        p.refresh();
        assertEquals("paused is READY with play-when-ready off", Player.STATE_READY, p.getPlaybackState());
        assertEquals(0f, sessionSpeed(p), 0);
        assertEquals(1.5f, p.getPlaybackParameters().speed, 0);
        p.release();
    }

    /** A surface with no listening rate (a test's, or a host's before its first turn) publishes 1x, never 0. */
    @Test
    public void aSurfaceWithNoListeningRatePublishesOneX() {
        assertEquals(1f, EnginePlayer.publishedSpeed(episode(true, false, true)), 0);
        assertEquals(1f, EnginePlayer.publishedSpeed(episodeAt(0, true, false)), 0);
        assertEquals(1f, EnginePlayer.publishedSpeed(episodeAt(Double.NaN, true, false)), 0);
        assertEquals(2f, EnginePlayer.publishedSpeed(episodeAt(2, true, true)), 0);
    }

    @Test
    public void everySessionCommandIsARemotePress() {
        FakeEngine e = new FakeEngine();
        e.surface = episode(true, true, false);
        EnginePlayer p = facade(e);
        p.pause();
        e.surface = episode(false, true, false);
        p.refresh();
        p.play();
        e.surface = episode(true, true, false);
        p.refresh();
        p.seekToNext();
        p.seekToPrevious();
        p.seekBack();
        p.seekForward();
        p.seekTo(42_000);
        ShadowLooper.idleMainLooper();
        List<MediaMapping.RemoteCommand> got = new ArrayList<>();
        for (EngineInput.RemotePress press : e.presses) got.add(press.command());
        assertEquals(List.of(MediaMapping.RemoteCommand.PAUSE, MediaMapping.RemoteCommand.PLAY, MediaMapping.RemoteCommand.NEXT_TRACK,
                MediaMapping.RemoteCommand.PREVIOUS_TRACK, MediaMapping.RemoteCommand.SKIP_BACKWARD,
                MediaMapping.RemoteCommand.SKIP_FORWARD, MediaMapping.RemoteCommand.CHANGE_PLAYBACK_POSITION), got);
        assertNull("a skip carries no step: the core's pair is the step, not Media3's increment", e.presses.get(4).value());
        assertNull(e.presses.get(5).value());
        assertEquals("a scrub carries its time, in seconds", 42.0, e.presses.get(6).value(), 0.0005);
        assertTrue("pressed on main", e.presses.get(0).onMain());
        p.release();
    }

    /**
     * A-27: an empty session that can resume declares exactly Media3's two resumption commands;
     * setting the answer's item is the engine's resume (the item itself is not played); and the
     * state after it is the engine's painted one. TO SEE IT FAIL: declare them whenever idle, or
     * play the handed item instead of resuming.
     */
    @Test
    public void anEmptySessionThatCanResumeTakesTheAnswerAsAResume() {
        FakeEngine e = new FakeEngine();
        e.surface = idle();
        EnginePlayer p = facade(e);
        assertFalse(p.isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM));
        e.resumable = true;
        p.refresh();
        assertTrue("Media3 resumes only a player that can take an item", p.isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM));
        assertTrue("and can play", p.isCommandAvailable(Player.COMMAND_PLAY_PAUSE));
        assertFalse("nothing else", p.isCommandAvailable(Player.COMMAND_CHANGE_MEDIA_ITEMS));
        assertFalse(p.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT));

        e.painted = episode(false, false, false);
        e.resumable = false;
        p.setMediaItem(androidx.media3.common.MediaItem.fromUri("https://elsewhere.example/other.mp3"), 5_000);
        ShadowLooper.idleMainLooper();
        assertEquals(1, e.resumes);
        assertEquals("the engine's painted state, not the handed item", "An episode", String.valueOf(p.getMediaMetadata().title));
        assertEquals(Player.STATE_READY, p.getPlaybackState());
        assertFalse(p.getPlayWhenReady());
        assertTrue("nothing was pressed", e.presses.isEmpty());
        p.release();
    }
}

package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.EnginePlayer;
import ai.jwlabs.foura.audio.engine.ExoDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.engine.DeckDeadlineClass;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.MediaMapping;
import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Looper;
import androidx.media3.common.C;
import androidx.test.core.app.ApplicationProvider;
import java.util.Collections;
import org.robolectric.Shadows;
import org.robolectric.shadows.AudioDeviceInfoBuilder;
import org.robolectric.shadows.ShadowAudioManager;
import androidx.media3.common.Player;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;

/**
 * Card A-26: {@link ForayPlaybackService}, the MediaSessionService shell, created and destroyed
 * by Robolectric. One session whose player is the engine facade; the deck's player configured
 * as speech with focus handled and becoming-noisy on; the 15/30 pair as the session's buttons
 * and granted as custom commands, each one a remote press; the dump; and a teardown that leaves
 * nothing hosting.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ForayPlaybackServiceTest {
    private ServiceController<ForayPlaybackService> controller;

    private ForayPlaybackService create() {
        controller = Robolectric.buildService(ForayPlaybackService.class).create();
        return controller.get();
    }

    @After
    public void tearDown() {
        if (controller != null) controller.destroy();
        controller = null;
    }

    @Test
    public void itHostsTheEngineBehindOneSessionWhosePlayerIsTheFacade() {
        ForayPlaybackService s = create();
        assertTrue("the service hosts the engine", ForayPlaybackService.isHosting());
        assertSame(s, ForayPlaybackService.current());
        MediaSession session = s.session();
        assertNotNull(session);
        assertTrue("the session's player is the SimpleBasePlayer facade", session.getPlayer() instanceof EnginePlayer);
        assertEquals("nothing loaded: the session is idle", Player.STATE_IDLE, session.getPlayer().getPlaybackState());
        assertNotNull(s.host());
        assertFalse(s.host().isTornDown());
    }

    @Test
    public void theDecksPlayerIsSpeechWithFocusAndBecomingNoisyHandled() {
        ForayPlaybackService s = create();
        assertNotNull(s.exoPlayer());
        assertEquals(C.AUDIO_CONTENT_TYPE_SPEECH, s.exoPlayer().getAudioAttributes().contentType);
        assertEquals(C.USAGE_MEDIA, s.exoPlayer().getAudioAttributes().usage);
    }

    /**
     * A-66 (mirrors NE-47): the voice preview plays on a player of its own, never one of the pair's,
     * configured as the deck's (speech, focus handled), and every row its deck writes says
     * {@code lane=preview}. TO SEE IT FAIL: build the preview over the pair's player, skip
     * EngineAudio.configure on it, or drop the lane.
     */
    @Test
    public void theVoicePreviewHasAPlayerOfItsOwnConfiguredAsTheDecks() {
        ForayPlaybackService s = create();
        assertNotNull(s.previewPlayer());
        assertFalse("not the deck's player", s.previewPlayer() == s.exoPlayer());
        assertEquals(C.AUDIO_CONTENT_TYPE_SPEECH, s.previewPlayer().getAudioAttributes().contentType);
        assertEquals(C.USAGE_MEDIA, s.previewPlayer().getAudioAttributes().usage);
        assertEquals(6.0, ForayPlaybackService.PREVIEW_LOAD_DEADLINE_SEC, 0);
        ai.jwlabs.foura.engine.EngineCommand.DiagEntry laned = ForayPlaybackService.previewLane(new ai.jwlabs.foura.engine.EngineCommand.DiagEntry(
                "deck", List.of(ai.jwlabs.foura.engine.JsonNode.member("kind", ai.jwlabs.foura.engine.JsonNode.str("ready")))));
        assertEquals("ready", laned.field("kind").stringValue());
        assertEquals("preview", laned.field("lane").stringValue());
        controller.destroy();
        controller = null;
        assertNull("released with the others", s.previewPlayer());
    }

    /**
     * A-66 review: Media3 keeps a paused deck's focus, so the preview's play takes it, and the deck
     * reports a permanent loss. While the preview wants to sound, that loss is ours and reaches no
     * core; with the preview silent the same report is another app's, an interruption as before. TO
     * SEE IT FAIL: feed every loss from the deck's focus listener.
     */
    @Test
    public void theDecksLossToOurOwnPreviewIsNoInterruption() {
        ForayPlaybackService s = create();
        Player.Listener focus = s.focusListener();
        assertNotNull(focus);
        androidx.media3.exoplayer.ExoPlayer preview = s.previewPlayer();
        assertNotNull(preview);
        // The process log is shared and bounded: read only the rows this test adds.
        List<String> before = s.rows();
        preview.setMediaItem(androidx.media3.common.MediaItem.fromUri("file:///nonexistent/preview.m4a"));
        preview.prepare();
        preview.play();
        assertTrue(s.previewWantsFocus());
        focus.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS);
        String added = String.join("\n", since(before, s.rows()));
        assertFalse("no interruption: " + added, added.contains("\"kind\":\"interruption\""));
        assertTrue(added, added.contains("\"kind\":\"lost-to-preview\""));

        preview.stop();
        preview.clearMediaItems();
        assertFalse(s.previewWantsFocus());
        before = s.rows();
        focus.onPlayWhenReadyChanged(false, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS);
        added = String.join("\n", since(before, s.rows()));
        assertTrue("another app's loss is still an interruption: " + added, added.contains("\"kind\":\"interruption\""));
    }

    /** The rows of {@code after} that follow the last row of {@code before} (the ring may have dropped its oldest). */
    private static List<String> since(List<String> before, List<String> after) {
        if (before.isEmpty()) return after;
        int at = after.lastIndexOf(before.get(before.size() - 1));
        return at < 0 ? after : after.subList(at + 1, after.size());
    }

    @Test
    public void theFifteenThirtyPairAreTheSessionsButtonsAndRemotePresses() {
        ForayPlaybackService s = create();
        List<CommandButton> buttons = s.seekButtons();
        assertEquals(2, buttons.size());
        assertEquals(ForayPlaybackService.CMD_SEEK_BACK, buttons.get(0).sessionCommand.customAction);
        assertEquals(ForayPlaybackService.CMD_SEEK_FORWARD, buttons.get(1).sessionCommand.customAction);
        SessionCommands granted = ForayPlaybackService.sessionCommands();
        assertTrue(granted.contains(new SessionCommand(ForayPlaybackService.CMD_SEEK_BACK, Bundle.EMPTY)));
        assertTrue(granted.contains(new SessionCommand(ForayPlaybackService.CMD_SEEK_FORWARD, Bundle.EMPTY)));
        assertEquals(MediaMapping.RemoteCommand.SKIP_BACKWARD, ForayPlaybackService.remoteFor(ForayPlaybackService.CMD_SEEK_BACK));
        assertEquals(MediaMapping.RemoteCommand.SKIP_FORWARD, ForayPlaybackService.remoteFor(ForayPlaybackService.CMD_SEEK_FORWARD));
        assertNull(ForayPlaybackService.remoteFor("close"));
    }

    @Test
    public void aQueueFromAClientIsParsedIntoItems() {
        List<EngineItem> items = ForayPlaybackService.items(
                "[{\"id\":\"a\",\"kind\":\"episode\",\"audio_url\":\"asset:///public/a04/click-cbr.mp3\",\"end_sec\":85},"
                        + "{\"title\":\"no id\"},{\"id\":\"b\",\"audio_url\":\"https://cdn.example/b.mp3\"}]");
        assertEquals("an item with no id is dropped", 2, items.size());
        assertEquals("a", items.get(0).id);
        assertEquals(85.0, items.get(0).endSec, 0);
    }

    @Test
    public void aRemotePressThroughTheServiceReachesTheCore() {
        ForayPlaybackService s = create();
        assertNotNull(s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(
                ForayPlaybackService.items("[{\"id\":\"a\",\"kind\":\"episode\",\"audio_url\":\"https://cdn.example/a.mp3\"}]")))));
        // Nothing current yet: the core refuses a remote play as not-loaded, and says so.
        assertEquals("noActionableNowPlayingItem", ai.jwlabs.foura.audio.engine.ForayEngineHost.statusToken(
                s.host().remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY))));
        assertTrue("the press is a row", String.join("\n", s.rows()).contains("\"status\":\"noActionableNowPlayingItem\""));
    }

    @Test
    public void theDumpIsOneJsonLineThenTheRows() {
        ForayPlaybackService s = create();
        StringWriter out = new StringWriter();
        s.dump(null, new PrintWriter(out), new String[0]);
        String text = out.toString();
        assertTrue(text, text.startsWith(ForayPlaybackService.DUMP_PREFIX + "{"));
        assertTrue(text, text.contains("\"engine\":\"android-native\""));
        assertTrue(text, text.contains("\"hosting\":true"));
        assertTrue(text, text.contains("\"state\":\"idle\""));
    }

    /**
     * A-61: the service's AudioDeviceCallback feeds route resume's watcher from the platform's
     * devices (ShadowAudioManager's), seeded with what was already there, and the core reads the
     * route on its next turn; the dump says the route's port and class, never an address. TO SEE IT
     * FAIL: skip registerDeviceCallback in attach, or register it without the seed.
     */
    @Test
    public void theServiceHearsOutputDevicesAddedAndRemoved() {
        ShadowAudioManager audio = Shadows.shadowOf((AudioManager) ApplicationProvider.getApplicationContext()
                .getSystemService(Context.AUDIO_SERVICE));
        AudioDeviceInfo speaker = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER).build();
        audio.setOutputDevices(Collections.singletonList(speaker));
        ForayPlaybackService s = create();
        RouteWatcher watcher = s.routeWatcher();
        assertNotNull(watcher);
        assertEquals("seeded with the speaker, and no event for it", "speaker", watcher.currentRoute().portType());

        AudioDeviceInfo car = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP).build();
        audio.addOutputDevice(car, true);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("a2dp", watcher.currentRoute().portType());
        StringWriter out = new StringWriter();
        s.dump(null, new PrintWriter(out), new String[0]);
        assertTrue(out.toString(), out.toString().contains("route=a2dp class=bluetooth"));
        assertTrue("the route change reached the core as a session row", String.join("\n", s.rows()).contains("\"port\":\"a2dp\""));

        audio.removeOutputDevice(car, true);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("speaker", watcher.currentRoute().portType());
    }

    /**
     * A-65: Media3's foreground decisions reach the watch through {@code onUpdateNotificationAsync}'s
     * flag; the step from foreground to not writes {@code fgs kind=left} (here with an idle engine:
     * no Foray, not running), and the dump says the last decision. Driven through the override
     * itself, the call Media3 makes, so dropping the service's call into the watch fails here (the
     * shell invariant A-65 pins that it runs before Media3 acts).
     */
    @Test
    public void leavingTheForegroundWritesTheFgsRow() {
        ForayPlaybackService s = create();
        assertNotNull(s.onUpdateNotificationAsync(s.session(), true));
        assertTrue(s.foregroundRequired());
        StringWriter out = new StringWriter();
        s.dump(null, new PrintWriter(out), new String[0]);
        assertTrue(out.toString(), out.toString().contains("\"foregroundRequired\":true"));
        assertNotNull(s.onUpdateNotificationAsync(s.session(), false));
        assertFalse(s.foregroundRequired());
        String rows = String.join("\n", s.rows());
        assertTrue(rows, rows.contains(" fgs {\"kind\":\"left\",\"foray\":\"n\",\"running\":\"n\",\"inSeam\":\"n\",\"spoken\":\"n\"}"));
    }

    /**
     * A-65 review: the late-timer check's P-13 deadlines are read off the deck config, not copied
     * from its defaults, so a config that sets its own seconds is what the check measures against.
     * TO SEE IT FAIL: return the ExoDeck DEFAULT_* constants again.
     */
    @Test
    public void theLateCheckReadsTheDeadlinesTheDeckRuns() {
        ExoDeck.Config config = new ExoDeck.Config();
        config.loadDeadlineSec = 12;
        config.lineLoadDeadlineSec = 3;
        Map<DeckDeadlineClass, Double> deadlines = ForayPlaybackService.loadDeadlinesMs(config);
        assertEquals(12_000.0, deadlines.get(DeckDeadlineClass.CLIP), 0);
        assertEquals(3_000.0, deadlines.get(DeckDeadlineClass.LINE), 0);
        assertEquals("every class has one", DeckDeadlineClass.values().length, deadlines.size());
        Map<DeckDeadlineClass, Double> defaults = ForayPlaybackService.loadDeadlinesMs(new ExoDeck.Config());
        assertEquals(ExoDeck.DEFAULT_LOAD_DEADLINE_SEC * 1000, defaults.get(DeckDeadlineClass.CLIP), 0);
        assertEquals(ExoDeck.DEFAULT_LINE_LOAD_DEADLINE_SEC * 1000, defaults.get(DeckDeadlineClass.LINE), 0);
    }

    /**
     * A-65: a swipe from Recents keeps the service while it is in the foreground and the facade
     * still says play-when-ready, READY or BUFFERING (a seam beat, a stall), where Media3's own rule
     * wants {@code isPlaying()}; out of the foreground, or paused, Media3's rule stands.
     */
    @Test
    public void aSwipeKeepsTheServiceWhileTheFacadeStillSaysPlay() {
        ForayPlaybackService s = create();
        assertFalse("idle", ForayPlaybackService.keepsRunningOnTaskRemoved(true, s.session().getPlayer()));
        MediaMapping.CommandSnapshot snap = new MediaMapping.CommandSnapshot(MediaMapping.CommandSnapshot.Mode.FORAY,
                false, true, true, false);
        MediaMapping.View v = new MediaMapping.View();
        v.item = new MediaMapping.Item("episode", "A clip", "A show");
        v.durationSec = 900.0;
        v.positionSec = 120.0;
        v.playing = true;
        v.buffering = true;
        v.foray = true;
        ForayEngineHost.Surface stalled = new ForayEngineHost.Surface(
                MediaMapping.commandAvailability(snap, MediaMapping.SeekSteps.DEFAULT), MediaMapping.sessionView(v), true, 1, 1.0, true);
        EnginePlayer facade = new EnginePlayer(Looper.getMainLooper(), new EnginePlayer.Engine() {
            @Override
            public ForayEngineHost.Surface surface() {
                return stalled;
            }

            @Override
            public ForayEngineHost.Verdict remote(EngineInput.RemotePress press) {
                return new ForayEngineHost.Verdict(Collections.<String>emptyList(), false);
            }
        });
        assertEquals(Player.STATE_BUFFERING, facade.getPlaybackState());
        assertFalse("Media3's own rule would stop it: not isPlaying()", facade.isPlaying());
        assertTrue(ForayPlaybackService.keepsRunningOnTaskRemoved(true, facade));
        assertFalse("not in the foreground: Media3's rule stands", ForayPlaybackService.keepsRunningOnTaskRemoved(false, facade));
        assertFalse(ForayPlaybackService.keepsRunningOnTaskRemoved(true, null));
        facade.release();
    }

    @Test
    public void destroyTearsTheEngineDownAndStopsHosting() {
        ForayPlaybackService s = create();
        controller.destroy();
        controller = null;
        assertFalse(ForayPlaybackService.isHosting());
        assertNull(ForayPlaybackService.current());
        assertNull(s.session());
        assertNull(s.host());
    }
}

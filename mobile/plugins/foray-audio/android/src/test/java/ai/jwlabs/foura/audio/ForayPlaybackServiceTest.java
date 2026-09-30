package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.EnginePlayer;
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

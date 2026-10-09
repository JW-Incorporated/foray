package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.EnginePlayer;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.Vocabulary;
import android.media.AudioManager;
import android.os.Bundle;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
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
        assertEquals("noActionableNowPlayingItem", ForayEngineHost.statusToken(
                s.host().remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY))));
        assertTrue("the press is a row", String.join("\n", s.rows()).contains("\"status\":\"noActionableNowPlayingItem\""));
    }

    private static final String QUEUE = "[{\"id\":\"a\",\"kind\":\"episode\",\"audio_url\":\"https://cdn.example/a.mp3\"}]";

    private static EngineInput tap(int index) {
        return new EngineInput.Queue(new EngineInput.QueueInput.PlayIndex(index, null, Vocabulary.Source.TAP));
    }

    private static void audioMode(int mode) {
        RuntimeEnvironment.getApplication().getSystemService(AudioManager.class).setMode(mode);
    }

    private static List<String> refusedRows(ForayPlaybackService s) {
        List<String> out = new ArrayList<>();
        for (String row : s.rows()) if (row.contains("\"kind\":\"activate-refused\"")) out.add(row);
        return out;
    }

    @Test
    public void aPlayDuringAPhoneCallIsARefusedActivationAsOnIos() {
        /* CH3-08 / R5-02: the driver is on a call and presses play. On iOS setActive(true) fails
           in the press's own turn and the press is commandFailed; on Android Media3 asks for
           focus a turn later (FocusIntegrationTest), so the session seam refuses up front on the
           call state AudioManager reports. Today (before the fix) the play is granted, the deck
           loads, and the refusal arrives later as a never-ending interruption.
           MUTATION: activate() answers granted without reading the call state -> this is red
           (the tap's verdict is ok and the deck holds the item). */
        ForayPlaybackService s = create();
        assertTrue(s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(ForayPlaybackService.items(QUEUE)))).ok());
        audioMode(AudioManager.MODE_IN_CALL);

        ForayEngineHost.Verdict v = s.handle(tap(0));
        assertFalse("a play during a call is refused: " + v.failures(), v.ok());
        assertEquals("the refusal iOS gives a call (insufficient-priority, admitted as other)",
                List.of("session-failed:other"), v.failures());
        assertEquals("and nothing reached the deck", 0, s.exoPlayer().getMediaItemCount());
        assertFalse(s.exoPlayer().getPlayWhenReady());
        List<String> refused = refusedRows(s);
        assertEquals("the refusal is one session row: " + refused, 1, refused.size());
        assertTrue(refused.get(0), refused.get(0).contains("\"token\":\"insufficient-priority\"")
                && refused.get(0).contains("\"call\":\"in-call\""));

        audioMode(AudioManager.MODE_NORMAL);
        ForayEngineHost.Verdict after = s.handle(tap(0));
        assertTrue("the call over, the same play is granted: " + after.failures(), after.ok());
        assertEquals("and the deck loads it", 1, s.exoPlayer().getMediaItemCount());
    }

    @Test
    public void aRemotePlayDuringACallThatInterruptedTheListenIsCommandFailed() {
        /* The other road in: listening, a call arrives (Media3 hears the focus loss, the mapping
           makes it an interruption), and the driver presses play on the wheel. The core
           re-activates for it, and the seam refuses: the wheel is told commandFailed, as on iOS,
           not success. MUTATION: activate() answers granted without reading the call state ->
           the status is success. */
        ForayPlaybackService s = create();
        s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(ForayPlaybackService.items(QUEUE))));
        audioMode(AudioManager.MODE_NORMAL);
        assertTrue(s.handle(tap(0)).ok());
        s.handle(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        audioMode(AudioManager.MODE_IN_CALL);

        ForayEngineHost.Verdict press = s.host().remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY));
        assertEquals("refused as iOS refuses it: " + press.failures(), List.of("session-failed:other"), press.failures());
        assertEquals("commandFailed", ForayEngineHost.statusToken(press));
        assertEquals("one refusal row", 1, refusedRows(s).size());
        assertTrue("the status row says so", String.join("\n", s.rows()).contains("\"status\":\"commandFailed\""));
    }

    @Test
    public void aVoipCallRefusesThePlayToo() {
        /* MODE_IN_COMMUNICATION is a VoIP call (Meet, WhatsApp): it holds focus as a phone call
           does. MUTATION: read MODE_IN_CALL only -> this is red. */
        ForayPlaybackService s = create();
        s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(ForayPlaybackService.items(QUEUE))));
        audioMode(AudioManager.MODE_IN_COMMUNICATION);
        ForayEngineHost.Verdict v = s.handle(tap(0));
        assertEquals(List.of("session-failed:other"), v.failures());
        List<String> refused = refusedRows(s);
        assertEquals("one refusal row: " + refused, 1, refused.size());
        assertTrue(refused.get(0), refused.get(0).contains("\"call\":\"in-communication\""));
    }

    @Test
    public void aPlayWithNoCallIsGrantedAndLoadsAsBefore() {
        ForayPlaybackService s = create();
        s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(ForayPlaybackService.items(QUEUE))));
        audioMode(AudioManager.MODE_NORMAL);
        ForayEngineHost.Verdict v = s.handle(tap(0));
        assertTrue("granted: " + v.failures(), v.ok());
        assertEquals(1, s.exoPlayer().getMediaItemCount());
        assertTrue("no refusal row", refusedRows(s).isEmpty());
    }

    @Test
    public void onlyACallIsARefusingAudioMode() {
        /* MUTATION: drop MODE_IN_COMMUNICATION from callInProgress -> red here and in
           aVoipCallRefusesThePlayToo. */
        assertEquals("in-call", ForayPlaybackService.callInProgress(AudioManager.MODE_IN_CALL));
        assertEquals("in-communication", ForayPlaybackService.callInProgress(AudioManager.MODE_IN_COMMUNICATION));
        assertNull(ForayPlaybackService.callInProgress(AudioManager.MODE_NORMAL));
        assertNull("a ringing phone is not yet a call: Media3's own focus request answers for it",
                ForayPlaybackService.callInProgress(AudioManager.MODE_RINGTONE));
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

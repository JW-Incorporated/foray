package ai.jwlabs.foura.audio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.EnginePlayer;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.PlayerQueueState;
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
import org.robolectric.Shadows;
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

    private static List<String> rowsOfKind(ForayPlaybackService s, String kind) {
        List<String> out = new ArrayList<>();
        for (String row : s.rows()) if (row.contains("\"kind\":\"" + kind + "\"")) out.add(row);
        return out;
    }

    /**
     * The core is resuming: it reloads the item in place to play it once the deck is ready (a
     * Robolectric deck never turns ready on a network URL, so the core's state is the read; a
     * refused resume leaves it interrupted, not playing).
     */
    private static void assertResuming(ForayPlaybackService s) {
        assertTrue("the core resumes the item: " + s.host().state().player,
                s.host().state().player instanceof PlayerQueueState.LoadingItem);
    }

    /** Listening, then a call: Media3's transient loss, as the focus mapping reports it. */
    private static void listeningThenACall(ForayPlaybackService s) {
        s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(ForayPlaybackService.items(QUEUE))));
        audioMode(AudioManager.MODE_NORMAL);
        assertTrue(s.handle(tap(0)).ok());
        s.handle(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        assertEquals("the call paused the deck", false, s.exoPlayer().getPlayWhenReady());
    }

    @Test
    public void theResumeAfterTheCallStillActivatesAndPlays() {
        /* The other caller of activate(): the core's own resume when the call ends
           (SessionPolicy INTERRUPTION_ENDED, shouldResume && wasPlaying -> ACTIVATE). It was
           granted unconditionally before CH3-08 and must stay granted, even after the seam has
           refused a press during that same call.
           MUTATION: activate() caches the call state (refuses whenever a call was seen earlier in
           the session) -> red: the resume is refused, a second activate-refused row is written
           and the core stays interrupted. */
        ForayPlaybackService s = create();
        listeningThenACall(s);
        audioMode(AudioManager.MODE_IN_CALL);
        assertEquals("a press during the call is refused", "commandFailed", ForayEngineHost.statusToken(
                s.host().remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY))));
        assertEquals(1, refusedRows(s).size());

        audioMode(AudioManager.MODE_NORMAL);
        ForayEngineHost.Verdict end = s.handle(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionEnded(true)));
        assertTrue("the resume is granted: " + end.failures(), end.ok());
        assertEquals("no refusal for the resume: " + refusedRows(s), 1, refusedRows(s).size());
        assertEquals("the item is kept", 1, s.exoPlayer().getMediaItemCount());
        assertResuming(s);
        List<String> activations = rowsOfKind(s, "activate");
        assertTrue("the resume's activation row says ok: " + activations,
                activations.get(activations.size() - 1).contains("\"ok\":true"));
    }

    @Test
    public void aResumeWhoseFocusReturnsBeforeTheModeSaysNormalIsStillGranted() {
        /* THE RACE (CH3-08 review): the end of a call reaches 4a as Media3's AUDIOFOCUS_GAIN, and
           Telecom resets the audio mode around the same moment (it abandons the call's focus,
           then sets MODE_NORMAL, and AudioService applies a mode change on its own thread). So
           the resume's activate() can read MODE_IN_CALL. The gain is the authoritative fact (the
           system returns focus only once the call has given it up), so the resume does not ask
           the audio mode: it activates and plays, with no refusal row. Without this the driver
           hears nothing after the call, which is R5-02's own failure.
           MUTATION: activate() reads the audio mode for an interruption's resume too (drop the
           resume check) -> red: session-failed:other, an activate-refused row, the core stays interrupted. */
        ForayPlaybackService s = create();
        listeningThenACall(s);
        audioMode(AudioManager.MODE_IN_CALL);

        ForayEngineHost.Verdict end = s.handle(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionEnded(true)));
        assertTrue("the resume is granted: " + end.failures(), end.ok());
        assertTrue("no refusal row: " + refusedRows(s), refusedRows(s).isEmpty());
        assertEquals("the item is kept", 1, s.exoPlayer().getMediaItemCount());
        assertResuming(s);
        /* The exemption is the resume's only: a press during the call (a Resume intent, not an
           interruption's) is still refused, which
           aRemotePlayDuringACallThatInterruptedTheListenIsCommandFailed pins. */
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
     * CH3-07 (R5-01, R5-05): a CORE relinquish (the page's {@code relinquish}, A-29) is the end of
     * this service's session, not just of its engine. Android has two media sessions where iOS has
     * one Now Playing centre, so "leave it for the legacy lane" means release ours: today the
     * engine tears down and the Media3 session stays published, frozen on its last surface, beside
     * the legacy one (two "4a" sessions in the car, the wheel bound to the dead one, every press
     * {@code relinquished}).
     * MUTATION: drop {@code release()} from the host's {@code onTornDown} callback in
     * {@code attach}: red here (the session is still held).
     */
    @Test
    public void aCoreRelinquishReleasesTheSessionAndStopsHosting() {
        ForayPlaybackService s = create();
        assertNotNull(s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(
                ForayPlaybackService.items("[{\"id\":\"a\",\"kind\":\"episode\",\"audio_url\":\"https://cdn.example/a.mp3\"}]")))));
        ai.jwlabs.foura.audio.engine.ForayEngineHost engine = s.host();
        assertNotNull(engine);
        ai.jwlabs.foura.audio.engine.ForayEngineHost.Verdict v = s.handle(new EngineInput.Command(
                new EngineContract.Command.Relinquish(EngineContract.RelinquishCap.ALL), Vocabulary.Source.TAP));
        assertNotNull(v);
        assertTrue("the relinquish is accepted: " + v.failures(), v.ok());
        assertTrue("the core relinquished and the host tore down", engine.isTornDown());
        assertFalse("nothing hosts: ForayAudioPlugin.start may start the legacy service", ForayPlaybackService.isHosting());
        assertNull("the Media3 session is released, not left frozen beside the legacy one", s.session());
        assertNull("the engine is let go", s.host());
        assertNull("and the deck's player with it", s.exoPlayer());
        assertNull("no live service: a later input finds none", ForayPlaybackService.current());
        assertTrue("the service stops itself", Shadows.shadowOf(s).isStoppedBySelf());
        assertNull("a later input finds no engine", s.handle(new EngineInput.Queue(new EngineInput.QueueInput.Load(
                ForayPlaybackService.items("[]")))));
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

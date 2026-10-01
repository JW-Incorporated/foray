package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeTiming;
import ai.jwlabs.foura.audio.engine.SpeechNarratorTest.FakeOutput;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckDeadlineClass;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineCore;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-66 (docs/plans/android-assessment.md §5.7, mirrors NE-47): the voice picker's audition by
 * URL through the Android host. The JVM core's rules are AuditionPreviewTest's and the parity
 * runner's; these hold what only the shell can show:
 * <ul>
 *   <li>an audition with a {@code url} plays on the PREVIEW deck, a real {@link ExoDeck} here
 *       configured as the service configures it ({@link EngineAudio}, so Media3 asks for focus as it
 *       plays), under the tap's one activation, with the main deck untouched;</li>
 *   <li>it is refused {@code engine-busy} while an episode runs, and touches neither deck;</li>
 *   <li>a preview that fails (a real ExoDeck over a source that answers 404), misses its deadline, or has no
 *       deck to play on is spoken by the engine's synthesiser ({@link SpeechNarrator}, Android
 *       {@code TextToSpeech} in the service) instead;</li>
 *   <li>the bridge decodes the url only on the narration host, and a teardown lets the preview deck go.</li>
 * </ul>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
@OptIn(markerClass = UnstableApi.class)
public class AuditionPreviewHostTest {
    static final String TEXT = "This is how I sound";
    static final String NARRATION_URL = "https://audio.jwlabs.ai/n/kokoro-fp32-aac64-v1/af_heart/preview.m4a";

    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final FakeTiming timing = new FakeTiming();
        final FakeOutput speech = new FakeOutput();
        final List<String> lines = new ArrayList<>();
        final EngineLog log = new EngineLog(timing::wallMs, timing::monoMs, lines::add);
        final SpeechNarrator narrator;
        final ForayEngineHost host;

        /** {@code preview} null: a host with no preview deck wired. */
        Rig(DeckDriving preview) {
            SpeechNarrator.Config sc = new SpeechNarrator.Config();
            sc.diag = log::diag;
            narrator = new SpeechNarrator(speech, sc);
            EngineSeams seams = new EngineSeams(deck, session, timing, log, narrator, null).withPreview(preview);
            host = new ForayEngineHost(seams, new EngineConfig("test"));
            host.start();
        }

        ForayEngineHost.Verdict audition(String url) {
            return host.handle(new EngineInput.Command(new EngineContract.Command.Audition(TEXT, "voice-a", url),
                    Vocabulary.Source.AUDITION));
        }

        String spoken() {
            return speech.line == null ? null : speech.line.text();
        }

        String rows() {
            return String.join("\n", lines);
        }
    }

    static ClickTracks.Fixture cbr() {
        for (ClickTracks.Fixture f : ClickTracks.fixtures()) if (f.file.equals("click-cbr.mp3")) return f;
        throw new AssertionError("no click-cbr.mp3");
    }

    /**
     * The preview plays on its own ExoPlayer (a real {@link ExoDeck}, configured as the service
     * configures every deck, {@link EngineAudio}: Media3 then asks for AUDIOFOCUS_GAIN as it plays,
     * which FocusIntegrationTest pins on a player configured the same way), under the tap's one
     * activation: nothing spoken, the main deck untouched. TO SEE IT FAIL: interpret the preview's
     * commands on the main deck, or play before the deck's ready.
     */
    @Test
    public void aUrlAuditionPlaysOnItsOwnDeckUnderTheTapsActivation() throws Exception {
        // The deadline far out: the FakeClock auto-advances while the loader thread reads the file in
        // real time, so a few virtual seconds can pass before it lands (DeckHarness, A-60).
        try (DeckHarness preview = new DeckHarness(config -> {
            config.reusesSameSource = false;
            config.loadDeadlineSec = 600;
            config.lineLoadDeadlineSec = 600;
        })) {
            EngineAudio.configure(preview.player);
            Rig rig = new Rig(preview.deck);
            // The host does not check the url (the contract does, at the bridge): a local file stands in for the CDN.
            ForayEngineHost.Verdict verdict = rig.audition(cbr().uri().toString());
            assertTrue(verdict.failures().toString(), verdict.ok());
            assertEquals("the tap's one activation", 1, rig.session.activations);
            preview.runUntil(() -> preview.player.isPlaying() || rig.spoken() != null);
            assertTrue("the preview plays (not a fallback): " + rig.rows(), preview.player.isPlaying());
            assertEquals("still one activation: the tap's covers the play", 1, rig.session.activations);
            assertTrue("the main deck is not the preview's: " + rig.deck.sent, rig.deck.sent.isEmpty());
            assertNull("a rendered preview is not spoken", rig.spoken());
            assertTrue(rig.host.state().preview.playing);
            assertEquals("a preview is not a play of the queue", "idle", rig.host.state().stateType());
            assertTrue(rig.rows(), rig.rows().contains("\"kind\":\"preview-play\""));
        }
    }

    /** Refused engine-busy while an episode runs, and neither deck nor the synthesiser hears of it. */
    @Test
    public void aUrlAuditionIsRefusedEngineBusyWhileAnEpisodePlays() {
        FakeDeck preview = new FakeDeck();
        Rig rig = new Rig(preview);
        assertTrue(rig.host.handle(ForayEngineHostTest.load("a")).ok());
        assertTrue(rig.host.handle(ForayEngineHostTest.playIndex(0)).ok());
        DeckCommand.Load load = null;
        for (DeckCommand c : rig.deck.sent) if (c instanceof DeckCommand.Load l) load = l;
        assertNotNull(load);
        rig.deck.emit(new DeckEvent.Ready(load.token(), 0, true, 5));
        assertTrue(rig.host.state().isRunning());
        int sent = rig.deck.sent.size();

        ForayEngineHost.Verdict verdict = rig.audition(NARRATION_URL);
        assertEquals(List.of(EngineContract.Refusal.ENGINE_BUSY.token), verdict.failures());
        assertTrue("the preview deck heard nothing: " + preview.sent, preview.sent.isEmpty());
        assertEquals("the main deck heard nothing", sent, rig.deck.sent.size());
        assertNull(rig.spoken());
        assertNull(rig.host.state().preview);
        assertEquals("playing", rig.host.state().stateType());
    }

    /**
     * A preview the narration host answers 404 for (a real ExoDeck over a source that says 404:
     * Media3's own failure) is read aloud by the synthesiser, in the voice the page resolved, with an
     * {@code audition kind=fallback reason=failed} row. TO SEE IT FAIL: drop the core's fallback
     * speak, or the host's hand-over of {@code speak} to the speaker.
     */
    @Test
    public void aPreviewThatAnswers404IsSpokenByTheSynthesiser() throws Exception {
        try (DeckHarness preview = new DeckHarness(() -> new ExoDeckFallbackCauseTest.AnsweringSource(404),
                config -> config.reusesSameSource = false)) {
            Rig rig = new Rig(preview.deck);
            assertTrue(rig.audition(NARRATION_URL).ok());
            preview.runUntil(() -> rig.spoken() != null);
            assertEquals(TEXT, rig.spoken());
            assertFalse(preview.player.isPlaying());
            assertNull(rig.host.state().preview);
            assertTrue(rig.rows(), rig.rows().contains("\"kind\":\"fallback\",\"reason\":\"failed\",\"spoken\":true"));
        }
    }

    /** A preview past its deadline (the deck's {@code deadlineExceeded}) is spoken too, with {@code reason=timeout}. */
    @Test
    public void aPreviewPastItsDeadlineIsSpoken() {
        FakeDeck preview = new FakeDeck();
        Rig rig = new Rig(preview);
        assertTrue(rig.audition(NARRATION_URL).ok());
        assertEquals(1, preview.sent.size());
        DeckCommand.Load load = (DeckCommand.Load) preview.sent.get(0);
        assertEquals(new DeckCommand.Load(load.token(), EngineCore.PREVIEW_ITEM_ID, NARRATION_URL, 0, false, DeckDeadlineClass.LINE), load);
        assertNull("nothing is spoken while the file may play", rig.spoken());
        preview.emit(new DeckEvent.DeadlineExceeded(load.token(), 6000));
        assertEquals(TEXT, rig.spoken());
        assertTrue(rig.rows(), rig.rows().contains("\"kind\":\"fallback\",\"reason\":\"timeout\",\"spoken\":true"));
        assertEquals("the preview deck was never told to play", 0, preview.count(DeckCommand.Play.class));
    }

    /**
     * A-66 review: a preview that ran out is unloaded by the host, because Media3 holds its
     * AUDIOFOCUS_GAIN through STATE_ENDED and lets it go only at IDLE; the core (NE-47's) sends
     * nothing at an end. Nothing is spoken and the main deck is untouched. TO SEE IT FAIL: drop the
     * host's unload after the preview's {@code ended}.
     */
    @Test
    public void aPreviewThatRanOutIsUnloadedSoItsFocusGoes() {
        FakeDeck preview = new FakeDeck();
        Rig rig = new Rig(preview);
        assertTrue(rig.audition(NARRATION_URL).ok());
        DeckCommand.Load load = (DeckCommand.Load) preview.sent.get(0);
        preview.emit(new DeckEvent.Ready(load.token(), 0, true, 2));
        assertEquals(1, preview.count(DeckCommand.Play.class));
        assertEquals("nothing after the play yet", 0, preview.count(DeckCommand.Unload.class));
        preview.emit(new DeckEvent.Ended(load.token()));
        assertNull(rig.host.state().preview);
        assertEquals("the ended preview is unloaded: " + preview.sent, 1, preview.count(DeckCommand.Unload.class));
        assertTrue(preview.sent.get(preview.sent.size() - 1) instanceof DeckCommand.Unload);
        assertNull(rig.spoken());
        assertTrue("the main deck is not the preview's: " + rig.deck.sent, rig.deck.sent.isEmpty());
    }

    /** With no preview deck wired, the load is answered failed behind the turn and the line is spoken: never silent. */
    @Test
    public void withNoPreviewDeckTheAuditionIsSpoken() {
        Rig rig = new Rig(null);
        assertTrue(rig.audition(NARRATION_URL).ok());
        assertEquals(TEXT, rig.spoken());
        assertTrue("the main deck is not the preview's: " + rig.deck.sent, rig.deck.sent.isEmpty());
        assertNull(rig.host.state().preview);
    }

    /** A teardown lets the preview deck go (no listener, invalidated), as it does the main one. */
    @Test
    public void aTeardownLetsThePreviewDeckGo() {
        FakeDeck preview = new FakeDeck();
        Rig rig = new Rig(preview);
        assertNotNull("the host listens to the preview deck", preview.listener);
        assertTrue(rig.audition(NARRATION_URL).ok());
        rig.host.teardown();
        assertTrue(preview.invalidated);
        assertNull(preview.listener);
    }

    /**
     * Through the bridge (A-28's decoding): an audition whose url is a file on the narration host is
     * accepted and loads on the preview deck; one off the host is refused as an invalid payload and
     * touches no seam. TO SEE IT FAIL: read {@code url} as any string in ContractDecoding.
     */
    @Test
    public void theBridgeDecodesTheUrlOnlyOnTheNarrationHost() {
        FakeDeck preview = new FakeDeck();
        Rig rig = new Rig(preview);
        EngineBridgeTest.FakeOwner owner = new EngineBridgeTest.FakeOwner();
        owner.host = rig.host;
        owner.decision = new EngineBridge.Decision(EngineContract.MODE_NATIVE, Vocabulary.ModeReason.OVERRIDE);
        EngineBridge bridge = new EngineBridge(owner, rig.log, rig.timing, EngineBridgeTest.ALL, event -> {});
        bridge.hello(EngineContract.helloRequest("test-build"));

        JsonNode offHost = bridge.send(send(1, "https://cdn.example.com/n/v1/af_heart/preview.m4a"));
        EngineBridgeTest.assertAccepted("sendResponse", offHost);
        assertEquals(JsonNode.FALSE, offHost.get("ok"));
        assertEquals("unknown-cmd", offHost.get("reason").stringValue());
        assertTrue("no seam was touched", preview.sent.isEmpty() && rig.deck.sent.isEmpty());
        assertEquals(0, rig.session.activations);

        JsonNode onHost = bridge.send(send(2, NARRATION_URL));
        EngineBridgeTest.assertAccepted("sendResponse", onHost);
        assertEquals(JsonNode.TRUE, onHost.get("ok"));
        assertEquals(1, preview.sent.size());
        assertEquals(NARRATION_URL, ((DeckCommand.Load) preview.sent.get(0)).url());
    }

    static JsonNode send(int cmdSeq, String url) {
        JsonNode args = EngineBridgeTest.obj("text", JsonNode.str(TEXT), "voiceId", JsonNode.NULL, "url", JsonNode.str(url));
        return EngineBridgeTest.obj("v", JsonNode.num(1), "cmdSeq", JsonNode.num(cmdSeq), "cmd", JsonNode.str("audition"),
                "args", args, "source", JsonNode.str("audition"));
    }
}

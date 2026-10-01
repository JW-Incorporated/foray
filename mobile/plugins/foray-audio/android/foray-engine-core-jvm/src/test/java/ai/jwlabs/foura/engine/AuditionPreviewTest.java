package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import ai.jwlabs.foura.engine.EngineCoreTest.Host;
import ai.jwlabs.foura.engine.Vocabulary.Source;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * Card A-66 (docs/plans/android-assessment.md §5.7; mirrors NE-47, Spark §3.3): the voice picker's
 * preview plays the voice's RENDERED {@code preview.m4a} on the engine. The JVM twin of the Swift
 * AuditionPreviewTests.
 * <ul>
 *   <li>An audition that carries a {@code url} loads it on the PREVIEW deck (never the main one) and
 *       plays it when the load lands, under the tap's own activation: one {@code sessionActivate},
 *       none for the play.</li>
 *   <li>It is refused {@code engine-busy} while running, as a spoken one is.</li>
 *   <li>A preview that will not load (a 404, a dead host, its deadline) is spoken instead, in the
 *       voice the page resolved.</li>
 *   <li>An audition with no {@code url} is spoken, exactly as before the card.</li>
 * </ul>
 * The fixtures ({@code manager-foray/audition-url-*}, {@code contract/send-request-*-audition-*})
 * hold the same rules against the JS reference on the JVM parity runner; these hold what no op log
 * shows: the tokens, the activation count, the session guard and the main deck left alone.
 */
public class AuditionPreviewTest {
    static final String URL = "https://audio.jwlabs.ai/n/kokoro-fp32-aac64-v1/af_heart/preview.m4a";

    /** An engineSend audition, decoded as the bridge decodes it. */
    static EngineInput audition(String text, String voiceId, String url) throws ContractDecoding.ContractError {
        List<JsonNode.Member> args = new ArrayList<>();
        args.add(JsonNode.member("text", JsonNode.str(text)));
        args.add(JsonNode.member("voiceId", voiceId == null ? JsonNode.NULL : JsonNode.str(voiceId)));
        if (url != null) args.add(JsonNode.member("url", JsonNode.str(url)));
        JsonNode request = EngineCoreTest.obj("v", JsonNode.num(1), "cmdSeq", JsonNode.num(1), "cmd", JsonNode.str("audition"),
                "args", new JsonNode.Obj(args), "source", JsonNode.str("audition"));
        ContractDecoding.SendRequest decoded = ContractDecoding.SendRequest.decode(request);
        return new EngineInput.Command(decoded.command(), decoded.source());
    }

    static EngineInput audition() throws ContractDecoding.ContractError {
        return audition("This is how I sound", null, URL);
    }

    static List<DeckCommand> previews(List<EngineCommand> out) {
        List<DeckCommand> found = new ArrayList<>();
        for (EngineCommand c : out) if (c instanceof EngineCommand.Preview p) found.add(p.command());
        return found;
    }

    static List<DeckCommand> deckCommands(List<EngineCommand> out) {
        List<DeckCommand> found = new ArrayList<>();
        for (EngineCommand c : out) if (c instanceof EngineCommand.Deck d) found.add(d.command());
        return found;
    }

    static List<EngineCommand.Speak> speaks(List<EngineCommand> out) {
        List<EngineCommand.Speak> found = new ArrayList<>();
        for (EngineCommand c : out) if (c instanceof EngineCommand.Speak s) found.add(s);
        return found;
    }

    static int activations(List<EngineCommand> out) {
        int n = 0;
        for (EngineCommand c : out) if (c instanceof EngineCommand.SessionActivate) n++;
        return n;
    }

    static EngineInput ready(int token) {
        return new EngineInput.Preview(new DeckEvent.Ready(token, 0, true, 40));
    }

    static int previewToken(Host host) {
        EngineState.AuditionPreview preview = host.core.state().preview;
        assertNotNull("a preview is in flight", preview);
        return preview.token;
    }

    /**
     * The contract decodes the url only on the narration host, character by character, as the page's
     * pattern reads it. TO SEE IT FAIL: read {@code url} with {@code string}, or drop it from the decode.
     */
    @Test
    public void theUrlIsDecodedOnlyOnTheNarrationHost() throws Exception {
        EngineInput.Command rendered = (EngineInput.Command) audition();
        assertEquals(new EngineContract.Command.Audition("This is how I sound", null, URL), rendered.command());
        assertEquals(Source.AUDITION, rendered.source());
        EngineInput.Command spoken = (EngineInput.Command) audition("This is how I sound", null, null);
        assertEquals(new EngineContract.Command.Audition("This is how I sound", null), spoken.command());
        for (String bad : Arrays.asList("http://audio.jwlabs.ai/preview.m4a", "https://cdn.example.com/preview.m4a",
                URL + "?token=abc", URL + "#t=1", "https://audio.jwlabs.ai.evil.example/p.m4a",
                "https://user:pw@audio.jwlabs.ai/p.m4a", "https://audio.jwlabs.ai:8443/p.m4a",
                "https://audio.jwlabs.ai/", "https://audio.jwlabs.ai/a b.m4a", "https://audio.jwlabs.ai/%2e.m4a",
                "https://audio.jwlabs.ai/café.m4a", "https://audio.jwlabs.ai/😀.m4a", "")) {
            try {
                audition("This is how I sound", null, bad);
                fail("accepted " + bad);
            } catch (ContractDecoding.ContractError expected) {
                assertTrue(expected.path, expected.path.endsWith("/url"));
            }
        }
    }

    /**
     * A url audition loads on the PREVIEW deck, activates once, and plays when the load is ready,
     * with nothing spoken and the main deck untouched. TO SEE IT FAIL: send the load as a
     * {@code Deck} command, play in the same turn as the load, or ask for a second activation.
     */
    @Test
    public void aUrlAuditionLoadsOnThePreviewDeckAndActivatesOnce() throws Exception {
        Host host = new Host();
        List<EngineCommand> out = host.send(audition());
        assertEquals(out.toString(), 1, activations(out));
        int token = previewToken(host);
        assertEquals(List.of(new DeckCommand.Load(token, EngineCore.PREVIEW_ITEM_ID, URL, 0, false, DeckDeadlineClass.LINE)),
                previews(out));
        assertEquals("the main deck is not the preview's", List.of(), deckCommands(out));
        assertEquals("a rendered preview is not spoken", List.of(), speaks(out));
        assertEquals(SessionPolicy.Phase.ACTIVE, host.core.state().session);
        int activate = EngineCoreTest.index(out, c -> c instanceof EngineCommand.SessionActivate);
        int load = EngineCoreTest.index(out, c -> c instanceof EngineCommand.Preview p && p.command() instanceof DeckCommand.Load);
        assertTrue("the activation comes first", activate >= 0 && activate < load);

        List<EngineCommand> played = host.send(ready(token));
        assertEquals(List.of(DeckCommand.PLAY), previews(played));
        assertEquals("the tap's own activation covers the play", 0, activations(played));
        assertTrue(host.core.state().preview.playing);
        assertEquals("a preview is not a play of the queue", "idle", host.core.state().stateType());

        // A second ready (a duplicate report) plays nothing twice; the end clears it.
        assertEquals(List.of(), previews(host.send(ready(token))));
        host.send(new EngineInput.Preview(new DeckEvent.Ended(token)));
        assertNull(host.core.state().preview);
    }

    /** Refused while running, exactly as a spoken audition is: nothing loads. TO SEE IT FAIL: check {@code isRunning} only for a spoken audition. */
    @Test
    public void aUrlAuditionIsRefusedEngineBusyWhileRunning() throws Exception {
        Host host = EngineCoreTest.playing();
        List<EngineCommand> out = host.send(audition());
        assertTrue(out.toString(), EngineCoreTest.failedWith(out, "engine-busy"));
        assertEquals(List.of(), previews(out));
        assertEquals(List.of(), speaks(out));
        assertNull(host.core.state().preview);
        assertEquals("the episode plays on", "playing", host.core.state().stateType());
    }

    /**
     * A 404 (the deck's {@code failed}) and a load past its deadline are both spoken instead, in the
     * voice the page resolved; a stale token's failure is nobody's. TO SEE IT FAIL: drop
     * {@code previewFailed}'s speak, or answer a failure for any token.
     */
    @Test
    public void aPreviewThatWillNotLoadIsSpoken() throws Exception {
        Host host = new Host();
        host.send(audition("This is how I sound", "en-us-x-sfg-local", URL));
        int first = previewToken(host);
        assertEquals("a stale failure is dropped", List.of(),
                speaks(host.send(new EngineInput.Preview(new DeckEvent.Failed(first + 99, "404")))));
        List<EngineCommand> failed = host.send(new EngineInput.Preview(new DeckEvent.Failed(first, "HTTP 404")));
        assertEquals(List.of(new EngineCommand.Speak("This is how I sound", "en-us-x-sfg-local")), speaks(failed));
        assertEquals(0, activations(failed));
        assertNull(host.core.state().preview);
        assertTrue(failed.toString(), failed.stream().anyMatch(c -> c instanceof EngineCommand.Diag d && d.entry().kind().equals("audition")
                && "fallback".equals(d.entry().field("kind").stringValue()) && "failed".equals(d.entry().field("reason").stringValue())));

        host.send(audition());
        int second = previewToken(host);
        assertNotEquals(first, second);
        List<EngineCommand> late = host.send(new EngineInput.Preview(new DeckEvent.DeadlineExceeded(second, 6000)));
        assertEquals(List.of(new EngineCommand.Speak("This is how I sound", null)), speaks(late));
        // The failed load's own late ready plays nothing.
        assertEquals(List.of(), previews(host.send(ready(second))));
    }

    /**
     * An audition with no url is the audition as it always was: one activation, then the line
     * spoken, and the preview deck never hears of it. TO SEE IT FAIL: load a preview for every
     * audition, or drop the speak.
     */
    @Test
    public void aNoUrlAuditionIsSpokenExactlyAsBefore() throws Exception {
        Host host = new Host();
        List<EngineCommand> out = host.send(audition("This is how I sound", "voice-a", null));
        assertEquals(List.of(), previews(out));
        assertEquals(List.of(new EngineCommand.Speak("This is how I sound", "voice-a")), speaks(out));
        assertEquals(1, activations(out));
        assertNull(host.core.state().preview);
        assertEquals(0, host.core.state().lastPreviewToken);
    }

    /**
     * A preview while PAUSED mid-episode leaves the main deck exactly as it was, and the play that
     * follows cuts the preview before the main deck moves. TO SEE IT FAIL: play the preview on the
     * main deck, or skip {@code stopPreview} in {@code begin}.
     */
    @Test
    public void aPreviewWhilePausedLeavesTheMainDeckAloneAndThePlayCutsIt() throws Exception {
        Host host = EngineCoreTest.playing();
        host.send(new EngineContract.Command.Pause());
        assertEquals("interrupted", host.core.state().stateType());
        List<EngineCommand> out = host.send(audition());
        assertEquals(out.toString(), List.of(), deckCommands(out));
        int token = previewToken(host);
        assertEquals(List.of(DeckCommand.PLAY), previews(host.send(ready(token))));

        List<EngineCommand> resumed = host.send(new EngineContract.Command.Play());
        int unload = EngineCoreTest.index(resumed, c -> c instanceof EngineCommand.Preview p && p.command() instanceof DeckCommand.Unload);
        assertTrue(resumed.toString(), unload >= 0);
        int deck = EngineCoreTest.index(resumed, c -> c instanceof EngineCommand.Deck);
        if (deck >= 0) assertTrue("the preview stops before the main deck moves", unload < deck);
        assertNull(host.core.state().preview);
        // Its late end is nobody's.
        assertEquals(List.of(), previews(host.send(new EngineInput.Preview(new DeckEvent.Ended(token)))));
    }

    /**
     * The session taken between the load and its ready (a call): the preview is dropped, never played
     * on a session nobody re-activated. TO SEE IT FAIL: drop the active-session guard in {@code onPreview}.
     */
    @Test
    public void aPreviewReadyAfterTheSessionWasTakenIsDropped() throws Exception {
        Host host = new Host();
        host.send(audition());
        int token = previewToken(host);
        host.send(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        assertNotEquals(SessionPolicy.Phase.ACTIVE, host.core.state().session);
        List<EngineCommand> out = host.send(ready(token));
        assertEquals(List.of(DeckCommand.UNLOAD), previews(out));
        assertEquals(List.of(), speaks(out));
        assertNull(host.core.state().preview);
    }

    /** A stop, a relinquish and the engine's teardown each cut a preview in flight; with none in flight they send the preview deck nothing. */
    @Test
    public void stopRelinquishAndTeardownCutThePreview() throws Exception {
        List<EngineInput> inputs = List.of(new EngineInput.Command(new EngineContract.Command.Stop(true), Source.TAP),
                new EngineInput.Command(new EngineContract.Command.Relinquish(EngineContract.RelinquishCap.ALL), Source.TAP),
                new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Teardown()));
        for (EngineInput input : inputs) {
            Host idle = new Host();
            assertEquals(input + " with no preview", List.of(), previews(idle.send(input)));

            Host host = new Host();
            host.send(audition());
            assertNotNull(host.core.state().preview);
            assertEquals(input.toString(), List.of(DeckCommand.UNLOAD), previews(host.send(input)));
            assertNull(host.core.state().preview);
        }
    }

    /** The invariant reads a preview's play as audible ({@code deckPlay}) and its load and unload as silent. */
    @Test
    public void thePreviewPlayIsAudibleToTheInvariant() {
        assertEquals("deckPlay", EngineCommand.turnName(new EngineCommand.Preview(DeckCommand.PLAY)));
        assertEquals("previewLoad", EngineCommand.turnName(new EngineCommand.Preview(
                new DeckCommand.Load(1, "x", URL, 0, false, DeckDeadlineClass.LINE))));
        assertEquals("previewUnload", EngineCommand.turnName(new EngineCommand.Preview(DeckCommand.UNLOAD)));
        assertEquals(1, SessionPolicy.audibleStartViolations(SessionPolicy.Phase.INACTIVE, List.of("deckPlay")).size());
        assertFalse(SessionPolicy.AUDIBLE_COMMANDS.contains("previewLoad"));
    }
}

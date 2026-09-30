package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineBridgeRules.SnapshotCoalescer;
import ai.jwlabs.foura.engine.EngineBridgeRules.SnapshotCoalescer.Step;
import ai.jwlabs.foura.engine.EngineBridgeRules.SnapshotStamper;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/**
 * Card A-28: every payload the Android bridge builds is one the page accepts (the JVM twin of the
 * Swift EngineBridgeRulesTests), {@code seq} is a content version, the coalescer's rules hold, and
 * the decoder refuses what the schema refuses in the places a Java port is likely to slip (a
 * boolean read as a number, a whole number beyond a long, args a command needs).
 */
public class EngineBridgeRulesTest {
    static void accepted(String kind, JsonNode payload) {
        ContractDecoding.ContractError why = ContractDecoding.refusal(kind, payload);
        assertNull(kind + ": " + (why == null ? "" : why.getMessage()) + " in " + JSWriter.stringify(payload), why);
    }

    static void refused(String kind, JsonNode payload) {
        assertNotNull(kind + " should be refused: " + JSWriter.stringify(payload), ContractDecoding.refusal(kind, payload));
    }

    static JsonNode snapshot() {
        return new SnapshotStamper().stamp(EngineBridgeRules.EngineSnapshot.body(new EngineCore(new EngineConfig()),
                DeckReading.idle(), null), 1_790_000_000_000.0, 5000).snapshot();
    }

    @Test
    public void everyHelloTheBridgeBuildsIsOneThePageAccepts() {
        JsonNode legacy = EngineBridgeRules.legacyHello(Vocabulary.ModeReason.BUILD_DEFAULT);
        accepted("helloResponse", legacy);
        assertEquals("engine-legacy", EngineContract.decidePageMode("android", true, legacy).reason());
        JsonNode nativeHello = EngineBridgeRules.nativeHello(Vocabulary.ModeReason.OVERRIDE,
                EngineBridgeRules.capabilities(EngineContract.CAPABILITIES), snapshot(),
                Collections.<EngineCommand.AdvanceEntry>emptyList(), Collections.<EngineCommand.PendingEvent>emptyList());
        accepted("helloResponse", nativeHello);
        for (String platform : new String[] {"ios", "android"}) {
            EngineContract.PageDecision d = EngineContract.decidePageMode(platform, true, nativeHello);
            assertEquals(platform, "native", d.mode());
            assertFalse(d.relinquish());
        }
        assertEquals("not-ios", EngineContract.decidePageMode("web", true, nativeHello).reason());
    }

    @Test
    public void theBinaryClaimsOnlyContractCapabilitiesAndTheIntersectionKeepsTheirOrder() {
        for (String cap : EngineBridgeRules.ADVERTISED_CAPABILITIES) assertTrue(cap, EngineContract.CAPABILITIES.contains(cap));
        assertEquals(Collections.emptyList(), EngineBridgeRules.capabilities(null));
        assertEquals(Collections.emptyList(), EngineBridgeRules.capabilities(Collections.<String>emptyList()));
        assertEquals(EngineBridgeRules.ADVERTISED_CAPABILITIES,
                EngineBridgeRules.capabilities(Arrays.asList("foray", "restore", "continuation", "episode")));
        assertEquals("episode", EngineBridgeRules.requiredCapability(new EngineContract.Command.PlayEpisode(
                JsonNode.NULL, null, null, JsonNode.NULL)));
        assertNull(EngineBridgeRules.requiredCapability(new EngineContract.Command.Play()));
    }

    @Test
    public void sendReplies() {
        accepted("sendResponse", EngineBridgeRules.sendResponse(null, snapshot()));
        accepted("sendResponse", EngineBridgeRules.sendResponse("capability-off", snapshot()));
        assertNull(EngineBridgeRules.refusal(Collections.<String>emptyList()));
        assertEquals("no-next", EngineBridgeRules.refusal(Arrays.asList("something-else", "no-next")));
        assertEquals("a failure that is no token is still a refusal", "unknown-cmd",
                EngineBridgeRules.refusal(Collections.singletonList("something-else")));
    }

    @Test
    public void readRepliesAndTheirOrder() {
        Map<String, String> rows = new LinkedHashMap<>();
        rows.put("cp_pos:b", "{\"seconds\":2}");
        rows.put("cp_last_episode", "{}");
        rows.put("cp_pos:a", "{\"seconds\":1}");
        JsonNode reply = EngineBridgeRules.rowsResponse(rows);
        accepted("rowsResponse", reply);
        assertEquals("keys sorted, so two reads are the same bytes",
                "{\"rows\":{\"cp_last_episode\":\"{}\",\"cp_pos:a\":\"{\\\"seconds\\\":1}\",\"cp_pos:b\":\"{\\\"seconds\\\":2}\"}}",
                JSWriter.stringify(reply));
        accepted("diagnosticsResponse", EngineBridgeRules.diagnosticsResponse(Collections.<JsonNode>emptyList()));
    }

    @Test
    public void everyEventIsOneThePageAccepts() {
        accepted("event", EngineBridgeRules.snapshotEvent(snapshot()));
        accepted("event", EngineBridgeRules.modeChangedEvent(Vocabulary.ModeReason.DOWNGRADE));
        accepted("event", EngineBridgeRules.event(new EngineCommand.EngineEvent.Error("chain-start", "x")));
        List<JsonNode.Member> hop = new ArrayList<>();
        hop.add(JsonNode.member("planSeq", JsonNode.num(1)));
        hop.add(JsonNode.member("hopSeq", JsonNode.num(0)));
        hop.add(JsonNode.member("nextId", JsonNode.str("b")));
        EngineContract.Hop h = new EngineContract.Hop(1, 0, "b", new JsonNode.Obj(hop));
        accepted("event", EngineBridgeRules.event(new EngineCommand.EngineEvent.Advanced(new EngineCommand.AdvanceEntry(1, h, 5))));
        List<JsonNode.Member> row = new ArrayList<>();
        row.add(JsonNode.member("seq", JsonNode.num(1)));
        row.add(JsonNode.member("kind", JsonNode.str("fault")));
        accepted("event", EngineBridgeRules.diagEvent(new JsonNode.Obj(row)));
    }

    @Test
    public void seqIsAContentVersionAndTheHeaderFollowsV() {
        SnapshotStamper stamper = new SnapshotStamper();
        List<JsonNode.Member> body = EngineBridgeRules.EngineSnapshot.body(new EngineCore(new EngineConfig()), DeckReading.idle(), null);
        SnapshotStamper.Stamped a = stamper.stamp(body, 1000, 10);
        SnapshotStamper.Stamped b = stamper.stamp(body, 2000, 20);
        assertTrue(a.changed());
        assertFalse("the same content again is not a change", b.changed());
        assertEquals(a.snapshot().get("seq"), b.snapshot().get("seq"));
        List<JsonNode.Member> members = b.snapshot().members();
        assertEquals(Arrays.asList("v", "seq", "capturedAtWallMs", "capturedAtMonotonicMs", "mode"),
                Arrays.asList(members.get(0).key(), members.get(1).key(), members.get(2).key(), members.get(3).key(), members.get(4).key()));
        SnapshotStamper.Stamped c = stamper.stamp(EngineBridgeRules.EngineSnapshot.body(new EngineCore(new EngineConfig()),
                DeckReading.idle(), "load"), 3000, 30);
        assertTrue(c.changed());
        assertEquals(2.0, c.snapshot().get("seq").numberValue(), 0);
        accepted("snapshot", c.snapshot());
        // A clock that is not a number is stamped 0, never NaN on the wire.
        accepted("snapshot", stamper.stamp(body, Double.NaN, -5).snapshot());
    }

    @Test
    public void theCoalescerSendsNothingHiddenOneOnVisibleAndOneAWindow() {
        SnapshotCoalescer c = new SnapshotCoalescer(true);
        assertEquals(Arrays.asList(Step.EMIT, Step.OPEN_WINDOW), c.changed());
        assertEquals("inside the window", Collections.emptyList(), c.changed());
        assertEquals(Arrays.asList(Step.EMIT, Step.OPEN_WINDOW), c.windowClosed());
        assertEquals(Collections.emptyList(), c.windowClosed());
        assertEquals("hidden", Collections.emptyList(), c.setVisible(false));
        for (int i = 0; i < 1000; i++) assertEquals(Collections.emptyList(), c.changed());
        assertEquals("a window left from before the page hid does not hold back the one on visible",
                Arrays.asList(Step.EMIT, Step.OPEN_WINDOW), c.setVisible(true));
        assertEquals("visible to visible is just a change, inside the window", Collections.emptyList(), c.setVisible(true));
    }

    static JsonNode send(String cmd, JsonNode args, JsonNode cmdSeq) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("v", JsonNode.num(1)));
        m.add(JsonNode.member("cmdSeq", cmdSeq));
        m.add(JsonNode.member("cmd", JsonNode.str(cmd)));
        if (args != null) m.add(JsonNode.member("args", args));
        m.add(JsonNode.member("source", JsonNode.str("tap")));
        return new JsonNode.Obj(m);
    }

    static JsonNode args(String key, JsonNode value) {
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member(key, value));
        return new JsonNode.Obj(m);
    }

    @Test
    public void theDecoderRefusesWhereAJavaPortIsLikelyToSlip() throws Exception {
        accepted("sendRequest", send("play", null, JsonNode.num(0)));
        accepted("sendRequest", send("play", args("unknown", JsonNode.TRUE), JsonNode.num(1)));
        refused("sendRequest", send("seekTo", null, JsonNode.num(1)));
        refused("sendRequest", send("seekTo", args("sec", JsonNode.TRUE), JsonNode.num(1)));
        refused("sendRequest", send("stop", args("persist", JsonNode.num(1)), JsonNode.num(1)));
        accepted("sendRequest", send("seekTo", args("sec", JsonNode.num(-0.0)), JsonNode.num(1)));
        refused("sendRequest", send("seekTo", args("sec", JsonNode.num(-1)), JsonNode.num(1)));
        refused("sendRequest", send("setRate", args("rate", JsonNode.num(0)), JsonNode.num(1)));
        refused("sendRequest", send("play", null, JsonNode.num(1.5)));
        refused("sendRequest", send("play", null, JsonNode.num(1e19)));
        accepted("sendRequest", send("play", null, JsonNode.num(1e15)));
        refused("sendRequest", send("setHoldPolicy", args("policy", JsonNode.str("until:0")), JsonNode.num(1)));
        accepted("sendRequest", send("setHoldPolicy", args("policy", JsonNode.str("until:30")), JsonNode.num(1)));
        refused("sendRequest", send("setModeOverride", args("mode", JsonNode.str("fast")), JsonNode.num(1)));
        ContractDecoding.SendRequest r = ContractDecoding.SendRequest.decode(send("setModeOverride", args("mode", JsonNode.str("web")),
                JsonNode.num(7)));
        assertEquals(7, r.cmdSeq());
        assertEquals(Vocabulary.Source.TAP, r.source());
        assertEquals(new EngineContract.Command.SetModeOverride("web"), r.command());
        assertThrows(IllegalArgumentException.class, () -> ContractDecoding.accepts("nonsense", JsonNode.NULL));
        refused("readRequest", args("what", JsonNode.str("everything")));
    }

    @Test
    public void tokenAdmissionIsExactAndAnUnknownSetIsABug() {
        assertEquals("ready", TokenAdmission.admit("ready", "stage"));
        assertNull(TokenAdmission.admit("Ready", "stage"));
        assertNull(TokenAdmission.admit(null, "stage"));
        assertThrows(TokenAdmission.UnknownSet.class, () -> TokenAdmission.admit("x", "stages"));
        assertThrows(TokenAdmission.UnknownSet.class, () -> TokenAdmission.admit("x", null));
    }

    @Test
    public void theRefusalEnumIsTheGeneratedListInOrder() {
        List<String> tokens = new ArrayList<>();
        for (EngineContract.Refusal r : EngineContract.Refusal.values()) tokens.add(r.token);
        assertEquals(EngineConstants.EngineContract.REFUSALS, tokens);
        List<String> caps = new ArrayList<>();
        for (EngineContract.RelinquishCap c : EngineContract.RelinquishCap.values()) caps.add(c.token);
        assertEquals(EngineConstants.EngineContract.RELINQUISH_CAPS, caps);
    }
}

package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeTiming;
import ai.jwlabs.foura.engine.ContractDecoding;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineTimer;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * Card A-28: the Android bridge, on a plain JVM over the real host and core, with the host test's
 * recording seams. The JVM twin of the iOS EngineBridgeTests (NE-20): what each method answers
 * (every answer checked against the contract, and every hello against the page's own
 * {@code decideMode} for an Android shell), when an event may leave (nothing while hidden, one
 * snapshot on visible, then at most one a window), the capability gate, sequence gaps, the refusal
 * rows, the relinquish hand-back, the Developer override in every lane, and the page's visibility
 * as the engine's lifecycle.
 */
public class EngineBridgeTest {
    static final class FakeOwner implements EngineBridge.Owner {
        EngineBridge.Decision decision = new EngineBridge.Decision(EngineContract.MODE_LEGACY, Vocabulary.ModeReason.BUILD_DEFAULT);
        ForayEngineHost host;
        final List<String> overrides = new ArrayList<>();
        int hellos;
        int relinquishes;

        @Override
        public EngineBridge.Decision decideOnce() {
            return decision;
        }

        @Override
        public ForayEngineHost engine() {
            return host;
        }

        @Override
        public void helloReceived() {
            hellos++;
        }

        int turns;
        final List<String> faults = new ArrayList<>();

        @Override
        public void engineTurned() {
            turns++;
        }

        @Override
        public void engineFaulted(String at, RuntimeException error) {
            faults.add(at + ":" + error.getClass().getSimpleName());
            relinquish(EngineContract.RelinquishCap.ALL, Vocabulary.Source.RESTORE);
        }

        @Override
        public void setModeOverride(String mode) {
            overrides.add(mode);
        }

        @Override
        public ForayEngineHost.Verdict relinquish(EngineContract.RelinquishCap cap, Vocabulary.Source source) {
            relinquishes++;
            ForayEngineHost.Verdict v = host.handle(new EngineInput.Command(new EngineContract.Command.Relinquish(cap), source));
            if (!v.deferred()) host.teardown();
            return v;
        }
    }

    static final class Rig {
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final FakeTiming timing = new FakeTiming();
        final List<String> lines = new ArrayList<>();
        final EngineLog log = new EngineLog(timing::wallMs, timing::monoMs, lines::add);
        final ForayEngineHost host = new ForayEngineHost(new EngineSeams(deck, session, timing, log), new EngineConfig("test"));
        final FakeOwner owner = new FakeOwner();
        final List<JsonNode> events = new ArrayList<>();
        final EngineBridge bridge;
        int cmdSeq;

        Rig(boolean nativeLane, List<String> declared) {
            host.start();
            // The legacy lane has no engine: the service is never bound there.
            if (nativeLane) owner.host = host;
            if (nativeLane) owner.decision = new EngineBridge.Decision(EngineContract.MODE_NATIVE, Vocabulary.ModeReason.OVERRIDE);
            bridge = new EngineBridge(owner, log, timing, declared, events::add);
        }

        Rig(boolean nativeLane) {
            this(nativeLane, Collections.<String>emptyList());
        }

        JsonNode hello() {
            JsonNode answer = bridge.hello(EngineContract.helloRequest("test-build"));
            assertAccepted("helloResponse", answer);
            cmdSeq = 0;
            return answer;
        }

        JsonNode send(String cmd, JsonNode args) {
            List<JsonNode.Member> m = new ArrayList<>();
            m.add(JsonNode.member("v", JsonNode.num(1)));
            m.add(JsonNode.member("cmdSeq", JsonNode.num(++cmdSeq)));
            m.add(JsonNode.member("cmd", JsonNode.str(cmd)));
            if (args != null) m.add(JsonNode.member("args", args));
            m.add(JsonNode.member("source", JsonNode.str("tap")));
            JsonNode reply = bridge.send(new JsonNode.Obj(m));
            assertAccepted("sendResponse", reply);
            return reply;
        }

        List<String> rows(String kind) {
            List<String> out = new ArrayList<>();
            for (JsonNode row : log.diagnosticRows()) {
                if (kind.equals(row.get("kind").stringValue())) out.add(JSWriter.stringify(row));
            }
            return out;
        }

        List<JsonNode> events(String type) {
            List<JsonNode> out = new ArrayList<>();
            for (JsonNode e : events) if (type.equals(e.get("type").stringValue())) out.add(e);
            return out;
        }

        /**
         * A playing episode. Through the host, as a tap on the engine's own queue, so a test of
         * something else does not depend on what the build declares.
         */
        void playEpisode(String id) {
            assertTrue(host.handle(ForayEngineHostTest.load(id)).ok());
            assertTrue(host.handle(ForayEngineHostTest.playIndex(0)).ok());
            DeckCommand.Load load = null;
            for (DeckCommand c : deck.sent) if (c instanceof DeckCommand.Load l) load = l;
            assertNotNull("the deck loads the episode", load);
            deck.emit(new DeckEvent.Ready(load.token(), 0, true, 5));
        }
    }

    static void assertAccepted(String kind, JsonNode payload) {
        ContractDecoding.ContractError why = ContractDecoding.refusal(kind, payload);
        assertNull(kind + " the page would refuse: " + (why == null ? "" : why.getMessage()) + " in " + JSWriter.stringify(payload), why);
    }

    static JsonNode obj(Object... kv) {
        List<JsonNode.Member> m = new ArrayList<>();
        for (int i = 0; i < kv.length; i += 2) m.add(JsonNode.member((String) kv[i], (JsonNode) kv[i + 1]));
        return new JsonNode.Obj(m);
    }

    static JsonNode playEpisodeArgs(String id) {
        JsonNode item = obj("id", JsonNode.str(id), "kind", JsonNode.str("episode"), "title", JsonNode.str("Title " + id),
                "show", JsonNode.str("A show"), "audio_url", JsonNode.str("https://cdn.example/" + id + ".mp3"),
                "duration_sec", JsonNode.num(90));
        JsonNode row = obj("id", JsonNode.str(id), "title", JsonNode.str("Title " + id));
        return obj("item", item, "lastEpisodeRow", row);
    }

    static final List<String> ALL = Arrays.asList("episode", "continuation", "restore", "foray");

    /** A native lane whose build declares everything; the binary's claim decides what is advertised. */
    static Rig nativeRig() {
        return new Rig(true, ALL);
    }

    // ---- engineHello

    @Test
    public void theStockAndroidLaneAnswersLegacyAndThePageRunsItsOwnPlayer() {
        Rig r = new Rig(false);
        JsonNode hello = r.hello();
        assertEquals("{\"mode\":\"legacy\",\"reason\":\"build-default\",\"protocol\":1}", JSWriter.stringify(hello));
        EngineContract.PageDecision d = EngineContract.decidePageMode("android", true, hello);
        assertEquals("js", d.mode());
        assertEquals("engine-legacy", d.reason());
        assertFalse("a clear legacy answer relinquishes nothing", d.relinquish());
        assertEquals(1, r.owner.hellos);
        assertTrue("a legacy lane writes no rows", r.log.diagnosticRows().isEmpty());
    }

    @Test
    public void theNativeLaneAnswersEverythingThePageNeedsToAttach() {
        Rig r = nativeRig();
        JsonNode hello = r.hello();
        EngineContract.PageDecision d = EngineContract.decidePageMode("android", true, hello);
        assertEquals("the page would drive this engine", "native", d.mode());
        assertEquals("override", hello.get("reason").stringValue());
        assertEquals(EngineBridgeRulesJvm.ADVERTISED, JSWriter.stringify(hello.get("capabilities")));
        assertEquals("[\"cp_pos:\",\"cp_foray:\",\"cp_last_episode\"]", JSWriter.stringify(hello.get("ownedKeyPrefixes")));
        assertEquals("none", hello.get("snapshot").get("mode").stringValue());
    }

    @Test
    public void theBinaryAdvertisesOnlyWhatItsBooksAllow() {
        // Declared everything; since A-29 cleared engine-mode on the JVM the binary claims episode
        // and continuation, and never restore (A-27) or foray (A-40).
        Rig r = nativeRig();
        r.hello();
        assertEquals(Arrays.asList("episode", "continuation"), r.bridge.capabilities());
        JsonNode reply = r.send("playEpisode", playEpisodeArgs("a"));
        assertEquals("an advertised episode reaches the engine: " + JSWriter.stringify(reply), JsonNode.TRUE, reply.get("ok"));
        assertTrue("the deck loads it", r.deck.sent.stream().anyMatch(c -> c instanceof DeckCommand.Load));
    }

    @Test
    public void aCapabilityTheBuildDoesNotDeclareIsRefusedOnRecord() {
        // The stock build declares nothing (mobile/ENGINE_DEFAULT.json's android block), so a
        // playEpisode is refused capability-off and the page relinquishes to its own player.
        Rig r = new Rig(true, Collections.singletonList("continuation"));
        r.hello();
        assertEquals(Collections.singletonList("continuation"), r.bridge.capabilities());
        JsonNode reply = r.send("playEpisode", playEpisodeArgs("a"));
        assertEquals("capability-off", reply.get("reason").stringValue());
        assertTrue("nothing reached the deck", r.deck.sent.isEmpty());
        assertEquals("the refusal is on record after the command", 1,
                r.rows("cmd").stream().filter(s -> s.contains("\"result\":\"capability-off\"")).count());
    }

    @Test
    public void aNativeDecisionWithNoEngineSaysNotBuilt() {
        Rig r = new Rig(true);
        r.owner.host = null;
        JsonNode hello = r.bridge.hello(EngineContract.helloRequest(""));
        assertAccepted("helloResponse", hello);
        assertEquals("legacy", hello.get("mode").stringValue());
        assertEquals("not-built", hello.get("reason").stringValue());
    }

    // ---- engineSend

    @Test
    public void anInvalidPayloadIsUnknownCmdAndTouchesNoSeam() {
        Rig r = nativeRig();
        r.hello();
        for (JsonNode bad : Arrays.asList(JsonNode.NULL, obj("v", JsonNode.num(1)),
                obj("v", JsonNode.num(2), "cmdSeq", JsonNode.num(1), "cmd", JsonNode.str("play"), "source", JsonNode.str("tap")),
                obj("v", JsonNode.num(1), "cmdSeq", JsonNode.num(1), "cmd", JsonNode.str("dance"), "source", JsonNode.str("tap")),
                obj("v", JsonNode.num(1), "cmdSeq", JsonNode.num(1), "cmd", JsonNode.str("seekTo"), "source", JsonNode.str("tap")))) {
            JsonNode reply = r.bridge.send(bad);
            assertAccepted("sendResponse", reply);
            assertEquals(JsonNode.FALSE, reply.get("ok"));
            assertEquals("unknown-cmd", reply.get("reason").stringValue());
        }
        assertTrue("no seam was touched: " + r.deck.sent, r.deck.sent.isEmpty());
        assertEquals(0, r.session.activations);
        assertEquals(5, r.rows("cmd").stream().filter(s -> s.contains("\"invalid\":\"y\"")).count());
    }

    @Test
    public void aSkippedCmdSeqIsRecordedAndAHelloResetsTheCount() {
        Rig r = nativeRig();
        r.hello();
        r.send("pause", null);
        r.cmdSeq += 3;
        r.send("pause", null);
        assertEquals(1, r.rows("cmd").stream().filter(s -> s.contains("\"seqGap\":\"y\"")).count());
        r.hello();
        r.cmdSeq = 40;
        r.send("pause", null);
        assertEquals("a new page starts its own count", 1, r.rows("cmd").stream().filter(s -> s.contains("\"seqGap\":\"y\"")).count());
    }

    @Test
    public void anEpisodePlaysThroughTheBridgeAndTheReplyCarriesTheSnapshot() {
        Rig r = nativeRig();
        r.hello();
        r.playEpisode("a");
        JsonNode snap = r.bridge.snapshot();
        assertAccepted("snapshot", snap);
        assertEquals("episode", snap.get("mode").stringValue());
        assertEquals("a", snap.get("itemId").stringValue());
        assertEquals("playing", snap.get("state").stringValue());
        assertEquals(JsonNode.TRUE, snap.get("running"));
        assertEquals("Title a", snap.get("nowPlaying").get("title").stringValue());
        JsonNode reply = r.send("pause", null);
        assertEquals(JsonNode.TRUE, reply.get("ok"));
        assertEquals("interrupted", reply.get("snapshot").get("state").stringValue());
        assertEquals("the cmd row names its source", 1, r.rows("cmd").stream()
                .filter(s -> s.contains("\"cmd\":\"pause\"") && s.contains("\"source\":\"tap\"")).count());
    }

    @Test
    public void theDeveloperOverrideWorksInEveryLane() {
        Rig r = new Rig(false);
        r.hello();
        JsonNode reply = r.send("setModeOverride", obj("mode", JsonNode.str("native")));
        assertEquals(JsonNode.TRUE, reply.get("ok"));
        assertEquals(Collections.singletonList("native"), r.owner.overrides);
        JsonNode play = r.send("play", null);
        assertEquals("the legacy lane plays nothing natively", "capability-off", play.get("reason").stringValue());
        assertEquals("delete my data works in every lane", JsonNode.TRUE, r.send("purge", null).get("ok"));
    }

    @Test
    public void thePagesVisibilityIsTheEnginesLifecycle() {
        Rig r = nativeRig();
        r.hello();
        r.playEpisode("a");
        assertFalse(r.host.state().backgrounded);
        r.send("setPageVisible", obj("visible", JsonNode.FALSE));
        assertTrue("hidden is background", r.host.state().backgrounded);
        assertFalse(r.host.state().pageVisible);
        r.send("setPageVisible", obj("visible", JsonNode.TRUE));
        assertFalse("visible is foreground", r.host.state().backgrounded);
    }

    // ---- events

    @Test
    public void aThousandTransitionsWhileHiddenEmitNothingAndVisibleSendsExactlyOneTheLatest() {
        Rig r = nativeRig();
        r.hello();
        r.playEpisode("a");
        r.send("setPageVisible", obj("visible", JsonNode.FALSE));
        r.events.clear();
        for (int i = 1; i <= 1000; i++) {
            r.deck.reading.positionSec = (double) i / 20;
            r.host.handle(new EngineInput.Timer(EngineTimer.POSITION_TICK));
        }
        assertEquals("nothing leaves a hidden page", 0, r.events.size());
        r.send("setPageVisible", obj("visible", JsonNode.TRUE));
        List<JsonNode> snaps = r.events("snapshot");
        assertEquals("one snapshot on visible", 1, snaps.size());
        assertEquals(1, r.events.size());
        for (JsonNode e : r.events) assertAccepted("event", e);
        assertEquals("the latest", 50.0, snaps.get(0).get("snapshot").get("positionSec").numberValue(), 0);

        // Inside the window: nothing more, however many changes; the window closing sends one.
        r.events.clear();
        for (int i = 0; i < 10; i++) {
            r.deck.reading.positionSec = 60.0 + i;
            r.host.handle(new EngineInput.Timer(EngineTimer.POSITION_TICK));
        }
        assertEquals(0, r.events.size());
        FakeTiming.Scheduled window = null;
        for (FakeTiming.Scheduled s : r.timing.live()) if (s.afterMs == 1000 && !s.repeating) window = s;
        assertNotNull("the window is armed for a second", window);
        window.fire.run();
        assertEquals("the window closing sends one", 1, r.events("snapshot").size());
        assertEquals(69.0, r.events.get(0).get("snapshot").get("positionSec").numberValue(), 0);
    }

    @Test
    public void seqIsAContentVersion() {
        Rig r = nativeRig();
        r.hello();
        JsonNode a = r.bridge.snapshot();
        r.timing.mono += 500;
        JsonNode b = r.bridge.snapshot();
        assertEquals("the same content is the same seq", a.get("seq"), b.get("seq"));
        assertTrue("captured later", b.get("capturedAtMonotonicMs").numberValue() > a.get("capturedAtMonotonicMs").numberValue());
        r.playEpisode("a");
        JsonNode c = r.bridge.snapshot();
        assertTrue("new content, a new seq", c.get("seq").numberValue() > b.get("seq").numberValue());
    }

    @Test
    public void aRelinquishHandsTheProcessBackOnceAndEverySendAfterIsRefused() {
        Rig r = nativeRig();
        r.hello();
        r.playEpisode("a");
        r.events.clear();
        JsonNode reply = r.send("relinquish", obj("cap", JsonNode.str("all")));
        assertEquals(JsonNode.TRUE, reply.get("ok"));
        assertEquals(1, r.owner.relinquishes);
        assertTrue(r.host.isTornDown());
        assertEquals("the engine says so once", 1, r.events("modeChanged").size());
        for (JsonNode e : r.events) assertAccepted("event", e);
        assertEquals("relinquished", reply.get("snapshot").get("session").stringValue());
        assertEquals("relinquished", r.send("play", null).get("reason").stringValue());
        JsonNode hello = r.hello();
        assertEquals("legacy", hello.get("mode").stringValue());
        assertEquals("downgrade", hello.get("reason").stringValue());
        assertEquals("js", EngineContract.decidePageMode("android", true, hello).mode());
    }

    // ---- engineRead

    @Test
    public void readsAnswerTheSnapshotTheOwnedRowsAndTheRing() {
        Rig r = nativeRig();
        r.hello();
        r.playEpisode("a");
        r.deck.reading.positionSec = 30.0;
        r.send("pause", null);
        JsonNode rows = r.bridge.read(obj("what", JsonNode.str("rows")));
        assertAccepted("rowsResponse", rows);
        assertNotNull("the paused position is the engine's row", rows.get("rows").get("cp_pos:a"));
        JsonNode unowned = r.bridge.read(obj("what", JsonNode.str("rows"), "prefixes",
                new JsonNode.Arr(Collections.singletonList(JsonNode.str("cp_auth")))));
        assertEquals("an unowned prefix reads nothing", "{\"rows\":{}}", JSWriter.stringify(unowned));
        JsonNode ring = r.bridge.read(obj("what", JsonNode.str("diagnostics")));
        assertAccepted("diagnosticsResponse", ring);
        List<JsonNode> list = ring.get("rows").arrayValue();
        assertFalse(list.isEmpty());
        double last = -1;
        for (JsonNode row : list) {
            double seq = row.get("seq").numberValue();
            assertTrue("seq in order, no gaps", last < 0 || seq == last + 1);
            last = seq;
            assertNotNull(row.get("at"));
            assertNotNull(row.get("mono"));
        }
        assertAccepted("snapshot", r.bridge.read(obj("what", JsonNode.str("snapshot"))));
    }

    /** The binary's claim, spelled once for the hello test above. */
    static final class EngineBridgeRulesJvm {
        static final String ADVERTISED = "[\"episode\",\"continuation\"]";
    }
}

package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeDeck;
import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeSession;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineMode;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Test;

/**
 * Card A-29: ownership and fallback, on a plain JVM, over whole launches. The JVM twin of the iOS
 * EngineOwnershipTests (NE-17): decideOnce is once per process and writes before the boot; a
 * launch after an uncleared sentinel is a strike, and three clean launches leave none; three
 * strikes pin the build to the JS lane until the build number changes, and the Developer setting
 * clears them; the owner's stored state follows {@link EngineMode#trace} step for step; the hello
 * watchdog gives an idle engine back (and defers for a running one); an engine that throws at
 * hello falls back to the JS lane with a fault row; a relinquish is terminal.
 */
public class OwnershipCoreTest {
    static final String BUILD = "2026092901";

    /** The private keys, in memory, counting writes. */
    static final class MapKeys implements OwnershipCore.Keys {
        final Map<String, String> map = new LinkedHashMap<>();
        int writes;

        @Override
        public String get(String key) {
            return map.get(key);
        }

        @Override
        public void put(String key, String value) {
            writes++;
            if (value == null) map.remove(key);
            else map.put(key, value);
        }
    }

    /** A clock the test advances; a due timer fires in order. */
    static final class ManualTiming implements EngineSeams.Timing {
        double now = 0;
        final List<Timer> timers = new ArrayList<>();

        final class Timer implements EngineSeams.Cancellable {
            final double due;
            final Runnable fire;
            boolean done;

            Timer(double due, Runnable fire) {
                this.due = due;
                this.fire = fire;
            }

            @Override
            public void cancel() {
                done = true;
            }
        }

        @Override
        public double wallMs() {
            return 1_790_000_000_000.0 + now;
        }

        @Override
        public double monoMs() {
            return now;
        }

        @Override
        public EngineSeams.Cancellable schedule(double afterMs, boolean repeating, Runnable fire) {
            Timer t = new Timer(now + afterMs, fire);
            timers.add(t);
            return t;
        }

        void advance(double ms) {
            double end = now + ms;
            while (true) {
                Timer next = null;
                for (Timer t : new ArrayList<>(timers)) if (!t.done && t.due <= end && (next == null || t.due < next.due)) next = t;
                if (next == null) break;
                now = next.due;
                next.done = true;
                next.fire.run();
            }
            now = end;
        }

        int live() {
            int n = 0;
            for (Timer t : timers) if (!t.done) n++;
            return n;
        }
    }

    /** One process: its owner, its engine (bound on demand), its rows and its hand-overs. */
    static final class Process implements OwnershipCore.Platform {
        final ManualTiming timing = new ManualTiming();
        final FakeDeck deck = new FakeDeck();
        final FakeSession session = new FakeSession();
        final EngineLog log = new EngineLog(timing::wallMs, timing::monoMs, line -> { });
        final List<EngineCommand.DiagEntry> rows = new ArrayList<>();
        final OwnershipCore core;
        ForayEngineHost host;
        int handOvers;

        Process(MapKeys keys, EngineMode.BuildDefault buildDefault, String build, String launchId) {
            core = new OwnershipCore(keys, new OwnershipCore.Launch(buildDefault, build, launchId, true), timing, rows::add, this);
        }

        Process(MapKeys keys, String launchId) {
            this(keys, EngineMode.BuildDefault.JS, BUILD, launchId);
        }

        /** The service bound: the engine exists. */
        ForayEngineHost boot() {
            host = new ForayEngineHost(new EngineSeams(deck, session, timing, log), new EngineConfig("test"));
            host.start();
            core.engineBooted();
            return host;
        }

        @Override
        public ForayEngineHost engine() {
            return host;
        }

        @Override
        public void handOver() {
            handOvers++;
        }

        List<String> rows() {
            List<String> out = new ArrayList<>();
            for (EngineCommand.DiagEntry e : rows) out.add(e.kind() + " " + JSWriter.stringify(new JsonNode.Obj(e.fields())));
            return out;
        }
    }

    @After
    public void disarm() {
        EngineFaults.arm(null);
    }

    private static MapKeys nativeOverride() {
        MapKeys keys = new MapKeys();
        keys.map.put(OwnershipCore.KEY_OVERRIDE, "native");
        return keys;
    }

    // ---- decideOnce

    @Test
    public void decideOnceIsOncePerProcessAndWritesTheSentinelBeforeTheBoot() {
        MapKeys keys = nativeOverride();
        Process p = new Process(keys, "L1");
        EngineMode.Decision d = p.core.decideOnce();
        assertEquals(EngineMode.Mode.NATIVE, d.mode());
        assertEquals(Vocabulary.ModeReason.OVERRIDE, d.reason());
        assertEquals("the sentinel is written by the decision, before anything boots", "L1", keys.map.get(OwnershipCore.KEY_SENTINEL));
        int writes = keys.writes;
        // The other entry points (the plugin's load, a bridge call) read the same answer.
        assertSame(d, p.core.decideOnce());
        assertEquals("native", p.core.laneDecision().mode());
        assertEquals("a second call writes nothing", writes, keys.writes);
        assertEquals(Collections.singletonList(
                "mode {\"mode\":\"native\",\"reason\":\"override\",\"strikes\":0,\"sentinelWasSet\":\"n\",\"build\":\"" + BUILD + "\"}"),
                p.rows());
    }

    @Test
    public void theStockLaneWritesNoKeyAndNoRow() {
        MapKeys keys = new MapKeys();
        Process p = new Process(keys, "L1");
        EngineMode.Decision d = p.core.decideOnce();
        assertEquals(EngineMode.Mode.LEGACY, d.mode());
        assertEquals(Vocabulary.ModeReason.BUILD_DEFAULT, d.reason());
        p.core.pageLoaded(true);
        p.core.backgrounded();
        p.timing.advance(60_000);
        assertEquals("nothing stored", 0, keys.writes);
        assertTrue("a legacy launch writes no row", p.rows.isEmpty());
        assertEquals("and arms nothing", 0, p.timing.live());
    }

    @Test
    public void aLaunchAfterAnUnclearedSentinelIsAStrikeAndThreePinTheBuildUntilItChanges() {
        MapKeys keys = nativeOverride();
        // Three native boots that never reach a healthy marker (each dies at boot).
        for (int launch = 1; launch <= 3; launch++) {
            Process p = new Process(keys, "L" + launch);
            EngineMode.Decision d = p.core.decideOnce();
            assertEquals("launch " + launch + " is still native", EngineMode.Mode.NATIVE, d.mode());
            assertEquals(launch - 1, d.strikes());
        }
        Process fourth = new Process(keys, "L4");
        EngineMode.Decision d = fourth.core.decideOnce();
        assertEquals("the third strike is the crash loop, even over a native override", EngineMode.Mode.LEGACY, d.mode());
        assertEquals(Vocabulary.ModeReason.CRASH_LOOP, d.reason());
        assertEquals(3, d.strikes());
        assertEquals(BUILD, keys.map.get(OwnershipCore.KEY_STICKY));
        assertNull("a legacy process has nothing to guard", keys.map.get(OwnershipCore.KEY_SENTINEL));

        // Sticky: the next launch of the same build stays on the JS lane, with no sentinel to count.
        assertEquals(Vocabulary.ModeReason.CRASH_LOOP, new Process(keys, "L5").core.decideOnce().reason());
        // A new build is the fix a crash loop was waiting for.
        Process updated = new Process(keys, EngineMode.BuildDefault.JS, "2026093001", "L6");
        EngineMode.Decision fresh = updated.core.decideOnce();
        assertEquals(EngineMode.Mode.NATIVE, fresh.mode());
        assertEquals(0, fresh.strikes());
        assertNull(keys.map.get(OwnershipCore.KEY_STICKY));
    }

    @Test
    public void threeHealthyLaunchesLeaveNoStrikeWhicheverMarkerComesFirst() {
        MapKeys keys = nativeOverride();
        keys.map.put(OwnershipCore.KEY_STRIKES, "1");
        keys.map.put(OwnershipCore.KEY_SENTINEL, "earlier");
        List<String> markers = new ArrayList<>();
        for (int launch = 1; launch <= 3; launch++) {
            Process p = new Process(keys, "L" + launch);
            EngineMode.Decision d = p.core.decideOnce();
            assertEquals(EngineMode.Mode.NATIVE, d.mode());
            assertEquals("an uncleared sentinel is a strike; a healthy boot clears it", launch == 1 ? 2 : 0, d.strikes());
            p.boot();
            switch (launch) {
                case 1 -> p.timing.advance(OwnershipCore.HEALTHY_RUN_LOOP_MS); // 5 s of the looper
                case 2 -> p.core.backgrounded(); // the Activity paused
                default -> p.core.engineTurned(); // the first input handled
            }
            assertNull("the healthy marker clears the sentinel", keys.map.get(OwnershipCore.KEY_SENTINEL));
            assertEquals("and resets the strikes", "0", keys.map.get(OwnershipCore.KEY_STRIKES));
            for (String r : p.rows()) if (r.contains("\"healthy\"")) markers.add(r);
            assertEquals("the run-loop timer is gone once any marker fired", 0, p.timing.live());
        }
        assertEquals(3, markers.size());
        assertTrue(markers.get(0), markers.get(0).contains("\"marker\":\"run-loop\""));
        assertTrue(markers.get(1), markers.get(1).contains("\"marker\":\"resign-or-background\""));
        assertTrue(markers.get(2), markers.get(2).contains("\"marker\":\"first-input\""));
    }

    @Test
    public void theDeveloperSettingClearsStrikesAndTheStickyPin() {
        MapKeys keys = new MapKeys();
        keys.map.put(OwnershipCore.KEY_STRIKES, "3");
        keys.map.put(OwnershipCore.KEY_STICKY, BUILD);
        Process p = new Process(keys, "L1");
        assertEquals(Vocabulary.ModeReason.CRASH_LOOP, p.core.decideOnce().reason());
        p.core.setModeOverride("native");
        assertEquals("native", keys.map.get(OwnershipCore.KEY_OVERRIDE));
        assertEquals("0", keys.map.get(OwnershipCore.KEY_STRIKES));
        assertNull(keys.map.get(OwnershipCore.KEY_STICKY));
        assertEquals("the running process keeps its lane", EngineMode.Mode.LEGACY, p.core.decideOnce().mode());
        assertEquals(EngineMode.Mode.NATIVE, new Process(keys, "L2").core.decideOnce().mode());
        // Anything outside the closed set is stored as auto, as the JS reads it.
        p.core.setModeOverride("sometimes");
        assertEquals("auto", keys.map.get(OwnershipCore.KEY_OVERRIDE));
    }

    // ---- the owner follows engineModeTrace

    /** Drive the owner through {@code events} and require its stored state to be the trace's at every step. */
    private static void followsTheTrace(EngineMode.Stored initial, List<EngineMode.Event> events) {
        MapKeys keys = new MapKeys();
        keys.map.put(OwnershipCore.KEY_OVERRIDE, initial.modeOverride().token);
        keys.map.put(OwnershipCore.KEY_STRIKES, String.valueOf(initial.strikes()));
        if (initial.sentinel()) keys.map.put(OwnershipCore.KEY_SENTINEL, "earlier");
        if (initial.stickyLegacyBuild() != null) keys.map.put(OwnershipCore.KEY_STICKY, initial.stickyLegacyBuild());
        List<EngineMode.Step> trace = EngineMode.trace(initial, events);
        Process p = null;
        int launch = 0;
        for (int i = 0; i < events.size(); i++) {
            EngineMode.Event e = events.get(i);
            if (e instanceof EngineMode.Event.Launch l) {
                p = new Process(keys, l.buildDefault(), l.currentBuild(), "L" + (++launch));
                p.core.decideOnce();
            } else if (e instanceof EngineMode.Event.Healthy) {
                if (p != null) p.core.backgrounded();
            } else if (e instanceof EngineMode.Event.PageHealth) {
                // No hello within 10 s of a foreground page load.
                if (p != null) {
                    p.core.pageLoaded(true);
                    p.timing.advance(OwnershipCore.PAGE_HEALTH_MS);
                }
            } else if (e instanceof EngineMode.Event.SetOverride o) {
                Process q = p != null ? p : new Process(keys, "L0");
                q.core.setModeOverride(o.mode().token);
            }
            EngineMode.Stored expected = trace.get(i).stored();
            Process reader = new Process(keys, "reader");
            assertEquals("after event " + i + " (" + e.kind().token + ")", expected, reader.core.stored());
            if (p != null && trace.get(i).mode() != null) {
                assertEquals("the process's lane after event " + i, trace.get(i).mode(), p.core.decideOnce().mode());
                assertEquals(trace.get(i).reason(), p.core.decideOnce().reason());
            }
        }
    }

    private static EngineMode.Event launch() {
        return new EngineMode.Event.Launch(EngineMode.BuildDefault.NATIVE, BUILD, true);
    }

    @Test
    public void theOwnerStoresWhatEngineModeTraceSaysAtEveryStep() {
        EngineMode.Event healthy = new EngineMode.Event.Healthy();
        EngineMode.Event pageHealth = new EngineMode.Event.PageHealth();
        // Three clean background launches (R18).
        followsTheTrace(EngineMode.Stored.FRESH, Arrays.asList(launch(), healthy, launch(), healthy, launch(), healthy));
        // A crash loop, then a new build.
        followsTheTrace(EngineMode.Stored.FRESH, Arrays.asList(launch(), launch(), launch(), launch(),
                new EngineMode.Event.Launch(EngineMode.BuildDefault.NATIVE, "2026093001", true)));
        // Page-health strikes reach the crash loop although every boot was healthy.
        followsTheTrace(EngineMode.Stored.FRESH, Arrays.asList(launch(), healthy, pageHealth, launch(), healthy, pageHealth,
                launch(), healthy, pageHealth, launch()));
        // One page-health strike per process.
        followsTheTrace(EngineMode.Stored.FRESH, Arrays.asList(launch(), pageHealth, pageHealth, healthy, launch()));
        // A legacy process takes no strike.
        followsTheTrace(EngineMode.Stored.FRESH, Arrays.asList(
                new EngineMode.Event.Launch(EngineMode.BuildDefault.JS, BUILD, true), pageHealth, healthy));
        // The setting clears strikes and the pin.
        followsTheTrace(new EngineMode.Stored(EngineMode.ModeOverride.AUTO, 3, false, BUILD), Arrays.asList(launch(),
                new EngineMode.Event.SetOverride(EngineMode.ModeOverride.NATIVE), launch()));
    }

    // ---- the hello watchdog

    @Test
    public void aPageThatNeverSaysHelloGetsTheIdleEngineBackWithAPageHealthStrike() {
        MapKeys keys = nativeOverride();
        Process p = new Process(keys, "L1");
        p.core.decideOnce();
        p.core.pageLoaded(true);
        p.boot();
        p.timing.advance(OwnershipCore.HELLO_WATCHDOG_MS - 1);
        assertFalse(p.core.isRelinquished());
        assertEquals("the page-health strike came at 10 s", "1", keys.map.get(OwnershipCore.KEY_STRIKES));
        p.timing.advance(1);
        assertTrue("an idle engine is given back at 15 s", p.core.isRelinquished());
        assertTrue(p.host.isTornDown());
        assertEquals(1, p.handOvers);
        assertEquals("one strike per process, although the run-loop marker came between", "1",
                keys.map.get(OwnershipCore.KEY_STRIKES));
        List<String> rows = p.rows();
        assertTrue(rows.toString(), rows.contains("mode {\"reason\":\"page-health\",\"strikes\":1}"));
        assertTrue("the core's own downgrade row: " + p.log.diagnosticRows(), p.log.diagnosticRows().stream()
                .anyMatch(r -> "mode".equals(r.get("kind").stringValue()) && "downgrade".equals(stringOf(r, "reason"))));
        // A second relinquish is refused.
        assertEquals(Collections.singletonList("relinquished"),
                p.core.relinquish(EngineContract.RelinquishCap.ALL, Vocabulary.Source.TAP).failures());
        assertEquals(1, p.handOvers);
    }

    private static String stringOf(JsonNode row, String key) {
        JsonNode v = row.get(key);
        return v == null ? null : v.stringValue();
    }

    @Test
    public void aHelloStandsTheWatchdogDown() {
        MapKeys keys = nativeOverride();
        Process p = new Process(keys, "L1");
        p.core.decideOnce();
        p.core.pageLoaded(true);
        p.boot();
        p.timing.advance(4_000);
        p.core.helloReceived();
        p.timing.advance(60_000);
        assertFalse(p.core.isRelinquished());
        assertEquals("no page-health strike; the run-loop marker reset the count", "0", keys.map.get(OwnershipCore.KEY_STRIKES));
        assertNull(keys.map.get(OwnershipCore.KEY_SENTINEL));
        assertEquals(0, p.handOvers);
    }

    @Test
    public void aRunningEngineIsNeverStoppedForAPagesSakeTheWatchdogLooksAgain() {
        MapKeys keys = nativeOverride();
        Process p = new Process(keys, "L1");
        p.core.decideOnce();
        p.core.pageLoaded(false); // a background load: no page-health timer
        p.boot();
        assertTrue(p.host.handle(ForayEngineHostTest.load("a")).ok());
        assertTrue(p.host.handle(ForayEngineHostTest.playIndex(0)).ok());
        assertTrue("the engine is running", p.host.state().isRunning());
        p.timing.advance(OwnershipCore.HELLO_WATCHDOG_MS);
        assertFalse(p.core.isRelinquished());
        assertTrue(p.rows().toString(), p.rows().contains("mode {\"kind\":\"hello-watchdog\",\"outcome\":\"deferred\"}"));
        p.host.handle(new ai.jwlabs.foura.engine.EngineInput.Command(new EngineContract.Command.Pause(), Vocabulary.Source.TAP));
        p.host.handle(new ai.jwlabs.foura.engine.EngineInput.Command(new EngineContract.Command.Stop(true), Vocabulary.Source.TAP));
        p.timing.advance(OwnershipCore.HELLO_WATCHDOG_MS);
        assertTrue("idle now: given back", p.core.isRelinquished());
    }

    // ---- the fault at hello, through the bridge

    /** The bridge's owner as the Android one is: every rule the core's. */
    static final class CoreOwner implements EngineBridge.Owner {
        final Process p;

        CoreOwner(Process p) {
            this.p = p;
        }

        @Override
        public EngineBridge.Decision decideOnce() {
            return p.core.laneDecision();
        }

        @Override
        public ForayEngineHost engine() {
            return p.host;
        }

        @Override
        public void helloReceived() {
            p.core.helloReceived();
        }

        @Override
        public void engineTurned() {
            p.core.engineTurned();
        }

        @Override
        public void engineFaulted(String at, RuntimeException error) {
            p.core.engineFaulted(at, error);
        }

        @Override
        public void setModeOverride(String mode) {
            p.core.setModeOverride(mode);
        }

        @Override
        public ForayEngineHost.Verdict relinquish(EngineContract.RelinquishCap cap, Vocabulary.Source source) {
            return p.core.relinquish(cap, source);
        }
    }

    @Test
    public void anEngineThatThrowsAtHelloFallsBackToTheJsLaneWithAFaultRow() {
        MapKeys keys = nativeOverride();
        Process p = new Process(keys, "L1");
        p.core.decideOnce();
        p.core.pageLoaded(true);
        p.boot();
        List<JsonNode> events = new ArrayList<>();
        EngineBridge bridge = new EngineBridge(new CoreOwner(p), p.log, p.timing, EngineBridgeTest.ALL, events::add);

        EngineFaults.arm(EngineFaults.HELLO);
        JsonNode hello = bridge.hello(ai.jwlabs.foura.engine.EngineContract.helloRequest("test-build"));
        EngineBridgeTest.assertAccepted("helloResponse", hello);
        assertEquals("{\"mode\":\"legacy\",\"reason\":\"downgrade\",\"protocol\":1}", JSWriter.stringify(hello));
        EngineContract.PageDecision d = EngineContract.decidePageMode("android", true, hello);
        assertEquals("the page runs its own player", "js", d.mode());
        assertEquals("engine-legacy", d.reason());
        assertFalse("and has nothing left to relinquish", d.relinquish());

        assertTrue(p.core.isRelinquished());
        assertTrue("the engine is gone", p.host.isTornDown());
        assertEquals("the service is handed over, so the legacy one may start", 1, p.handOvers);
        assertEquals("a page-health strike: a build that throws on every launch reaches the JS lane in three", "1",
                keys.map.get(OwnershipCore.KEY_STRIKES));
        List<String> rows = p.rows();
        assertTrue(rows.toString(), rows.contains("mode {\"kind\":\"fault\",\"at\":\"hello\",\"error\":\"Injected\"}"));
        assertTrue(rows.toString(), rows.contains("mode {\"reason\":\"page-health\",\"strikes\":1}"));
        // Nothing is armed any more: no watchdog will fire into the JS lane.
        p.timing.advance(60_000);
        assertEquals(1, p.handOvers);

        // Disarmed, the bridge still answers from the owner's record: the engine gave the process back.
        EngineFaults.arm(null);
        JsonNode again = bridge.hello(EngineContract.helloRequest("test-build"));
        assertEquals("downgrade", again.get("reason").stringValue());
        assertEquals("relinquished", bridge.send(EngineBridgeTest.obj("v", JsonNode.num(1), "cmdSeq", JsonNode.num(1),
                "cmd", JsonNode.str("play"), "source", JsonNode.str("tap"))).get("reason").stringValue());
    }

    @Test
    public void theFirstTurnTheEngineCompletesIsTheHealthyMarker() {
        MapKeys keys = nativeOverride();
        keys.map.put(OwnershipCore.KEY_STRIKES, "1");
        Process p = new Process(keys, "L1");
        p.core.decideOnce();
        p.boot();
        EngineBridge bridge = new EngineBridge(new CoreOwner(p), p.log, p.timing, EngineBridgeTest.ALL, e -> { });
        JsonNode hello = bridge.hello(EngineContract.helloRequest("test-build"));
        assertEquals("native", hello.get("mode").stringValue());
        assertEquals("the hello is not an input", "L1", keys.map.get(OwnershipCore.KEY_SENTINEL));
        bridge.send(EngineBridgeTest.obj("v", JsonNode.num(1), "cmdSeq", JsonNode.num(1), "cmd", JsonNode.str("setPageVisible"),
                "args", EngineBridgeTest.obj("visible", JsonNode.FALSE), "source", JsonNode.str("tap")));
        assertNull("the engine's first turn cleared the sentinel", keys.map.get(OwnershipCore.KEY_SENTINEL));
        assertEquals("0", keys.map.get(OwnershipCore.KEY_STRIKES));
        assertTrue(p.rows().toString(), p.rows().stream().anyMatch(r -> r.contains("\"marker\":\"first-input\"")));
    }
}

package ai.jwlabs.foura.engine.parity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import ai.jwlabs.foura.engine.parity.ParitySuite.CaseResult;
import ai.jwlabs.foura.engine.parity.ParitySuite.Outcome;
import ai.jwlabs.foura.engine.parity.ParitySuite.SuiteReport;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/**
 * Card A-40's acceptance, on the JVM: the Foray families run whole and pass (0 owed), and THE
 * DRIVER'S CHECKS AND THE FIXTURES CAN GO RED. The Swift ForayTapeScenarioTests' and
 * NarrationOverlayScenarioTests' mutations (NE-30s, NE-31s) break the core's output, or what the
 * fakes report, on purpose, and the named case must fail. Plus what the fixtures cannot state:
 * A-4 across three handed-over seams with a standby deck, and the flags leaving every episode
 * scenario unchanged.
 */
public class ForayTapeScenarioTest {
    /** The Foray families A-40 ported whole. */
    static final List<String> A40_FAMILIES = Arrays.asList("seam-gap", "seek-policy", "interlude", "foray-clock", "foray-structure",
            "foray-progress", "media", "manager-foray", "prepare");

    private static ParityData fresh() {
        return ParityData.load(ParitySuiteTest.parityDir());
    }

    private static CaseResult outcome(String id, FamilyRunner mutant) {
        List<FamilyRunner> runners = new ArrayList<>();
        for (FamilyRunner r : JvmFamilies.ALL) runners.add(r.family().equals(mutant.family()) ? mutant : r);
        return new ParitySuite(fresh(), runners).run().result(id);
    }

    private static FixtureCase scenario(ParityData data, String family, String id) {
        for (FixtureFile file : data.fixtures.get(family)) {
            for (FixtureCase c : file.cases()) if (c.id().equals(id)) return c;
        }
        throw new AssertionError("no " + id + " in the " + family + " fixtures");
    }

    /** A clip of a built Foray ({@code f1#<index>}), as the Swift ForayTapeTests.clip. */
    static JsonNode clip(int index, String name, double start, double end) {
        return new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("f1#" + index)), JsonNode.member("kind", JsonNode.str("episode")),
                JsonNode.member("audio_url", JsonNode.str("https://cdn.test/" + name + ".mp3")),
                JsonNode.member("start_sec", JsonNode.num(start)), JsonNode.member("end_sec", JsonNode.num(end)),
                JsonNode.member("duration_sec", JsonNode.num(3600))));
    }

    /** A script-only narration line ({@code f1#<index>}), as the Swift NarrationOverlayTests.line. */
    static JsonNode line(int index, String script) {
        return new JsonNode.Obj(List.of(JsonNode.member("id", JsonNode.str("f1#" + index)), JsonNode.member("kind", JsonNode.str("tts")),
                JsonNode.member("type", JsonNode.str("narration")), JsonNode.member("script", JsonNode.str(script)),
                JsonNode.member("audio_url", JsonNode.NULL)));
    }

    private static FixtureCase inline(String id, String json) {
        return new FixtureCase(id, Json.parse(json));
    }

    @Test
    public void everyA40FamilyRunsWholeAndPasses() {
        ParityData data = fresh();
        SuiteReport report = new ParitySuite(data).run();
        for (String family : A40_FAMILIES) {
            ParitySuite.FamilySummary s = report.summary(family);
            assertTrue(family + " has a JVM runner", s.hasRunner());
            assertTrue(family + " has cases", s.cases() > 0);
            assertEquals(family + " runs every case", s.cases(), s.executed());
            /* A-61: the engine/m3 merge brought iOS M3 cases the JVM books to a Track A4 card
               (manager-foray's audition by URL was owed to A-66, which now runs it); every other
               case passes. */
            int owed = 0;
            for (String id : data.pendingCases.keySet()) {
                if (id.startsWith(family + "/")) {
                    assertTrue(id + " is owed to a Track A4 card", data.pendingCases.get(id).matches("A-6[0-8]"));
                    owed++;
                }
            }
            assertEquals(family + " passes every case not owed to Track A4", s.cases() - owed, s.passed());
        }
    }

    /** MUTATION (NE-30s's): the next load starts AFTER the beat instead of inside it, and a seam-timing case goes red. */
    @Test
    public void loadingAfterTheBeatTurnsASeamTimingCaseRed() {
        String id = "manager-foray/an-unbridged-seam-holds-the-full-beat";
        assertEquals(Outcome.PASSED, new ParitySuite(fresh()).run().result(id).outcome());
        CaseResult red = outcome(id, ForayTapeFamilies.managerForay(EngineScenarioDriver.Mutation.LOAD_AFTER_BEAT));
        assertEquals(red.detail(), Outcome.FAILED, red.outcome());
    }

    /** MUTATION (NE-31s's): cancel mapped to finished, and the line whose session was taken ADVANCES instead of pausing. */
    @Test
    public void mappingCancelToFinishedTurnsTheInterruptedLineRed() {
        String id = "manager-foray/an-interruption-during-a-spoken-line";
        assertEquals(Outcome.PASSED, new ParitySuite(fresh()).run().result(id).outcome());
        CaseResult red = outcome(id, ForayTapeFamilies.managerForay(EngineScenarioDriver.Mutation.CANCEL_AS_FINISHED));
        assertEquals(red.detail(), Outcome.FAILED, red.outcome());
    }

    /** MUTATION (NE-31s's): the silence node while not running breaks the session invariant. */
    @Test
    public void startingTheSilenceNodeWhileNotRunningBreaksTheSessionInvariant() {
        String id = "manager-foray/a-script-only-line-is-spoken-not-loaded";
        CaseResult red = outcome(id, ForayTapeFamilies.managerForay(EngineScenarioDriver.Mutation.SILENCE_WHILE_NOT_RUNNING));
        assertEquals(red.detail(), Outcome.FAILED, red.outcome());
        ParityData data = fresh();
        EngineScenarioDriver.Run run = new EngineScenarioDriver(EngineScenarioDriver.Mutation.SILENCE_WHILE_NOT_RUNNING, true)
                .run(scenario(data, "manager-foray", id), new Codec.Context(data.repoRoot));
        assertTrue(run.violations().toString(), run.violations().contains("audible-start:silenceStart@inactive"));
    }

    /**
     * MUTATION (NE-31s's): drop the seq check, and exactly-once goes red. A late duplicate
     * {@code didFinish} of the first line, arriving once the second line is speaking, must not
     * advance past the second.
     */
    @Test
    public void droppingTheSeqCheckTurnsExactlyOnceRed() {
        ParityData data = fresh();
        Map<Integer, List<JsonNode>> builds = Map.of(0, List.of(line(0, "first line"), line(1, "second line"), clip(2, "a", 100, 200)));
        FixtureCase testCase = inline("narration/late-duplicate-finish",
                "{\"id\":\"narration/late-duplicate-finish\",\"setup\":{\"target\":\"manager\",\"tts\":true},\"steps\":["
                        + "{\"call\":\"playForay\",\"args\":[{}]},{\"tts\":\"finish\"},{\"settle\":1},{\"checkpoint\":\"second\"},"
                        + "{\"tts\":\"finishPrevious\"},{\"settle\":1},{\"checkpoint\":\"late-duplicate\"}]}");
        Codec.Context context = new Codec.Context(data.repoRoot);
        EngineScenarioDriver.Run clean = new EngineScenarioDriver(null, true, builds).run(testCase, context);
        assertEquals(List.of(), clean.violations());
        assertEquals(1, clean.finalState().currentIndex);
        assertEquals("transitioning", clean.finalState().stateType());
        assertEquals("f1#1", clean.finalState().narration.itemId);
        EngineScenarioDriver.Run broken = new EngineScenarioDriver(EngineScenarioDriver.Mutation.FINISHED_CLAIMS_CURRENT_LINE, true, builds)
                .run(testCase, context);
        assertEquals("without the seq check the late finish skipped the second line", 2, broken.finalState().currentIndex);
    }

    /**
     * A-4 with two fake decks (the player and the standby) across 3 seams: one engine, every seam
     * prepared inside its window and handed over at its boundary, never more than one source
     * audible, each clip started once, in order, and nothing the driver checks broken.
     */
    @Test
    public void a4HoldsAcrossThreeHandedOverSeams() {
        ParityData data = fresh();
        Map<Integer, List<JsonNode>> builds = Map.of(0, List.of(clip(0, "a", 100, 200), clip(1, "b", 300, 400),
                clip(2, "c", 500, 600), clip(3, "d", 700, 800)));
        StringBuilder steps = new StringBuilder("{\"call\":\"playForay\",\"args\":{\"forayId\":\"f1\",\"title\":\"Four\",\"items\":[],"
                + "\"buildReport\":{},\"isLocalFile\":false,\"allowAdPad\":false,\"voiceId\":null}}");
        for (int end : new int[] {200, 400, 600}) {
            steps.append(",{\"deck\":\"time\",\"sec\":").append(end - 10).append("},{\"deck\":\"window\"},{\"deck\":\"time\",\"sec\":")
                    .append(end).append("},{\"deck\":\"ended\",\"reason\":\"outPoint\"},{\"clock\":500}");
        }
        steps.append(",{\"checkpoint\":\"last\"}");
        FixtureCase testCase = inline("a4/three-seams", "{\"id\":\"a4/three-seams\",\"setup\":{\"target\":\"engine\"},\"steps\":[" + steps + "]}");
        EngineScenarioDriver.Run run = new EngineScenarioDriver(null, true, builds).run(testCase, new Codec.Context(data.repoRoot));
        assertEquals(List.of(), run.violations());
        assertEquals(1, run.maxAudibleSources());
        assertEquals(Arrays.asList("f1#0", "f1#1", "f1#2", "f1#3"), run.plays());
        List<String> ops = new ArrayList<>();
        for (Json op : run.encoded().get("ops").asList()) ops.add(op.asString());
        List<String> prepares = new ArrayList<>();
        List<String> handovers = new ArrayList<>();
        for (int i = 0; i < ops.size(); i++) {
            if (ops.get(i).startsWith("n.prepare:")) prepares.add(ops.get(i));
            if (ops.get(i).startsWith("n.handover:")) {
                handovers.add(ops.get(i));
                assertTrue("the handover is said before its load", ops.get(i + 1).startsWith("load:"));
            }
        }
        assertEquals(Arrays.asList("n.prepare:f1#1@300", "n.prepare:f1#2@500", "n.prepare:f1#3@700"), prepares);
        assertEquals(Arrays.asList("n.handover:f1#1@300", "n.handover:f1#2@500", "n.handover:f1#3@700"), handovers);
        assertEquals("playing", run.finalState().stateType());
        assertEquals(3, run.finalState().currentIndex);
    }

    /**
     * With the tape off (the default) the manager-episode family is unchanged, and turning the
     * Foray tape on changes no episode's op log either.
     */
    @Test
    public void theTapeLeavesTheManagerEpisodeFamilyUnchanged() {
        ParityData data = fresh();
        Codec.Context context = new Codec.Context(data.repoRoot);
        int ran = 0;
        for (FixtureFile file : data.fixtures.get("manager-episode")) {
            for (FixtureCase c : file.cases()) {
                if (!"scenario".equals(c.kind())) continue;
                EngineScenarioDriver.Run off = new EngineScenarioDriver().run(c, context);
                EngineScenarioDriver.Run on = new EngineScenarioDriver(null, true).run(c, context);
                assertEquals(c.id() + ": the Foray tape changed an episode path", Json.show(off.encoded()), Json.show(on.encoded()));
                ran += 1;
            }
        }
        assertTrue("ran " + ran, ran > 30);
    }

    /**
     * Every manager-foray and prepare scenario keeps what no op log can show: the audible-start
     * invariant on every turn (a spoken line, a jingle and the silence node included), plays only
     * on a ready deck, never two audible sources, and every grace span begun is ended.
     */
    @Test
    public void everyForayScenarioKeepsTheInvariants() {
        ParityData data = fresh();
        Codec.Context context = new Codec.Context(data.repoRoot);
        int ran = 0;
        for (String family : Arrays.asList("manager-foray", "prepare")) {
            for (FixtureFile file : data.fixtures.get(family)) {
                for (FixtureCase c : file.cases()) {
                    if (!"scenario".equals(c.kind())) continue;
                    // A-61: a case the books owe to a Track A4 card is its card's to run (A-66 ran the audition by URL).
                    if (data.pendingCases.containsKey(c.id())) continue;
                    EngineScenarioDriver.Run run = new EngineScenarioDriver(null, true).run(c, context);
                    assertEquals(c.id(), List.of(), run.violations());
                    assertTrue(c.id() + " one audible source", run.maxAudibleSources() <= 1);
                    int begins = 0;
                    int ends = 0;
                    for (EngineCommand command : run.commands()) {
                        if (command instanceof EngineCommand.GraceBegin) begins++;
                        if (command instanceof EngineCommand.GraceEnd) ends++;
                    }
                    assertEquals(c.id() + ": every grace begin has an end", begins, ends);
                    ran += 1;
                }
            }
        }
        assertTrue("ran " + ran, ran > 100);
    }
}

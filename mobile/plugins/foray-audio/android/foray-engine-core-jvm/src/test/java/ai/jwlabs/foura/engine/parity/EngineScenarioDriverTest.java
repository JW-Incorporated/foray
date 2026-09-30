package ai.jwlabs.foura.engine.parity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import ai.jwlabs.foura.engine.parity.ParitySuite.CaseResult;
import ai.jwlabs.foura.engine.parity.ParitySuite.Outcome;
import ai.jwlabs.foura.engine.parity.ParitySuite.SuiteReport;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.Test;

/**
 * Card A-24's acceptance, on the JVM: the {@code manager-episode} and {@code deck-episode}
 * families run whole and pass, and THE DRIVER'S CHECKS CAN GO RED. The Swift
 * EngineScenarioDriverTests' mutations (NE-14s) break the core's OUTPUT on purpose, through
 * the runner's seam, and the named cases of that family (and only that family) must fail
 * with the driver's evidence in their diff. Plus the properties the fixtures cannot state:
 * one audible source, every grace span closed.
 */
public class EngineScenarioDriverTest {
    private static ParityData fresh() {
        return ParityData.load(ParitySuiteTest.parityDir());
    }

    private static SuiteReport runWith(FamilyRunner mutant) {
        List<FamilyRunner> runners = new ArrayList<>();
        for (FamilyRunner r : JvmFamilies.ALL) runners.add(r.family().equals(mutant.family()) ? mutant : r);
        return new ParitySuite(fresh(), runners).run();
    }

    private static Set<String> failedIds(SuiteReport report, String family) {
        Set<String> ids = new TreeSet<>();
        for (CaseResult r : report.failures()) {
            assertEquals("only the mutated family may fail: " + r.id(), family, r.family());
            ids.add(r.id());
        }
        assertTrue("the problems are the mutation's, not the tree's: " + report.problems(), report.problems().isEmpty());
        return ids;
    }

    private static FixtureCase scenario(ParityData data, String id) {
        for (FixtureFile file : data.fixtures.get("manager-episode")) {
            for (FixtureCase c : file.cases()) if (c.id().equals(id)) return c;
        }
        throw new AssertionError("no " + id + " in the manager-episode fixtures");
    }

    private static Codec.Context context(ParityData data) {
        return new Codec.Context(data.repoRoot);
    }

    @Test
    public void everyA24FamilyRunsWholeAndPasses() {
        SuiteReport report = new ParitySuite(fresh()).run();
        for (String family : Arrays.asList("manager-episode", "deck-episode")) {
            ParitySuite.FamilySummary s = report.summary(family);
            assertTrue(family + " has a JVM runner", s.hasRunner());
            assertTrue(family + " has cases", s.cases() > 0);
            assertEquals(family + " runs every case", s.cases(), s.executed());
            assertEquals(family + " passes every case (0 owed)", s.cases(), s.passed());
        }
    }

    /** MUTATION: a play before the deck is ready. The named case goes red with the driver's evidence in its diff. */
    @Test
    public void aPlayBeforeTheDeckIsReadyTurnsTheScenarioRed() {
        SuiteReport report = runWith(ManagerEpisodeFamily.runner(EngineScenarioDriver.Mutation.PLAY_ON_LOAD));
        Set<String> failed = failedIds(report, "manager-episode");
        String id = "manager-episode/play-loads-then-starts";
        assertTrue(failed.toString(), failed.contains(id));
        CaseResult red = report.result(id);
        assertEquals(Outcome.FAILED, red.outcome());
        assertTrue(red.detail(), red.detail().contains("!deck-play-before-ready"));
    }

    /**
     * MUTATION: a play while the session is lost to an interruption. THE AUDIBLE-START
     * INVARIANT FAILS UNDER MUTATION: the driver's per-turn check names the command and the
     * phase it sounded in, and the case goes red.
     */
    @Test
    public void aPlayWhileLostToAnInterruptionTurnsTheScenarioRed() {
        String id = "manager-episode/declined-call-resumes-answered-call-stays-paused";
        SuiteReport report = runWith(ManagerEpisodeFamily.runner(EngineScenarioDriver.Mutation.PLAY_WHILE_LOST));
        Set<String> failed = failedIds(report, "manager-episode");
        assertTrue(failed.toString(), failed.contains(id));
        CaseResult red = report.result(id);
        assertEquals(Outcome.FAILED, red.outcome());
        assertTrue(red.detail(), red.detail().contains("!audible-start:deckPlay@lostToInterruption"));
        ParityData data = fresh();
        EngineScenarioDriver.Run run = new EngineScenarioDriver(EngineScenarioDriver.Mutation.PLAY_WHILE_LOST)
                .run(scenario(data, id), context(data));
        assertTrue(run.violations().toString(), run.violations().contains("audible-start:deckPlay@lostToInterruption"));
    }

    /** Two loads land for two skips; exactly one item starts, and it is the final target: never two audible sources. */
    @Test
    public void twoLandingLoadsStartOneItemAndOneSourceOnly() {
        ParityData data = fresh();
        EngineScenarioDriver.Run run = new EngineScenarioDriver()
                .run(scenario(data, "manager-episode/double-skip-with-slow-loads-plays-once"), context(data));
        assertEquals(Arrays.asList("a", "c"), run.plays());
        assertEquals(1, run.maxAudibleSources());
        assertEquals(List.of(), run.violations());
    }

    /**
     * Every manager-episode scenario, unbroken: no check fires, and every grace span begun is
     * ended (and some are begun: the resumes, the car, the cold play).
     */
    @Test
    public void everyScenarioKeepsTheInvariantsAndClosesItsGrace() {
        ParityData data = fresh();
        Codec.Context context = context(data);
        int begun = 0;
        for (FixtureFile file : data.fixtures.get("manager-episode")) {
            for (FixtureCase c : file.cases()) {
                if (!"scenario".equals(c.kind())) continue;
                EngineScenarioDriver.Run run = new EngineScenarioDriver().run(c, context);
                assertEquals(c.id(), List.of(), run.violations());
                int begins = 0;
                int ends = 0;
                for (EngineCommand command : run.commands()) {
                    if (command instanceof EngineCommand.GraceBegin) begins++;
                    if (command instanceof EngineCommand.GraceEnd) ends++;
                }
                assertEquals(c.id() + ": every grace begin has an end", begins, ends);
                begun += begins;
            }
        }
        assertTrue("the resume, route and cold scenarios open grace (" + begun + ")", begun >= 5);
    }
}

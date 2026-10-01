package ai.jwlabs.foura.engine.parity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineMode;
import ai.jwlabs.foura.engine.parity.ParitySuite.CaseResult;
import ai.jwlabs.foura.engine.parity.ParitySuite.SuiteReport;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.Test;

/**
 * Card A-29: the {@code engine-mode} family runs whole on the JVM and can go red. Each mutant is
 * one of the ways the plan says the decision can be wrong (a strike counted per launch instead of
 * per crash, a sticky pin that outlives its build, an override that beats the crash-loop guard, a
 * page-health strike counted from the live count), handed to the REAL fixture tree through the
 * runner's seam; named cases of this family, and only this family, must fail.
 */
public class EngineModeFamilyTest {
    private static SuiteReport runWith(FamilyRunner mutant) {
        List<FamilyRunner> runners = new ArrayList<>();
        for (FamilyRunner r : JvmFamilies.ALL) runners.add(r.family().equals(mutant.family()) ? mutant : r);
        return new ParitySuite(ParityData.load(ParitySuiteTest.parityDir()), runners).run();
    }

    private static Set<String> failed(FamilyRunner mutant) {
        SuiteReport report = runWith(mutant);
        Set<String> ids = new TreeSet<>();
        for (CaseResult r : report.failures()) {
            assertEquals("only engine-mode may fail: " + r.id(), "engine-mode", r.family());
            ids.add(r.id());
        }
        assertTrue("the problems are the mutation's, not the tree's: " + report.problems(), report.problems().isEmpty());
        return ids;
    }

    private static EngineMode.Inputs with(EngineMode.Inputs i, boolean sentinelWasSet, EngineMode.ModeOverride o, String sticky) {
        return new EngineMode.Inputs(i.buildDefault(), o, sentinelWasSet, i.strikes(), sticky, i.currentBuild(), i.built());
    }

    @Test
    public void theFamilyRunsWholeAndPasses() {
        ParitySuite.FamilySummary s = new ParitySuite(ParityData.load(ParitySuiteTest.parityDir())).run().summary("engine-mode");
        assertTrue(s.hasRunner());
        assertEquals("every case runs", s.cases(), s.executed());
        assertEquals("every case passes (0 owed)", s.cases(), s.passed());
    }

    /** R18: a launch counter instead of a sentinel would call three background launches a crash loop. */
    @Test
    public void aStrikePerLaunchInsteadOfPerCrashIsCaught() {
        Set<String> ids = failed(EngineModeFamily.runner(i -> EngineMode.decide(with(i, true, i.modeOverride(), i.stickyLegacyBuild())),
                EngineMode::trace));
        assertTrue(ids.toString(), ids.contains("engine-mode/decide-sentinel-clear-adds-none"));
        assertTrue(ids.toString(), ids.contains("engine-mode/decide-build-default-native"));
    }

    /** OQ-9: a sticky pin that ignores the build number keeps a fixed build on the old player forever. */
    @Test
    public void aStickyPinThatOutlivesItsBuildIsCaught() {
        Set<String> ids = failed(EngineModeFamily.runner(i -> {
            EngineMode.Decision d = EngineMode.decide(i);
            String pin = i.stickyLegacyBuild();
            if (pin == null || pin.isEmpty() || !i.built()) return d;
            return new EngineMode.Decision(EngineMode.Mode.LEGACY, ai.jwlabs.foura.engine.Vocabulary.ModeReason.CRASH_LOOP, d.strikes(), pin, false);
        }, EngineMode::trace));
        assertTrue(ids.toString(), ids.contains("engine-mode/decide-sticky-legacy-cleared-by-new-build"));
    }

    /** Safety beats every preference: an override of native must not escape the crash loop. */
    @Test
    public void anOverrideThatBeatsTheCrashLoopIsCaught() {
        Set<String> ids = failed(EngineModeFamily.runner(i -> {
            if (i.built() && i.modeOverride() == EngineMode.ModeOverride.NATIVE) {
                return new EngineMode.Decision(EngineMode.Mode.NATIVE, ai.jwlabs.foura.engine.Vocabulary.ModeReason.OVERRIDE,
                        Math.max(0, i.strikes()) + (i.sentinelWasSet() ? 1 : 0), null, true);
            }
            return EngineMode.decide(i);
        }, EngineMode::trace));
        assertTrue(ids.toString(), ids.contains("engine-mode/decide-crash-loop-beats-override-native"));
    }

    /** A page broken on every launch must still reach the JS lane: the trace's page-health rule. */
    @Test
    public void aTraceWhoseHealthyMarkerAlwaysResetsTheStrikesIsCaught() {
        Set<String> ids = failed(EngineModeFamily.runner(EngineMode::decide, (initial, events) -> {
            // Treat every page-health event as a healthy one: no strike ever survives.
            List<EngineMode.Event> rewritten = new ArrayList<>();
            for (EngineMode.Event e : events) rewritten.add(e instanceof EngineMode.Event.PageHealth ? new EngineMode.Event.Healthy() : e);
            List<EngineMode.Step> steps = EngineMode.trace(initial, rewritten);
            List<EngineMode.Step> out = new ArrayList<>();
            for (int k = 0; k < steps.size(); k++) {
                EngineMode.Step s = steps.get(k);
                out.add(new EngineMode.Step(events.get(k).kind(), s.mode(), s.reason(), s.stored()));
            }
            return out;
        }));
        assertTrue(ids.toString(), ids.contains("engine-mode/trace-page-health-strikes-reach-crash-loop"));
    }
}

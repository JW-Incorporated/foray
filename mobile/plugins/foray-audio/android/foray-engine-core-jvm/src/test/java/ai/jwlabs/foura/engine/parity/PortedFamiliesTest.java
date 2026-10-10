package ai.jwlabs.foura.engine.parity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.MediaAction;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.PlayerEffect;
import ai.jwlabs.foura.engine.PlayerEvent;
import ai.jwlabs.foura.engine.PlayerQueueState;
import ai.jwlabs.foura.engine.PlayerQueueStateMachine;
import ai.jwlabs.foura.engine.SessionPolicy;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import ai.jwlabs.foura.engine.parity.ParitySuite.CaseResult;
import ai.jwlabs.foura.engine.parity.ParitySuite.Outcome;
import ai.jwlabs.foura.engine.parity.ParitySuite.SuiteReport;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.Test;

/**
 * A-23's ported families can go red (the Swift NE-07s / NE-11s / NE-12s mutation tests,
 * for the JVM). Each test hands the REAL fixture tree a port with one deliberate mistake,
 * through the runner's seam, and requires named cases of that family, and only that
 * family, to fail. Nothing on disk is written and no mutant reaches main code.
 */
public class PortedFamiliesTest {
    private static ParityData fresh() {
        return ParityData.load(ParitySuiteTest.parityDir());
    }

    /** Run the real tree with {@code mutant} registered in place of its family's real runner. */
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

    @Test
    public void everyA23FamilyRunsWholeAndPasses() {
        SuiteReport report = new ParitySuite(fresh()).run();
        for (String family : Arrays.asList("queue-state", "rate", "resume-rules", "transport", "rows", "session", "session-invariant",
                "media-episode")) {
            ParitySuite.FamilySummary s = report.summary(family);
            assertTrue(family + " has a JVM runner", s.hasRunner());
            assertEquals(family + " runs every case", s.cases(), s.executed());
            assertEquals(family + " passes every case (0 owed)", s.cases(), s.passed());
        }
    }

    /** NE-07s's mutation, on the JVM: swap the first two effects of itemLoaded from loadingItem. */
    @Test
    public void aReducerThatSwapsTwoItemLoadedEffectsIsCaught() {
        FamilyRunner mutant = QueueStateFamily.runner((state, event) -> {
            PlayerQueueStateMachine.Transition t = PlayerQueueStateMachine.reduce(state, event);
            if (!(state instanceof PlayerQueueState.LoadingItem) || !(event instanceof PlayerEvent.ItemLoaded)) return t;
            List<PlayerEffect> effects = new ArrayList<>(t.effects());
            PlayerEffect first = effects.get(0);
            effects.set(0, effects.get(1));
            effects.set(1, first);
            return new PlayerQueueStateMachine.Transition(t.state(), effects);
        });
        Set<String> failed = failedIds(runWith(mutant), "queue-state");
        assertTrue(failed.toString(), failed.contains("queue-state/item-loaded-episode-restores-rate"));
        assertTrue(failed.toString(), failed.contains("queue-state/pending-seek-applied-before-start"));
    }

    /** NE-11s's mutation: a pause under the {@code none} hold policy that keeps the session. */
    @Test
    public void aSessionTableThatHoldsThroughANonePauseIsCaught() {
        FamilyRunner mutant = SessionFamily.runner((phase, input, hold) -> {
            if (input.kind() == SessionPolicy.InputKind.PAUSE) hold = SessionPolicy.HoldPolicy.FOREVER;
            return SessionPolicy.transition(phase, input, hold);
        });
        assertEquals(Set.of("session/active-pause-hold-none"), failedIds(runWith(mutant), "session"));
    }

    /** The invariant's mutation: count a sessionResult:ok nobody asked for as an activation. */
    @Test
    public void anInvariantThatTrustsAnUnaskedSuccessIsCaught() {
        FamilyRunner mutant = SessionFamily.invariantRunner((phase, turn) -> {
            boolean active = phase == SessionPolicy.Phase.ACTIVE;
            List<SessionPolicy.Violation> out = new ArrayList<>();
            for (int at = 0; at < turn.size(); at++) {
                String cmd = turn.get(at);
                if (cmd.equals(SessionPolicy.TurnMarker.RESULT_OK)) active = true; // the mistake: asked or not
                else if (cmd.equals(SessionPolicy.TurnMarker.DEACTIVATE)) active = false;
                else if (SessionPolicy.AUDIBLE_COMMANDS.contains(cmd) && !active) out.add(new SessionPolicy.Violation(at, cmd));
            }
            return out;
        });
        assertFalse(failedIds(runWith(mutant), "session-invariant").isEmpty());
    }

    /** NE-12s's mutation: an enablement table that offers next with no next. */
    @Test
    public void aSurfaceThatOffersNextWithNoNextIsCaught() {
        FamilyRunner mutant = MediaEpisodeFamily.runner(surface -> {
            List<MediaAction> installed = MediaMapping.installedActions(surface);
            if (!installed.isEmpty() && !installed.contains(MediaAction.NEXT_TRACK)) installed.add(MediaAction.NEXT_TRACK);
            return installed;
        });
        Set<String> failed = failedIds(runWith(mutant), "media-episode");
        assertTrue(failed.toString(), failed.contains("media-episode/actions-no-next-no-button"));
    }

    /** CH3-10's mutation: an availability that ignores the track route (the speaker cases go red, and only they). */
    @Test
    public void anAvailabilityThatIgnoresTheTrackRouteIsCaught() {
        FamilyRunner mutant = MediaEpisodeFamily.runnerWithAvailability(
                (snapshot, trackRoute) -> MediaMapping.commandAvailability(snapshot, MediaMapping.SeekSteps.DEFAULT, true));
        assertEquals(Set.of("media-episode/availability-speaker-keeps-the-skip-pair-with-up-next",
                        "media-episode/availability-foray-on-speaker-keeps-the-skip-pair"),
                failedIds(runWith(mutant), "media-episode"));
    }

    /**
     * BYTE-IDENTICAL, not merely equal: the recorded row with two members swapped is the
     * SAME JSON value in different bytes, and the case must fail on it. A runner that
     * parsed the row and compared objects would stay green here.
     */
    @Test
    public void aRowWithTheSameValueInOtherBytesFails() {
        ParityData data = fresh();
        String id = "rows/cp-pos-typical";
        String recorded = "{\"seconds\":1234.5,\"duration\":3600,\"updated_at\":\"2026-09-21T14:13:20.123Z\",\"source\":\"local\"}";
        String reordered = "{\"duration\":3600,\"seconds\":1234.5,\"updated_at\":\"2026-09-21T14:13:20.123Z\",\"source\":\"local\"}";
        List<FixtureFile> files = new ArrayList<>();
        boolean found = false;
        for (FixtureFile f : data.fixtures.get("rows")) {
            List<FixtureCase> cases = new ArrayList<>();
            for (FixtureCase c : f.cases()) {
                if (c.id().equals(id)) {
                    Json row = c.expect().get("return").asList().get(0);
                    assertEquals("precondition: the recorded bytes", recorded, row.get("value").asString());
                    Map<String, Json> mutated = new LinkedHashMap<>(row.asMap());
                    mutated.put("value", Json.str(reordered));
                    Map<String, Json> expect = new LinkedHashMap<>();
                    expect.put("return", new Json.Arr(List.of(new Json.Obj(mutated))));
                    cases.add(c.withExpect(new Json.Obj(expect)));
                    found = true;
                } else {
                    cases.add(c);
                }
            }
            files.add(new FixtureFile(f.path(), f.family(), f.module(), cases, f.jsOnly()));
        }
        assertTrue(found);
        data.fixtures.put("rows", files);
        SuiteReport report = new ParitySuite(data).run();
        assertEquals(Outcome.FAILED, report.result(id).outcome());
        assertEquals(1, report.failures().size());
    }
}

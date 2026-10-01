package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.util.List;

/**
 * The Foray tape (card A-40), the JVM twin of the Swift ForayTapeFamilies (NE-30s), from the
 * scenarios NE-30j/NE-31j recorded:
 * <ul>
 *   <li>{@code manager-foray}: queue-manager's Foray tape (tape.json: in-points and out-points,
 *       the out-point as the item's end, back-to-back slices, speed across seams, ADR-0007's
 *       ladder at load, the dropped-items report, the seam beat under every transport action),
 *       the playback half over the REAL frozen Forays (real-forays.json), the narrating overlay
 *       (narration.json), the jingle (jingle.json) and the audition's refusal (audition.json),
 *       driven through {@code EngineCore} with the Foray tape on;</li>
 *   <li>{@code prepare}: seams at the AUDIBLE level through the engine CONTRACT with the standby
 *       deck, the {@code n.prepare:} / {@code n.handover:} tokens asserted;</li>
 *   <li>{@code prepare-narration} (NE-45j recorded it, NE-45s ported it to Swift, card A-62 to the
 *       JVM): the same audible seams with a narration line in them (a rendered line prepared and
 *       handed over like a clip, the clip after it prepared from the line's duration or, behind a
 *       SPOKEN line, at the line's start, and a same-source prepare on the standby written
 *       {@code n.prepare-seek:}), plus deck-policy.js's {@code warmsAcross} and the duration
 *       window.</li>
 * </ul>
 * A Foray a scenario plays is the PAGE's build (player/parity/scenario-builds.json).
 */
final class ForayTapeFamilies {
    private ForayTapeFamilies() {}

    static FamilyRunner managerForay(EngineScenarioDriver.Mutation mutation) {
        // audition's refusal was recorded against reference-engine (the contract's `audition`), so
        // this family runs both targets.
        return new TapeRunner("manager-foray", List.of("manager", "engine"), new EngineScenarioDriver(mutation, true));
    }

    static FamilyRunner managerForay() {
        return managerForay(null);
    }

    static FamilyRunner prepare(EngineScenarioDriver.Mutation mutation) {
        return new TapeRunner("prepare", List.of("engine"), new EngineScenarioDriver(mutation, true));
    }

    static FamilyRunner prepare() {
        return prepare(null);
    }

    /**
     * {@code prepare-narration} (card A-62), routed by the fixture FILE's module: {@code policy.json}
     * is player/deck-policy.js ({@code warmsAcross}, and {@code prefetchWindowOpens} with
     * {@code durationSec}, through the readers the {@code deck} family's deck-pair cases use), and
     * {@code seams.json} names none, so its cases are engine-target scenarios through the contract,
     * as {@code prepare}'s are. The Swift {@code PrepareNarrationFamily}.
     */
    static FamilyRunner prepareNarration(EngineScenarioDriver.Mutation mutation) {
        java.util.Map<String, FamilyRunner> routes = new java.util.LinkedHashMap<>();
        routes.put(DeckFamilies.MODULE, new FamilyRunner.Pure("prepare-narration", DeckFamilies.MODULE, java.util.Map.of(),
                DeckFamilies.deckCalls()));
        routes.put(ForayHarness.SCENARIOS, new TapeRunner("prepare-narration", List.of("engine"), new EngineScenarioDriver(mutation, true)));
        return new ForayHarness.ModuleRouted("prepare-narration", routes);
    }

    static FamilyRunner prepareNarration() {
        return prepareNarration(null);
    }

    /** Scenarios only, of the family's targets: a case aimed at another target is refused rather than run. */
    record TapeRunner(String family, List<String> targets, EngineScenarioDriver driver) implements FamilyRunner {
        @Override
        public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
            if (!"scenario".equals(testCase.kind())) {
                throw new HarnessError("E_BAD_CASE", "the " + family + " family is scenarios only; " + testCase.id() + " is not one");
            }
            Json setup = testCase.raw().get("setup");
            String target = setup == null ? null : JsArgs.at(setup, "target").asString();
            if (target == null || !targets.contains(target)) {
                throw new HarnessError("E_SCENARIO_TARGET", "the JVM " + family + " family drives the " + String.join(" and ", targets)
                        + " target, not " + (target == null ? "none" : target));
            }
            return driver.run(testCase, context).encoded();
        }
    }
}

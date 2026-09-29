package ai.jwlabs.foura.engine.parity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import ai.jwlabs.foura.engine.parity.ParitySuite.CaseResult;
import ai.jwlabs.foura.engine.parity.ParitySuite.Outcome;
import ai.jwlabs.foura.engine.parity.ParitySuite.SuiteReport;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/**
 * The books can go red, each way the card says they must. Every test loads the REAL
 * tree, changes one thing in memory, and checks the suite notices; nothing on disk is
 * written. (android-build.yml repeats the first one against a copy on disk, through
 * FORAY_PARITY_DIR, so the whole path from a fixture file to a red job is exercised.)
 */
public class ParityBooksTest {
    private static final String NUMBER_FORMAT = "number-format";
    private static final String POINT_ONE = "number-format/point-one";

    private static ParityData fresh() {
        return ParityData.load(ParitySuiteTest.parityDir());
    }

    private static SuiteReport run(ParityData data) {
        return new ParitySuite(data).run();
    }

    private static Json obj(String key, Json value) {
        Map<String, Json> m = new LinkedHashMap<>();
        m.put(key, value);
        return new Json.Obj(m);
    }

    /** Replace one case's expect in memory, as a hand-edit of the fixture file would. */
    private static void setExpect(ParityData data, String family, String id, Json expect) {
        List<FixtureFile> files = new ArrayList<>();
        boolean found = false;
        for (FixtureFile f : data.fixtures.get(family)) {
            List<FixtureCase> cases = new ArrayList<>();
            for (FixtureCase c : f.cases()) {
                if (c.id().equals(id)) {
                    cases.add(c.withExpect(expect));
                    found = true;
                } else {
                    cases.add(c);
                }
            }
            files.add(new FixtureFile(f.path(), f.family(), f.module(), cases, f.jsOnly()));
        }
        assertTrue("precondition: " + id + " is a " + family + " case", found);
        data.fixtures.put(family, files);
    }

    private static boolean hasProblem(SuiteReport report, String needle) {
        for (String p : report.problems()) if (p.contains(needle)) return true;
        return false;
    }

    /** A family every file of which is jsOnly, or null when the tree has none. */
    private static String jsOnlyFamily(ParityData data) {
        for (Map.Entry<String, List<FixtureFile>> e : data.fixtures.entrySet()) {
            boolean all = !e.getValue().isEmpty();
            for (FixtureFile f : e.getValue()) all &= f.jsOnly();
            if (all) return e.getKey();
        }
        return null;
    }

    /** A family owed whole, with at least one case. */
    private static String owedFamily(ParityData data) {
        for (String family : data.pendingFamilies.keySet()) {
            if (data.manifest.containsKey(family) && !data.manifest.get(family).isEmpty()) return family;
        }
        throw new AssertionError("precondition: jvm-pending.json owes no recorded family");
    }

    @Test
    public void theUntouchedTreeBalancesAndPointOnePasses() {
        SuiteReport report = run(fresh());
        assertTrue(String.join("\n", report.problems()), report.ok());
        assertEquals(Outcome.PASSED, report.result(POINT_ONE).outcome());
    }

    @Test
    public void aMutatedFixtureValueTurnsTheRunRed() {
        // The acceptance line: "A mutation of one fixture value turns it red."
        ParityData data = fresh();
        setExpect(data, NUMBER_FORMAT, POINT_ONE, obj("return", Json.str("0.2")));
        SuiteReport report = run(data);
        CaseResult r = report.result(POINT_ONE);
        assertEquals(Outcome.FAILED, r.outcome());
        assertTrue(r.detail(), r.detail().contains("$.return") && r.detail().contains("\"0.1\""));
        assertFalse(report.ok());
        assertEquals(1, report.failures().size());
    }

    @Test
    public void aMutatedCompareVerdictTurnsTheRunRed() {
        // The comparator is held to compare.js: flip one recorded verdict and it must disagree.
        ParityData data = fresh();
        FixtureCase first = data.fixtures.get("compare").get(0).cases().get(0);
        Json verdict = first.expect().get("return");
        Json equal = verdict.get("equal");
        Map<String, Json> flipped = new LinkedHashMap<>(verdict.asMap());
        flipped.put("equal", Json.TRUE.equals(equal) ? Json.FALSE : Json.TRUE);
        setExpect(data, "compare", first.id(), obj("return", new Json.Obj(flipped)));
        SuiteReport report = run(data);
        assertEquals(Outcome.FAILED, report.result(first.id()).outcome());
        assertFalse(report.ok());
    }

    @Test
    public void anOwedCaseThatFailsIsPendingAndNotRed() {
        ParityData data = fresh();
        setExpect(data, NUMBER_FORMAT, POINT_ONE, obj("return", Json.str("0.2")));
        data.pendingCases.put(POINT_ONE, "A-23");
        SuiteReport report = run(data);
        assertEquals(Outcome.PENDING, report.result(POINT_ONE).outcome());
        assertTrue(String.join("\n", report.problems()), report.ok());
    }

    @Test
    public void aPendingCaseThatPassesIsStaleAndRed() {
        ParityData data = fresh();
        data.pendingCases.put(POINT_ONE, "A-23");
        SuiteReport report = run(data);
        CaseResult r = report.result(POINT_ONE);
        assertEquals(Outcome.STALE_PENDING, r.outcome());
        assertTrue(r.detail(), r.detail().contains("delete the entry"));
        assertFalse(report.ok());
    }

    @Test
    public void aWholeFamilyOwedWhileItsRunnerPassesIsStaleAndRed() {
        ParityData data = fresh();
        data.pendingFamilies.put(NUMBER_FORMAT, "A-23");
        SuiteReport report = run(data);
        assertEquals(data.manifest.get(NUMBER_FORMAT).size(), report.summary(NUMBER_FORMAT).failed());
        assertEquals(Outcome.STALE_PENDING, report.result(POINT_ONE).outcome());
        assertFalse(report.ok());
    }

    @Test
    public void anIdNeitherRunNorOwedIsUnaccountedAndRed() {
        // What a JVM card that registers nothing but deletes its pending entry would do.
        ParityData data = fresh();
        String family = owedFamily(data);
        data.pendingFamilies.remove(family);
        SuiteReport report = run(data);
        String id = data.manifest.get(family).get(0);
        assertEquals(Outcome.UNACCOUNTED, report.result(id).outcome());
        assertEquals(data.manifest.get(family).size(), report.summary(family).failed());
        assertFalse(report.ok());
    }

    @Test
    public void pendingEntriesMustNameRealThingsWithAndroidCards() {
        ParityData data = fresh();
        String owed = owedFamily(data);
        data.pendingFamilies.put("no-such-family", "A-23");
        data.pendingCases.put("no-such/case", "A-23");
        data.pendingCases.put(data.manifest.get(owed).get(0), "A-24");
        data.pendingFamilies.put(owed, "NE-05");
        SuiteReport report = run(data);
        assertTrue(hasProblem(report, "owes family no-such-family, which neither manifest.json nor unported.json names"));
        assertTrue(hasProblem(report, "owes no-such/case, which names no fixture case"));
        assertTrue(hasProblem(report, "and its whole family " + owed));
        assertTrue(hasProblem(report, "with \"NE-05\", not an Android card id"));
        assertFalse(report.ok());
    }

    @Test
    public void aFamilyUnportedJsonWillRecordMayBeOwedAheadOfItsFixtures() {
        ParityData data = fresh();
        data.unportedFamilies.put("future-family", 3);
        data.pendingFamilies.put("future-family", "A-40");
        SuiteReport report = run(data);
        assertFalse(hasProblem(report, "future-family"));
        assertTrue(String.join("\n", report.problems()), report.ok());
    }

    @Test
    public void aJsOnlyFamilyIsNeverOwedAndNeverRun() {
        ParityData data = fresh();
        String family = jsOnlyFamily(data);
        assertNotNull("precondition: the tree has a jsOnly family (continuation, foray-data)", family);
        data.pendingFamilies.put(family, "A-23");
        SuiteReport report = run(data);
        assertTrue(hasProblem(report, "family " + family + " is jsOnly, but jvm-pending.json says A-23 owes it"));
        assertEquals(Outcome.JS_ONLY, report.result(data.manifest.get(family).get(0)).outcome());

        List<FamilyRunner> runners = new ArrayList<>(JvmFamilies.ALL);
        runners.add(new FamilyRunner.Pure(family, "player/none.js", Map.of(), Map.of()));
        SuiteReport withRunner = new ParitySuite(fresh(), runners).run();
        assertTrue(hasProblem(withRunner, "family " + family + " is jsOnly, but a JVM runner is registered for it"));
    }

    @Test
    public void aRunnerForAFamilyTheManifestLacksIsAProblem() {
        List<FamilyRunner> runners = new ArrayList<>(JvmFamilies.ALL);
        runners.add(new FamilyRunner.Pure("no-such-family", "player/none.js", Map.of(), Map.of()));
        SuiteReport report = new ParitySuite(fresh(), runners).run();
        assertTrue(hasProblem(report, "a JVM runner is registered for family no-such-family"));
    }

    @Test
    public void theRunsListMustBeExactlyTheRegisteredRunners() {
        // record.mjs --check trusts "runs" to say which families the JVM runs; a list
        // that drifts from JvmFamilies.ALL would let it vouch for a family nobody runs.
        ParityData missing = fresh();
        missing.runs.remove(NUMBER_FORMAT);
        SuiteReport a = run(missing);
        assertTrue(hasProblem(a, "registered for family " + NUMBER_FORMAT + ", but jvm-pending.json \"runs\" does not list it"));
        assertFalse(a.ok());

        ParityData extra = fresh();
        String owed = owedFamily(extra);
        extra.runs.add(owed);
        SuiteReport b = run(extra);
        assertTrue(hasProblem(b, "\"runs\" lists family " + owed + ", but no JVM runner is registered for it"));
        assertFalse(b.ok());
    }

    @Test
    public void aFixtureFileTheManifestDoesNotListIsAProblem() {
        ParityData data = fresh();
        data.filesOnDisk.add("player/parity/fixtures/stray/stray.json");
        assertTrue(hasProblem(run(data), "player/parity/fixtures/stray/stray.json is on disk but manifest.json does not list it"));
    }

    @Test
    public void aRunnerFacingAnotherModulesFileRefusesIt() {
        // A fixture that moves to another module is refused, not run.
        ParityData data = fresh();
        List<FixtureFile> moved = new ArrayList<>();
        for (FixtureFile f : data.fixtures.get(NUMBER_FORMAT)) {
            moved.add(new FixtureFile(f.path(), f.family(), "player/elsewhere.js", f.cases(), f.jsOnly()));
        }
        data.fixtures.put(NUMBER_FORMAT, moved);
        CaseResult r = run(data).result(POINT_ONE);
        assertEquals(Outcome.FAILED, r.outcome());
        assertTrue(r.detail(), r.detail().contains("E_BAD_CASE") && r.detail().contains("player/elsewhere.js"));
    }

    @Test
    public void aParityDirThatIsSetButWrongIsAnErrorNotAFallThrough() {
        HarnessError e = assertThrows(HarnessError.class,
                () -> ParityData.locate(Map.of("FORAY_PARITY_DIR", "/no/such/dir"), null, Path.of("")));
        assertEquals("E_BAD_CASE", e.code());
        Path real = ParitySuiteTest.parityDir();
        assertEquals(real, ParityData.locate(Map.of("FORAY_PARITY_DIR", real.resolve("fixtures").toString()), null, Path.of("")));
    }

    @Test
    public void theCodecRoundTripsEveryTagAsCodecJsDoes() {
        for (String tag : Codec.SPECIAL_NUMBERS) {
            Json encoded = obj("$num", Json.str(tag));
            assertEquals(encoded, Codec.encode(Codec.expandInputs(encoded, new Codec.Context(null))));
        }
        assertEquals(obj("$undefined", Json.TRUE), Codec.encode(Codec.expandInputs(obj("$undefined", Json.TRUE), new Codec.Context(null))));
        HarnessError bad = assertThrows(HarnessError.class, () -> Codec.expandInputs(obj("$num", Json.str("nan")), new Codec.Context(null)));
        assertEquals("E_BAD_SPECIAL", bad.code());
        HarnessError macro = assertThrows(HarnessError.class, () -> Codec.expandInputs(obj("$nope", Json.NULL), new Codec.Context(null)));
        assertEquals("E_BAD_MACRO", macro.code());
        // `$seg: ["a"]` is seam-gap.test.js's seg("a"): a forward slice 100 -> 210.
        Json seg = Codec.expandInputs(obj("$seg", Json.parse("[\"a\"]")), new Codec.Context(null));
        assertEquals(Json.parse("{\"id\":\"a\",\"kind\":\"episode\",\"start_sec\":100,\"end_sec\":210}"), seg);
    }

    @Test
    public void theComparatorSpellsItsReasonsAsCompareJsDoes() {
        List<Comparator.Difference> d = Comparator.compare(Json.num(2), Json.num(2.2), null, 0.1);
        assertEquals(1, d.size());
        assertEquals("differs by more than 0.1", d.get(0).why());
        // Key order never matters; array order always does.
        assertTrue(Comparator.compare(Json.parse("{\"a\":1,\"b\":2}"), Json.parse("{\"b\":2,\"a\":1}"), null, null).isEmpty());
        assertEquals("$[0]", Comparator.compare(Json.parse("[1,2]"), Json.parse("[2,1]"), null, null).get(0).path());
        // n.* op tokens are stripped everywhere but prepare.
        Json withNative = Json.parse("{\"ops\":[\"a\",\"n.warm\"]}");
        Json without = Json.parse("{\"ops\":[\"a\"]}");
        assertTrue(Comparator.compare(without, withNative, "deck", null).isEmpty());
        assertFalse(Comparator.compare(without, withNative, "prepare", null).isEmpty());
    }
}

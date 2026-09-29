package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * The JVM parity runner (card A-22, docs/plans/android-assessment.md §5.4): the twin of
 * the Swift ParitySuite (ForayEngineParity/ParitySuite.swift, NE-05). It walks
 * manifest.json family by family, runs every case a registered {@link FamilyRunner}
 * can run, compares with the ported {@link Comparator}, and keeps the books against
 * player/parity/jvm-pending.json. JS stays the reference: {@code record.mjs --check}
 * is what says the fixtures are right; this says whether the JVM agrees with them.
 *
 * <p>THE BOOKS, which are the point of the card. {@code owed} is the case's own entry
 * in jvm-pending.json {@code cases}, else its family's entry in {@code families}:
 *
 * <pre>
 *   executed &amp; matched &amp; not owed   -&gt; passed
 *   executed &amp; differs &amp; not owed   -&gt; FAILED          a case listed as done fails
 *   executed &amp; differs &amp; owed       -&gt; pending         owed, and honestly so
 *   executed &amp; matched &amp; owed       -&gt; FAILED "stale-pending": the port caught up, so
 *                                     the card that owes it must burn the entry down
 *   not executed &amp; owed             -&gt; not-ported      owed (no JVM runner yet)
 *   not executed &amp; not owed         -&gt; FAILED "unaccounted": a manifest id the JVM
 *                                     neither ran nor owes, i.e. a rule it dropped
 *   a jsOnly family                  -&gt; js-only: never run and never owed; a pending
 *                                     entry or a runner for it is a PROBLEM
 * </pre>
 *
 * Plus the whole-tree problems: a family runner that executes nothing or fewer cases
 * than its floor (floors.json), a runner for a family the manifest lacks, a pending
 * entry naming no case or no family (a family unported.json will record into is
 * allowed ahead of its fixtures), a case entry inside a family that is owed whole,
 * a card tag that is not an A- card, a fixture file on disk the manifest does not list,
 * a fixture id the manifest lacks, and a jvm-pending.json {@code runs} list that is not
 * exactly the registered runners (the JS side reads it to hold every recorded family
 * to exactly one of run and owed).
 */
public final class ParitySuite {
    /** An Android card id, as record.mjs's JVM_CARD_RE spells it. */
    public static final Pattern CARD = Pattern.compile("A-\\d{2}[a-z]?");

    private final ParityData data;
    private final Map<String, FamilyRunner> runners = new TreeMap<>();

    public ParitySuite(ParityData data, List<FamilyRunner> runners) {
        this.data = data;
        for (FamilyRunner r : runners) this.runners.put(r.family(), r);
    }

    public ParitySuite(ParityData data) {
        this(data, JvmFamilies.ALL);
    }

    public enum Outcome {
        PASSED("passed"), FAILED("failed"), PENDING("pending"), STALE_PENDING("stale-pending"),
        NOT_PORTED("not-ported"), UNACCOUNTED("unaccounted"), JS_ONLY("js-only");

        public final String label;

        Outcome(String label) {
            this.label = label;
        }

        /** The outcomes that fail the run. */
        public boolean isFailure() {
            return this == FAILED || this == STALE_PENDING || this == UNACCOUNTED;
        }

        /** The outcomes where the JVM port actually ran the case. */
        public boolean wasExecuted() {
            return this == PASSED || this == FAILED || this == PENDING || this == STALE_PENDING;
        }
    }

    public record CaseResult(String id, String family, Outcome outcome, String detail) {}

    public record FamilySummary(String family, boolean hasRunner, Integer floor, int cases, int executed, int passed,
                                int owed, int failed, boolean jsOnly, int unported) {
        static FamilySummary of(String family, List<CaseResult> results, boolean hasRunner, Integer floor, int unported) {
            int executed = 0, passed = 0, owed = 0, failed = 0, jsOnly = 0;
            for (CaseResult r : results) {
                if (r.outcome().wasExecuted()) executed++;
                if (r.outcome() == Outcome.PASSED) passed++;
                if (r.outcome() == Outcome.PENDING || r.outcome() == Outcome.NOT_PORTED) owed++;
                if (r.outcome().isFailure()) failed++;
                if (r.outcome() == Outcome.JS_ONLY) jsOnly++;
            }
            return new FamilySummary(family, hasRunner, floor, results.size(), executed, passed, owed, failed,
                    !results.isEmpty() && jsOnly == results.size(), unported);
        }

        /** The Swift runner's log line ({@code parity family=<f> cases=<n>}), with the books after it. */
        public String logLine() {
            return "jvm-parity family=" + family + " cases=" + cases + " executed=" + executed + " passed=" + passed
                    + " owed=" + owed + " failed=" + failed + (hasRunner ? "" : " runner=none") + (jsOnly ? " js-only" : "")
                    + (unported > 0 ? " unported-tests=" + unported : "");
        }
    }

    public record SuiteReport(List<FamilySummary> families, List<CaseResult> results, List<String> problems) {
        public List<CaseResult> failures() {
            List<CaseResult> out = new ArrayList<>();
            for (CaseResult r : results) if (r.outcome().isFailure()) out.add(r);
            return out;
        }

        public boolean ok() {
            return failures().isEmpty() && problems.isEmpty();
        }

        public CaseResult result(String id) {
            for (CaseResult r : results) if (r.id().equals(id)) return r;
            return null;
        }

        public FamilySummary summary(String family) {
            for (FamilySummary s : families) if (s.family().equals(family)) return s;
            return null;
        }

        public int count(Outcome outcome) {
            int n = 0;
            for (CaseResult r : results) if (r.outcome() == outcome) n++;
            return n;
        }

        /**
         * jvm-parity-report.json: totals, the family lines, the problems and every
         * result that is not a plain pass or a plain owe, key-sorted and stable, so two
         * runs over one tree write the same bytes and CI can read the verdict without
         * parsing a log.
         */
        public String json() {
            Map<String, Json> totals = new LinkedHashMap<>();
            for (Outcome o : Outcome.values()) totals.put(o.label, Json.num(count(o)));
            List<Json> fams = new ArrayList<>();
            for (FamilySummary s : families) fams.add(Json.str(s.logLine()));
            List<Json> probs = new ArrayList<>();
            for (String p : problems) probs.add(Json.str(p));
            List<Json> notable = new ArrayList<>();
            for (CaseResult r : results) {
                if (r.outcome() == Outcome.PASSED || r.outcome() == Outcome.NOT_PORTED || r.outcome() == Outcome.JS_ONLY) continue;
                Map<String, Json> m = new LinkedHashMap<>();
                m.put("detail", Json.str(r.detail()));
                m.put("family", Json.str(r.family()));
                m.put("id", Json.str(r.id()));
                m.put("outcome", Json.str(r.outcome().label));
                notable.add(new Json.Obj(m));
            }
            Map<String, Json> doc = new LinkedHashMap<>();
            doc.put("families", new Json.Arr(fams));
            doc.put("notable", new Json.Arr(notable));
            doc.put("ok", ok() ? Json.TRUE : Json.FALSE);
            doc.put("problems", new Json.Arr(probs));
            doc.put("totals", new Json.Obj(totals));
            return Json.show(Codec.encode(new Json.Obj(doc))) + "\n";
        }
    }

    public SuiteReport run() {
        Codec.Context context = new Codec.Context(data.repoRoot);
        List<FamilySummary> families = new ArrayList<>();
        List<CaseResult> results = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        Set<String> listedFiles = new HashSet<>();
        Map<String, String> familyOfId = new HashMap<>();

        for (Map.Entry<String, List<String>> entry : data.manifest.entrySet()) {
            String family = entry.getKey();
            List<String> ids = entry.getValue();
            FamilyRunner runner = runners.get(family);
            List<FixtureFile> files = data.fixtures.getOrDefault(family, List.of());
            Map<String, FixtureCase> byId = new HashMap<>();
            Map<String, FixtureFile> fileOf = new HashMap<>();
            for (FixtureFile file : files) {
                listedFiles.add(file.path());
                if (!file.family().equals(family)) {
                    problems.add(file.path() + " says family " + file.family() + ", but manifest.json lists it under " + family);
                }
                for (FixtureCase c : file.cases()) {
                    byId.put(c.id(), c);
                    fileOf.put(c.id(), file);
                }
            }
            Set<String> manifestIds = new HashSet<>(ids);
            for (String id : ids) familyOfId.put(id, family);
            for (String stray : new TreeSet<>(byId.keySet())) {
                if (!manifestIds.contains(stray)) {
                    problems.add(stray + " is in a " + family + " fixture file but not in manifest.json (re-record)");
                }
            }

            /* Whole families only, as runner.js validates: half a family marked jsOnly
               would hide its ported half from these books. */
            boolean anyJsOnly = false;
            boolean allJsOnly = !files.isEmpty();
            for (FixtureFile f : files) {
                anyJsOnly |= f.jsOnly();
                allJsOnly &= f.jsOnly();
            }
            if (anyJsOnly && !allJsOnly) {
                problems.add("family " + family + " has files that disagree on jsOnly (every file of a family must agree)");
            }
            String familyCard = data.pendingFamilies.get(family);

            List<CaseResult> familyResults = new ArrayList<>();
            if (allJsOnly) {
                if (runner != null) problems.add("family " + family + " is jsOnly, but a JVM runner is registered for it");
                if (familyCard != null) {
                    problems.add("family " + family + " is jsOnly, but jvm-pending.json says " + familyCard + " owes it: delete the entry");
                }
                for (String id : ids) {
                    String card = data.pendingCases.get(id);
                    if (card != null) {
                        problems.add("family " + family + " is jsOnly, but jvm-pending.json says " + card + " owes " + id + ": delete the entry");
                    }
                    familyResults.add(new CaseResult(id, family, Outcome.JS_ONLY, "JS only (plan §5.5 C-2): the page computes this rule"));
                }
            } else {
                for (String id : ids) {
                    String caseCard = data.pendingCases.get(id);
                    if (caseCard != null && familyCard != null) {
                        problems.add("jvm-pending.json owes " + id + " to " + caseCard + " and its whole family " + family
                                + " to " + familyCard + ": keep one entry");
                    }
                    String owedBy = caseCard != null ? caseCard : familyCard;
                    FixtureCase c = byId.get(id);
                    if (runner == null || c == null) {
                        String why = runner == null ? "no JVM runner for family " + family : "not in the fixture files manifest.json lists";
                        familyResults.add(owedBy != null
                                ? new CaseResult(id, family, Outcome.NOT_PORTED, "owed by " + owedBy + " (" + why + ")")
                                : new CaseResult(id, family, Outcome.UNACCOUNTED, "neither executed nor in jvm-pending.json (" + why + ")"));
                        continue;
                    }
                    String failure = execute(c, fileOf.get(id), runner, context);
                    if (failure == null && owedBy == null) {
                        familyResults.add(new CaseResult(id, family, Outcome.PASSED, ""));
                    } else if (failure == null) {
                        familyResults.add(new CaseResult(id, family, Outcome.STALE_PENDING,
                                "passes on the JVM but jvm-pending.json still says " + owedBy + " owes it: delete the entry"
                                        + (caseCard == null ? " (the family's, or split it into the ids still owed)" : "")));
                    } else if (owedBy == null) {
                        familyResults.add(new CaseResult(id, family, Outcome.FAILED, failure));
                    } else {
                        familyResults.add(new CaseResult(id, family, Outcome.PENDING, "owed by " + owedBy + ": " + failure));
                    }
                }
            }

            FamilySummary summary = FamilySummary.of(family, familyResults, runner != null, data.floors.get(family),
                    data.unportedFamilies.getOrDefault(family, 0));
            if (runner != null && summary.floor() != null && summary.executed() < summary.floor()) {
                problems.add("family " + family + " executed " + summary.executed() + " case(s), below its floor of "
                        + summary.floor() + " in floors.json");
            }
            if (runner != null && summary.executed() == 0 && !ids.isEmpty()) {
                problems.add("family " + family + " has a JVM runner and executed nothing");
            }
            families.add(summary);
            results.addAll(familyResults);
        }

        for (String family : runners.keySet()) {
            if (!data.manifest.containsKey(family)) {
                problems.add("a JVM runner is registered for family " + family + ", which manifest.json does not list");
            }
            if (!data.runs.contains(family)) {
                problems.add("a JVM runner is registered for family " + family + ", but jvm-pending.json \"runs\" does not list it"
                        + " (record.mjs --check reads \"runs\" to know which families the JVM runs)");
            }
        }
        for (String family : data.runs) {
            if (!runners.containsKey(family)) {
                problems.add("jvm-pending.json \"runs\" lists family " + family + ", but no JVM runner is registered for it");
            }
        }
        for (Map.Entry<String, String> e : data.pendingFamilies.entrySet()) {
            String family = e.getKey();
            if (!data.manifest.containsKey(family) && !data.unportedFamilies.containsKey(family)) {
                problems.add("jvm-pending.json owes family " + family + ", which neither manifest.json nor unported.json names: delete the entry");
            }
            if (!CARD.matcher(e.getValue()).matches()) {
                problems.add("jvm-pending.json tags family " + family + " with \"" + e.getValue() + "\", not an Android card id (A-23, A-24, ...)");
            }
        }
        for (Map.Entry<String, String> e : data.pendingCases.entrySet()) {
            if (!familyOfId.containsKey(e.getKey())) {
                problems.add("jvm-pending.json owes " + e.getKey() + ", which names no fixture case: delete the entry");
            }
            if (!CARD.matcher(e.getValue()).matches()) {
                problems.add("jvm-pending.json tags " + e.getKey() + " with \"" + e.getValue() + "\", not an Android card id (A-23, A-24, ...)");
            }
        }
        for (String onDisk : data.filesOnDisk) {
            if (!listedFiles.contains(onDisk)) {
                problems.add(onDisk + " is on disk but manifest.json does not list it (record it)");
            }
        }
        return new SuiteReport(families, results, problems);
    }

    /** Run one case: null when it matches its expect, otherwise why not. */
    static String execute(FixtureCase testCase, FixtureFile file, FamilyRunner runner, Codec.Context context) {
        Json expect = testCase.expect();
        if (expect == null) return "unrecorded: the case has no expect (run tools/parity/record.mjs)";
        Json actual;
        try {
            actual = runner.run(testCase, file, context);
        } catch (RuntimeException e) {
            // A harness error, or a port that threw where JS did not: either way the
            // case did not produce its expect, which is a verdict, not a crash of the run.
            return "cannot run: " + e;
        }
        List<Comparator.Difference> diffs = Comparator.compare(expect, actual, file.family(), testCase.tolerance());
        return diffs.isEmpty() ? null : "the JVM differs from the fixture\n" + Comparator.format(diffs, 12);
    }
}

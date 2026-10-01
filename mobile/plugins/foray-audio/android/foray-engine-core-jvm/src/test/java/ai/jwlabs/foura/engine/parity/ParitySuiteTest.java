package ai.jwlabs.foura.engine.parity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import ai.jwlabs.foura.engine.parity.ParitySuite.CaseResult;
import ai.jwlabs.foura.engine.parity.ParitySuite.FamilySummary;
import ai.jwlabs.foura.engine.parity.ParitySuite.Outcome;
import ai.jwlabs.foura.engine.parity.ParitySuite.SuiteReport;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

/**
 * THE JVM PARITY RUN (A-22): player/parity/fixtures/** against the JVM port, with the
 * books kept against jvm-pending.json. android-build.yml runs it in its JVM-core step
 * and reads the report it writes; the same step then points FORAY_PARITY_DIR at a copy
 * with one fixture value flipped and requires this test to FAIL.
 *
 * <p>Where the tree is: {@link ParityData#locate} (FORAY_PARITY_DIR, else the
 * foray.parity.dir property build.gradle sets, else a walk up from the working
 * directory). A tree that cannot be found or read FAILS this test; it never skips.
 */
public class ParitySuiteTest {
    static Path parityDir() {
        return ParityData.locate(System.getenv(), System.getProperty("foray.parity.dir"), Path.of(""));
    }

    @Test
    public void theJvmBooksBalanceOverTheWholeFixtureTree() throws IOException {
        Path dir = parityDir();
        SuiteReport report = new ParitySuite(ParityData.load(dir)).run();

        System.out.println("jvm-parity dir=" + dir);
        for (FamilySummary s : report.families()) System.out.println(s.logLine());
        for (String p : report.problems()) System.out.println("jvm-parity problem: " + p);
        String reportPath = System.getProperty("foray.parity.report");
        if (reportPath != null && !reportPath.isEmpty()) {
            Path out = Path.of(reportPath);
            if (out.getParent() != null) Files.createDirectories(out.getParent());
            Files.writeString(out, report.json(), StandardCharsets.UTF_8);
            System.out.println("jvm-parity report=" + out);
        }

        if (!report.ok()) {
            StringBuilder why = new StringBuilder("the JVM parity books do not balance\n");
            int shown = 0;
            for (CaseResult r : report.failures()) {
                if (shown++ == 25) {
                    why.append("... and ").append(report.failures().size() - 25).append(" more failed case(s)\n");
                    break;
                }
                why.append(r.outcome().label).append(' ').append(r.id()).append(": ").append(r.detail()).append('\n');
            }
            for (String p : report.problems()) why.append("problem: ").append(p).append('\n');
            fail(why.toString());
        }

        /* A-22's acceptance, tightened by A-63's, as data rather than as a list of family
           names: every family that is not JS-only has a JVM runner (A-63: "the JVM runs every
           recorded engine family"), every case of it is executed, NOTHING is owed (A-63 emptied
           the books, and the loader refuses a jvm-pending.json that owes again), and something
           actually passed. */
        int passed = 0;
        for (FamilySummary s : report.families()) {
            if (s.jsOnly()) continue;
            assertTrue(s.family() + " is recorded and not JS-only, so the JVM runs it (nothing may be owed since A-63)", s.hasRunner());
            assertEquals(s.family() + " has a JVM runner, so every case in it must be run", s.cases(), s.executed());
            assertEquals(s.family() + " owes nothing since A-63", 0, s.owed());
            passed += s.passed();
        }
        assertTrue("the JVM runner passed nothing: a runner that executes nothing proves nothing", passed > 0);
        assertEquals(passed, report.count(Outcome.PASSED));
    }
}

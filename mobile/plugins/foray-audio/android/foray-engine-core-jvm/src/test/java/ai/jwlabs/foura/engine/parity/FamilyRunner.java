package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Runs the cases of ONE fixture family against its JVM port (docs/native-engine-plan.md
 * §6.4; the Swift FamilyRunner protocol).
 *
 * <p>One implementation per family, registered in {@link JvmFamilies#ALL}. A family with
 * no runner is not an error in itself: jvm-pending.json must then owe it (the whole
 * family, or every one of its ids), and the suite fails on any id it does not. So a JS
 * card that records a new family never turns the JVM runner red once record.mjs has
 * handed it to a card, and a JVM card that forgets to register its runner does not go
 * quietly green either: its burned-down ids become "neither executed nor pending".
 */
public interface FamilyRunner {
    /** The fixture family (the directory name under player/parity/fixtures). */
    String family();

    /**
     * Run one case and return the ENCODED actual, the same shape as the case's expect
     * ({@code {value}}, {@code {return}}, {@code {throws: {name}}}, or
     * {@code {checkpoints, ops}}). Throw {@link HarnessError} when the case cannot run.
     */
    Json run(FixtureCase testCase, FixtureFile file, Codec.Context context);

    /** What a ported function did: returned a live value, or threw a JavaScript error of a named class. */
    sealed interface Outcome permits Returned, Threw {}

    record Returned(Json value) implements Outcome {}

    record Threw(String name) implements Outcome {}

    /** A ported export: live args in, an outcome out. */
    @FunctionalInterface
    interface Call {
        Outcome apply(List<Json> args);
    }

    /**
     * A family whose cases are {@code read}s of constants and {@code call}s of pure
     * functions of ONE JS module: the shape of every policy family. The tables map the
     * JS export names the fixture uses to the JVM port; this does the decoding, the
     * dispatch and the encoding that runner.js runCase does for JS.
     *
     * <p>{@code module} is the JS module the fixture FILE must name. A fixture that moves
     * to another module is refused, not run: its cases would then pin a rule this port
     * was never checked against.
     */
    record Pure(String family, String module, Map<String, Json> reads, Map<String, Call> calls) implements FamilyRunner {
        public Pure {
            reads = new LinkedHashMap<>(reads);
            calls = new LinkedHashMap<>(calls);
        }

        @Override
        public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
            if (!module.equals(file.module())) {
                throw new HarnessError("E_BAD_CASE", file.path() + " targets " + (file.module() == null ? "no module" : file.module())
                        + "; the JVM " + family + " runner ports " + module);
            }
            String kind = testCase.kind();
            if (kind == null) {
                throw new HarnessError("E_BAD_CASE", "case " + testCase.id() + " is not exactly one of read / call / steps");
            }
            switch (kind) {
                case "read" -> {
                    String name = testCase.raw().get("read").asString();
                    Json value = name == null ? null : reads.get(name);
                    if (value == null) throw new HarnessError("E_UNKNOWN_EXPORT", module + " has no JVM port of export \"" + name + "\"");
                    return wrap("value", Codec.encode(value));
                }
                case "call" -> {
                    String name = testCase.raw().get("call").asString();
                    Call function = name == null ? null : calls.get(name);
                    if (function == null) throw new HarnessError("E_UNKNOWN_EXPORT", module + " has no JVM port of export \"" + name + "\"");
                    List<Json> args = new ArrayList<>();
                    for (Json arg : testCase.args()) args.add(Codec.expandInputs(arg, context));
                    return switch (function.apply(args)) {
                        case Returned r -> wrap("return", Codec.encode(r.value()));
                        case Threw t -> wrap("throws", wrap("name", Json.str(t.name())));
                    };
                }
                default -> throw new HarnessError("E_SCENARIO_TARGET", "the " + family + " family has no JVM scenario driver");
            }
        }

        private static Json wrap(String key, Json value) {
            Map<String, Json> m = new LinkedHashMap<>();
            m.put(key, value);
            return new Json.Obj(m);
        }
    }
}

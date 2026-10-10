package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.EngineCore;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Rows;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code manager-episode} family against {@link EngineCore} (card A-24), from the
 * scenarios NE-14j recorded from the real {@code PlayerQueueManager}: routes,
 * interruptions and the INTERRUPTION_REWIND_SEC step back, #19's single audible start,
 * cold launch, superseded loads, the double skip, pause silence and position events, all
 * through {@link EngineScenarioDriver}; and the {@code lastEpisodeRow} pass-through through
 * {@link EngineCore#lastEpisodeRow}, against rows.js {@code engineLastEpisodeRow}. The JVM
 * twin of the Swift ManagerEpisodeFamily.
 *
 * <p>{@link #remainderRunner} runs {@code manager-remainder} (code-health-3 CH3-17) through the
 * same driver: transport.json's episode cases (an unknown ref errors to idle, the position
 * writer, the rate getter and its snap line, stop's silence behind a paused machine, and a
 * play settling mid-skip-back keeping the restart). Its warming.json cases are the Foray
 * tape's warming window, owed case by case to A-40 in jvm-pending.json; the driver refuses
 * their {@code backend.prefetch} by name. The Swift ManagerRemainderFamily runs the family
 * with the tape on.
 */
final class ManagerEpisodeFamily {
    private ManagerEpisodeFamily() {}

    static final String FAMILY = "manager-episode";
    static final String REMAINDER = "manager-remainder";
    static final String ROWS_MODULE = "player/parity/rows.js";

    static FamilyRunner runner() {
        return runner(null);
    }

    /** A runner over a deliberately broken core, for the mutation tests. */
    static FamilyRunner runner(EngineScenarioDriver.Mutation mutation) {
        return runner(FAMILY, mutation);
    }

    /** {@code manager-remainder}: scenarios only, through the same episode driver. */
    static FamilyRunner remainderRunner() {
        return runner(REMAINDER, null);
    }

    /** Code-health-3 CH3-20's {@code native-episode}: scenarios only, through the same episode driver. */
    static final String NATIVE_EPISODE = "native-episode";

    static FamilyRunner nativeEpisodeRunner() {
        return runner(NATIVE_EPISODE, null);
    }

    private static FamilyRunner runner(String family, EngineScenarioDriver.Mutation mutation) {
        EngineScenarioDriver driver = new EngineScenarioDriver(mutation);
        return new FamilyRunner() {
            @Override
            public String family() {
                return family;
            }

            @Override
            public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
                String kind = testCase.kind();
                if (kind == null) throw new HarnessError("E_BAD_CASE", "case " + testCase.id() + " is not exactly one of read / call / steps");
                if (!kind.equals("scenario") && !family.equals(FAMILY)) {
                    throw new HarnessError("E_BAD_CASE", "the JVM " + family + " runner runs scenarios only");
                }
                switch (kind) {
                    case "scenario":
                        return driver.run(testCase, context).encoded();
                    case "call": {
                        if (!ROWS_MODULE.equals(file.module())) {
                            throw new HarnessError("E_BAD_CASE", file.path() + " targets " + (file.module() == null ? "no module" : file.module())
                                    + "; the JVM manager-episode calls port " + ROWS_MODULE);
                        }
                        String call = testCase.raw().get("call").asString();
                        if (!"engineLastEpisodeRow".equals(call)) {
                            throw new HarnessError("E_UNKNOWN_EXPORT", ROWS_MODULE + " has no JVM port of export \"" + call + "\"");
                        }
                        return engineLastEpisodeRow(testCase.args(), context);
                    }
                    default:
                        throw new HarnessError("E_UNKNOWN_EXPORT", "the manager-episode family reads no constant");
                }
            }
        };
    }

    /**
     * {@code engineLastEpisodeRow(lastEpisodeRow, nowMs)}: an object with a non-empty string
     * id is written as {@code {...row, updated_at}}, where {@code new Date(nowMs).toISOString()}
     * throws a RangeError for a time a Date cannot hold; anything else writes nothing.
     *
     * <p>THE ROW'S KEY ORDER IS THE RULE ("in the order the page sent it"), and the fixture's
     * own order survives here: {@link Json.Obj} keeps its members in source order and
     * {@link RowsFamily#node} writes them in that order, so no second read of the file (the
     * Swift runner's {@code OrderedFixtureArgs}) is needed.
     */
    static Json engineLastEpisodeRow(List<Json> raw, Codec.Context context) {
        Json row = Codec.expandInputs(JsArgs.arg(raw, 0), context);
        String id = row instanceof Json.Obj ? JsArgs.at(row, "id").asString() : null;
        if (id == null || id.isEmpty()) return wrap("return", new Json.Arr(List.of()));
        Double nowMs = raw.size() > 1 ? Codec.expandInputs(raw.get(1), context).asNumber() : null;
        String stamp = nowMs == null ? null : JSWriter.isoString(nowMs);
        if (stamp == null) return wrap("throws", wrap("name", Json.str("RangeError")));
        JsonNode node = RowsFamily.node(row);
        Rows.StoredRow stored = EngineCore.lastEpisodeRow(node, stamp);
        if (stored == null) return wrap("return", new Json.Arr(List.of()));
        Map<String, Json> write = new LinkedHashMap<>();
        write.put("key", Json.str(stored.key()));
        write.put("value", Json.str(stored.value()));
        return wrap("return", new Json.Arr(List.of(new Json.Obj(write))));
    }

    private static Json wrap(String key, Json value) {
        Map<String, Json> m = new LinkedHashMap<>();
        m.put(key, value);
        return new Json.Obj(m);
    }
}

package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.obj;

import ai.jwlabs.foura.engine.EngineMode;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code engine-mode} family against {@link EngineMode} (card A-29): {@code decideEngineMode}
 * and {@code engineModeTrace} from {@code player/engine-contract.js}. The JVM twin of the Swift
 * {@code EngineModeFamily} (ForayEngineParity/Families/SessionFamilies.swift).
 *
 * <p>TRANSLATION ONLY, and the stored values are read the way the JS reads them, which is also
 * the way foray-audio's {@code EngineOwnership} reads the engine-private keys: a strike count that
 * is not a positive whole number is 0, a pin that is not a non-empty string is none, an override
 * outside the closed set is {@code auto}, and only a real {@code true} is a set sentinel or a
 * built engine.
 */
final class EngineModeFamily {
    private EngineModeFamily() {}

    /** The decision under test, as a value (the mutation seam). */
    @FunctionalInterface
    interface Decider {
        EngineMode.Decision apply(EngineMode.Inputs inputs);
    }

    /** The trace under test, as a value (the mutation seam). */
    @FunctionalInterface
    interface Tracer {
        List<EngineMode.Step> apply(EngineMode.Stored initial, List<EngineMode.Event> events);
    }

    static FamilyRunner runner() {
        return runner(EngineMode::decide, EngineMode::trace);
    }

    static FamilyRunner runner(Decider decider, Tracer tracer) {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("STRIKE_LIMIT", Json.num(EngineMode.STRIKE_LIMIT));
        List<String> events = new ArrayList<>();
        for (EngineMode.EventKind k : EngineMode.EventKind.values()) events.add(k.token);
        reads.put("ENGINE_MODE_EVENTS", JsArgs.strings(events));
        List<String> overrides = new ArrayList<>();
        for (EngineMode.ModeOverride o : EngineMode.ModeOverride.values()) overrides.add(o.token);
        reads.put("MODE_OVERRIDES", JsArgs.strings(overrides));

        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("decideEngineMode", args -> {
            // `i?.x`: a missing or null argument reads every field as undefined.
            Json i = arg(args, 0);
            EngineMode.Decision d = decider.apply(new EngineMode.Inputs(
                    buildDefault(at(i, "buildDefault")),
                    EngineMode.ModeOverride.stored(at(i, "override").asString()),
                    JsArgs.isTrue(at(i, "sentinelWasSet")),
                    strikes(at(i, "strikes")),
                    at(i, "stickyLegacyBuild").asString(),
                    at(i, "currentBuild").asString(),
                    JsArgs.isTrue(at(i, "built"))));
            return new Returned(obj("mode", Json.str(d.mode().token), "reason", Json.str(d.reason().token),
                    "strikes", Json.num(d.strikes()), "stickyLegacyBuild", JsArgs.stringOrNull(d.stickyLegacyBuild()),
                    "writeSentinel", Json.bool(d.writeSentinel())));
        });
        calls.put("engineModeTrace", args -> {
            Json stored = arg(args, 0);
            EngineMode.Stored initial = new EngineMode.Stored(
                    EngineMode.ModeOverride.stored(at(stored, "override").asString()),
                    strikes(at(stored, "strikes")),
                    JsArgs.isTrue(at(stored, "sentinel")),
                    at(stored, "stickyLegacyBuild").asString());
            // `if (!Array.isArray(events)) throw new TypeError(...)`, then each event in order.
            List<Json> raw = arg(args, 1).asList();
            if (raw == null) return new Threw("TypeError");
            List<EngineMode.Event> typed = new ArrayList<>();
            for (Json e : raw) {
                String kindText = at(e, "kind").asString();
                EngineMode.EventKind kind = kindText == null ? null : EngineMode.EventKind.of(kindText);
                if (kind == null) return new Threw("RangeError");
                switch (kind) {
                    case LAUNCH -> typed.add(new EngineMode.Event.Launch(buildDefault(at(e, "buildDefault")),
                            at(e, "currentBuild").asString(), JsArgs.isTrue(at(e, "built"))));
                    case HEALTHY -> typed.add(new EngineMode.Event.Healthy());
                    case PAGE_HEALTH -> typed.add(new EngineMode.Event.PageHealth());
                    case SET_OVERRIDE -> {
                        String modeText = at(e, "mode").asString();
                        EngineMode.ModeOverride mode = modeText == null ? null : EngineMode.ModeOverride.of(modeText);
                        // The JS throws when it reaches this event: the ones before it are not returned.
                        if (mode == null) return new Threw("RangeError");
                        typed.add(new EngineMode.Event.SetOverride(mode));
                    }
                }
            }
            List<Json> out = new ArrayList<>();
            for (EngineMode.Step step : tracer.apply(initial, typed)) {
                EngineMode.Stored s = step.stored();
                out.add(obj("kind", Json.str(step.kind().token),
                        "mode", step.mode() == null ? Json.NULL : Json.str(step.mode().token),
                        "reason", step.reason() == null ? Json.NULL : Json.str(step.reason().token),
                        "override", Json.str(s.modeOverride().token),
                        "strikes", Json.num(s.strikes()),
                        "sentinel", Json.bool(s.sentinel()),
                        "stickyLegacyBuild", JsArgs.stringOrNull(s.stickyLegacyBuild())));
            }
            return new Returned(new Json.Arr(out));
        });
        return new FamilyRunner.Pure("engine-mode", SessionFamily.MODULE, reads, calls);
    }

    /** {@code i.buildDefault === "native"} / {@code === "js"}; anything else is no decision (no-plist-key). */
    private static EngineMode.BuildDefault buildDefault(Json value) {
        String text = value.asString();
        return text == null ? null : EngineMode.BuildDefault.of(text);
    }

    /**
     * {@code Number.isInteger(strikes) && strikes > 0 ? strikes : 0}. A whole number too large for
     * an int has no JVM spelling: the case fails rather than being answered with a guess.
     */
    static int strikes(Json value) {
        Double n = value.asNumber();
        if (n == null || n.isNaN() || n.isInfinite() || Math.floor(n) != n || n <= 0) return 0;
        if (n > Integer.MAX_VALUE - 1) throw JsArgs.notRepresentable("a strike count", value);
        return n.intValue();
    }
}

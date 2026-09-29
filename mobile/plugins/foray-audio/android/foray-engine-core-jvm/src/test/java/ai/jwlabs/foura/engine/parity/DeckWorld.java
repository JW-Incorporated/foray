package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.DeckPolicy;
import ai.jwlabs.foura.engine.DeckPolicy.OutPointEvent;
import ai.jwlabs.foura.engine.DeckPolicy.OutPointLayer;
import ai.jwlabs.foura.engine.DeckPolicy.OutPointOp;
import ai.jwlabs.foura.engine.JSMath;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * runner.js {@code runDeckScenario}: {@link DeckPolicy#outPointStep} over a DRIVEN CLOCK, the
 * JVM twin of the Swift {@code DeckWorld} (ForayEngineParity/Families/OutpointFamily.swift),
 * line for line. The {@code outpoint} family's {@code outpoint-watch.json} and the
 * {@code deck} family's {@code deck-slices.json} are both its scenarios ({@code setup.target:
 * "deck"}).
 *
 * <p>It owns the wall clock and the playhead (kept in whole ms of content, so a long clock
 * accumulates no floating-point error), moves the playhead by {@code elapsed x rate} while the
 * deck plays and is not stalled, and delivers the watchdog's one timer at the moment it comes
 * due, with the playhead where it really is by then. The op log is the reducer's ops, in
 * order; nothing else writes to it.
 */
final class DeckWorld {
    static final List<String> EVENTS = java.util.Arrays.asList("load", "play", "pause", "seek", "rate", "stall", "unstall",
            "endTime", "boundary", "ended");

    DeckPolicy.OutPointWatch state = new DeckPolicy.OutPointWatch();
    double nowMs = 0;
    double atMs = 0;
    boolean stalled = false;
    int loads = 0;
    final List<String> log = new ArrayList<>();
    final List<Json> checkpoints = new ArrayList<>();
    int mark = 0;

    double atSec() {
        return atMs / 1000;
    }

    /** {@code toMs(sec)}: whole ms of content. */
    static double toMs(double sec) {
        return JSMath.round(sec * 1000);
    }

    /** runner.js {@code runDeckScenario}: the steps over a fresh world, then {@code end}. */
    static Json run(FixtureCase testCase, Codec.Context context, String family) {
        Json rawSetup = testCase.raw().get("setup");
        Json rawSteps = testCase.raw().get("steps");
        if (rawSetup == null || rawSteps == null || rawSteps.asList() == null) {
            throw new HarnessError("E_BAD_CASE", "case " + testCase.id() + " is not a scenario");
        }
        Json setup = Codec.expandInputs(rawSetup, context);
        if (!"deck".equals(JsArgs.at(setup, "target").asString())) {
            throw new HarnessError("E_SCENARIO_TARGET", "the JVM " + family + " family drives the deck target only, not "
                    + Json.show(Codec.encode(JsArgs.at(setup, "target"))));
        }
        DeckWorld world = new DeckWorld();
        Json setupRate = JsArgs.at(setup, "rate");
        if (!JsArgs.isUndefined(setupRate)) world.dispatch(new OutPointEvent.Rate(setupRate.asNumber(), world.atSec(), world.nowMs));
        List<Json> steps = rawSteps.asList();
        for (int index = 0; index < steps.size(); index++) {
            Json rawStep = steps.get(index);
            if (!(rawStep instanceof Json.Obj o)) {
                throw new HarnessError("E_BAD_CASE", "step " + index + " of " + testCase.id() + " is not an object");
            }
            List<String> verbs = new ArrayList<>();
            for (String key : o.fields().keySet()) if (EngineScenarioDriver.World.VERBS.contains(key)) verbs.add(key);
            if (verbs.size() != 1) {
                throw new HarnessError("E_UNKNOWN_VERB", "step " + index + " of " + testCase.id() + " has no single known verb");
            }
            switch (verbs.get(0)) {
                case "deck" -> world.deck(rawStep, testCase.id());
                case "clock" -> world.clock(JsArgs.at(rawStep, "clock"));
                case "checkpoint" -> {
                    String name = JsArgs.at(rawStep, "checkpoint").asString();
                    world.checkpoint(name == null ? "" : name);
                }
                default -> throw new HarnessError("E_BAD_CASE", "the deck target takes deck, clock and checkpoint steps, not \""
                        + verbs.get(0) + "\"");
            }
        }
        world.checkpoint("end");
        Map<String, Json> out = new LinkedHashMap<>();
        out.put("checkpoints", new Json.Arr(world.checkpoints));
        List<Json> ops = new ArrayList<>();
        for (String op : world.log) ops.add(Json.str(op));
        out.put("ops", new Json.Arr(ops));
        return Codec.encode(new Json.Obj(out));
    }

    void dispatch(OutPointEvent event) {
        DeckPolicy.OutPointStep result = DeckPolicy.outPointStep(state, event);
        state = result.state();
        for (OutPointOp op : result.ops()) log.add(op.token());
    }

    void checkpoint(String name) {
        Map<String, Json> fields = new LinkedHashMap<>();
        fields.put("name", Json.str(name));
        List<Json> ops = new ArrayList<>();
        for (String op : log.subList(mark, log.size())) ops.add(Json.str(op));
        fields.put("ops", new Json.Arr(ops));
        fields.put("nowMs", Json.num(nowMs));
        fields.put("atSec", Json.num(atSec()));
        fields.put("armed", Json.bool(state.armed));
        fields.put("fired", Json.bool(state.fired));
        fields.put("playing", Json.bool(state.playing));
        fields.put("rate", Json.num(state.rate));
        checkpoints.add(new Json.Obj(fields));
        mark = log.size();
    }

    void deck(Json step, String caseId) {
        String event = JsArgs.at(step, "deck").asString();
        if (event == null) event = "";
        Json sec = JsArgs.at(step, "sec");
        switch (event) {
            case "load" -> {
                loads += 1;
                // `toMs(step.sec ?? 0)`; `step.outPointSec ?? null`, then the reducer's own `typeof` check.
                atMs = toMs(JsArgs.isNullish(sec) ? 0 : JsArgs.toNumber(sec));
                dispatch(new OutPointEvent.Load(loads, JsArgs.at(step, "outPointSec").asNumber(), atSec()));
            }
            case "play" -> dispatch(new OutPointEvent.Play(atSec(), nowMs));
            case "pause" -> dispatch(new OutPointEvent.Pause(atSec()));
            case "seek" -> {
                Double to = sec.asNumber();
                if (to == null) throw new HarnessError("E_BAD_CASE", "deck seek needs a numeric sec");
                atMs = toMs(to);
                dispatch(new OutPointEvent.Seek(atSec(), nowMs));
            }
            case "rate" -> dispatch(new OutPointEvent.Rate(JsArgs.at(step, "rate").asNumber(), atSec(), nowMs));
            case "stall", "unstall" -> stalled = event.equals("stall");
            case "endTime", "boundary" -> {
                if (loads <= 0) throw new HarnessError("E_BAD_CASE", "a " + event + " report with nothing loaded");
                if (!JsArgs.isUndefined(sec)) atMs = toMs(JsArgs.toNumber(sec));
                Json rawToken = JsArgs.at(step, "token");
                int token;
                if (JsArgs.isNullish(rawToken)) {
                    token = loads;
                } else {
                    Double number = rawToken.asNumber();
                    if (number == null || number != Math.rint(number) || !(Math.abs(number) < 1e15)) {
                        throw JsArgs.notRepresentable(caseId + "'s " + event + " token", rawToken);
                    }
                    token = (int) (double) number;
                }
                OutPointLayer layer = event.equals("endTime") ? OutPointLayer.END_TIME : OutPointLayer.BOUNDARY;
                dispatch(new OutPointEvent.Layer(layer, token, atSec(), nowMs));
            }
            case "ended" -> {
                // The FILE ran out (an authored end past the real audio).
                if (loads <= 0) throw new HarnessError("E_BAD_CASE", "an end with nothing loaded");
                if (!JsArgs.isUndefined(sec)) atMs = toMs(JsArgs.toNumber(sec));
                dispatch(new OutPointEvent.Ended(atSec()));
            }
            default -> throw new HarnessError("E_BAD_CASE", "unknown deck event \"" + event + "\" (one of " + EVENTS + ")");
        }
    }

    /** {@code clock: ms}: advance the wall clock, delivering the watchdog's timer each time it comes due on the way. */
    void clock(Json value) {
        Double ms = value.asNumber();
        if (ms == null || !JSMath.isInteger(ms) || ms < 0) throw new HarnessError("E_BAD_CASE", "clock takes whole milliseconds");
        double until = nowMs + ms;
        while (true) {
            Double due = state.timerDueMs;
            boolean fires = due != null && due <= until;
            double to = fires ? due : until;
            if (state.playing && !stalled) atMs += JSMath.round((to - nowMs) * state.rate);
            nowMs = to;
            if (fires) {
                dispatch(new OutPointEvent.Timer(atSec(), nowMs));
            } else {
                break;
            }
        }
    }
}

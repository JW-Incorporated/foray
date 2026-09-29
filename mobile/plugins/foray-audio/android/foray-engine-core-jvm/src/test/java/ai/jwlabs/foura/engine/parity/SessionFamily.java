package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.obj;

import ai.jwlabs.foura.engine.SessionPolicy;
import ai.jwlabs.foura.engine.SessionPolicy.HoldPolicy;
import ai.jwlabs.foura.engine.SessionPolicy.Input;
import ai.jwlabs.foura.engine.SessionPolicy.InputKind;
import ai.jwlabs.foura.engine.SessionPolicy.Phase;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code session} and {@code session-invariant} families against {@link SessionPolicy}
 * (A-23), from the JS reference tables in {@code player/engine-contract.js}: the JVM twins
 * of the Swift SessionFamily and SessionInvariantFamily.
 *
 * <p>TRANSLATION ONLY. Each JS function reads its input loosely ({@code input.ok === true},
 * {@code input?.kind}), and the typed port takes the answer: a strict {@code true} is a
 * boolean, a string in a closed set is its enum member, and anything the JS turns into a
 * RangeError or a TypeError is answered with that throw, IN THE ORDER the JS checks
 * (phase, then input kind, then hold policy, and {@code via} only after the terminal
 * {@code relinquished} check).
 *
 * <p>{@code session-invariant} was owed to A-24 in jvm-pending.json; its function lives in
 * the same file as the session table ({@code SessionPolicy.audibleStartViolations}), so it
 * is ported and run here, and A-24 inherits it rather than owing it.
 */
final class SessionFamily {
    private SessionFamily() {}

    static final String MODULE = "player/engine-contract.js";

    /** The session transition under test, as a value (the mutation seam). */
    @FunctionalInterface
    interface Transition {
        SessionPolicy.Transition apply(Phase phase, Input input, HoldPolicy hold);
    }

    static FamilyRunner runner(Transition transition) {
        Map<String, Json> reads = new LinkedHashMap<>();
        List<String> phases = new ArrayList<>();
        for (Phase p : Phase.values()) phases.add(p.token);
        reads.put("SESSION_PHASES", JsArgs.strings(phases));
        List<String> inputs = new ArrayList<>();
        for (InputKind k : InputKind.values()) inputs.add(k.token);
        reads.put("SESSION_INPUTS", JsArgs.strings(inputs));
        List<String> vias = new ArrayList<>();
        for (SessionPolicy.PlayVia v : SessionPolicy.PlayVia.values()) vias.add(v.token);
        reads.put("PLAY_VIAS", JsArgs.strings(vias));
        List<String> actions = new ArrayList<>();
        for (SessionPolicy.Action a : SessionPolicy.Action.values()) actions.add(a.token);
        reads.put("SESSION_ACTIONS", JsArgs.strings(actions));
        List<String> rows = new ArrayList<>();
        for (SessionPolicy.Row r : SessionPolicy.Row.values()) rows.add(r.token);
        reads.put("SESSION_ROWS", JsArgs.strings(rows));
        reads.put("HOLD_POLICY_KINDS", JsArgs.strings(HoldPolicy.KINDS));
        reads.put("DEFAULT_HOLD_POLICY", Json.str(HoldPolicy.DEFAULT.text()));

        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("sessionTransition", args -> sessionTransition(args, transition));
        calls.put("parseHoldPolicy", args -> {
            HoldPolicy policy = HoldPolicy.parse(arg(args, 0).asString());
            if (policy == null) return new Returned(Json.NULL);
            return new Returned(obj("kind", Json.str(policy.kind()),
                    "minutes", policy.isUntil() ? Json.num(policy.minutes()) : Json.NULL));
        });
        calls.put("sessionFailedReason", args -> new Returned(Json.str(SessionPolicy.sessionFailedReason(arg(args, 0).asString()))));
        return new FamilyRunner.Pure("session", MODULE, reads, calls);
    }

    static FamilyRunner runner() {
        return runner(SessionPolicy::transition);
    }

    /** {@code sessionTransition(phase, input, holdPolicy = DEFAULT_HOLD_POLICY)}. */
    static Outcome sessionTransition(List<Json> args, Transition transition) {
        String phaseText = arg(args, 0).asString();
        Phase phase = phaseText == null ? null : Phase.of(phaseText);
        if (phase == null) return new Threw("RangeError");
        // `input?.kind`: a missing or null input has no kind.
        Json input = arg(args, 1);
        String kindText = at(input, "kind").asString();
        InputKind kind = kindText == null ? null : InputKind.of(kindText);
        if (kind == null) return new Threw("RangeError");
        // A default parameter applies to `undefined` only; null is parsed, and refused.
        Json rawHold = arg(args, 2);
        HoldPolicy hold;
        if (JsArgs.isUndefined(rawHold)) {
            hold = HoldPolicy.DEFAULT;
        } else {
            hold = HoldPolicy.parse(rawHold.asString());
            if (hold == null) return new Threw("RangeError");
        }

        Input typed = switch (kind) {
            case USER_PLAY -> {
                String viaText = at(input, "via").asString();
                SessionPolicy.PlayVia via = viaText == null ? null : SessionPolicy.PlayVia.of(viaText);
                if (via == null) {
                    // JS reads `via` AFTER the terminal check, so a relinquished session answers
                    // an unknown via like any other input; its answer does not read the input,
                    // so any play stands in for it.
                    if (phase == Phase.RELINQUISHED) yield new Input.UserPlay(SessionPolicy.PlayVia.TAP);
                    yield null;
                }
                yield new Input.UserPlay(via);
            }
            case SESSION_RESULT -> new Input.SessionResult(JsArgs.isTrue(at(input, "ok")), at(input, "token").asString());
            case HOLD_EXPIRED -> new Input.HoldExpired(JsArgs.isTrue(at(input, "running")));
            case INTERRUPTION_BEGAN -> new Input.InterruptionBegan(SessionPolicy.interruptionReason(at(input, "reason").asString()),
                    JsArgs.isTrue(at(input, "running")), JsArgs.isTrue(at(input, "activatedInProcess")));
            case INTERRUPTION_ENDED -> new Input.InterruptionEnded(JsArgs.isTrue(at(input, "shouldResume")),
                    JsArgs.isTrue(at(input, "wasPlaying")));
            default -> new Input.Simple(kind);
        };
        if (typed == null) return new Threw("RangeError");
        return encode(transition.apply(phase, typed, hold));
    }

    /** {@code {phase, actions, row, reason}}; an absent row or reason is null. */
    static Outcome encode(SessionPolicy.Transition t) {
        List<String> actions = new ArrayList<>();
        for (SessionPolicy.Action a : t.actions()) actions.add(a.token);
        return new Returned(obj("phase", Json.str(t.phase().token), "actions", JsArgs.strings(actions),
                "row", t.row() == null ? Json.NULL : Json.str(t.row().token), "reason", JsArgs.stringOrNull(t.reason())));
    }

    // ---- session-invariant

    /** The invariant checker under test, as a value (the mutation seam). */
    @FunctionalInterface
    interface Checker {
        List<SessionPolicy.Violation> apply(Phase sessionAtEntry, List<String> turn);
    }

    static FamilyRunner invariantRunner(Checker checker) {
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("audibleStartViolations", args -> {
            // Phase first (RangeError), then the turn's shape (TypeError), as the JS checks.
            String phaseText = arg(args, 0).asString();
            Phase phase = phaseText == null ? null : Phase.of(phaseText);
            if (phase == null) return new Threw("RangeError");
            List<Json> items = arg(args, 1).asList();
            if (items == null) return new Threw("TypeError");
            List<String> turn = new ArrayList<>();
            for (Json item : items) {
                if (item.asString() == null) return new Threw("TypeError");
                turn.add(item.asString());
            }
            List<Json> out = new ArrayList<>();
            for (SessionPolicy.Violation v : checker.apply(phase, turn)) out.add(obj("at", Json.num(v.at()), "cmd", Json.str(v.cmd())));
            return new Returned(new Json.Arr(out));
        });
        return new FamilyRunner.Pure("session-invariant", MODULE,
                Map.of("AUDIBLE_COMMANDS", JsArgs.strings(SessionPolicy.AUDIBLE_COMMANDS)), calls);
    }

    static FamilyRunner invariantRunner() {
        return invariantRunner(SessionPolicy::audibleStartViolations);
    }
}

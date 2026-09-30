package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.obj;

import ai.jwlabs.foura.engine.ContractDecoding;
import ai.jwlabs.foura.engine.EngineConstants;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.SessionPolicy;
import ai.jwlabs.foura.engine.TokenAdmission;
import ai.jwlabs.foura.engine.Vocabulary;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code contract}, {@code snapshot}, {@code handshake} and {@code diag-tokens} families
 * (card A-28) against {@link ContractDecoding}, {@link EngineContract} and
 * {@link TokenAdmission}: the JVM twins of the Swift ContractFamily, SnapshotFamily,
 * HandshakeFamily and DiagTokensFamily.
 *
 * <p>{@code contractAccepts(kind, payload)} is answered by DECODING the payload as the bridge
 * will, not by a second schema interpreter: the families exist so the engine's decoding and the
 * page's validator give the same accept / refuse answer to every example in the schema. The
 * payload reaches the decoder as the ordered {@link JsonNode} the bridge hands it
 * ({@link RowsFamily#node}: an {@code undefined} member is absent, as JSON has it).
 *
 * <p>TRANSLATION ONLY: each mapping below is the JS parameter list it stands for (see
 * {@link JsArgs}), and every decision is the port's.
 */
final class ContractFamilies {
    private ContractFamilies() {}

    static final String CONTRACT_MODULE = "player/engine-contract.js";
    static final String VOCABULARY_MODULE = "player/engine-vocabulary.js";

    /**
     * {@code contractAccepts(kind, payload)}: a kind outside CONTRACT_KINDS is a RangeError (a
     * bug in the caller, not a bad payload).
     */
    static Outcome contractAccepts(List<Json> args) {
        String kind = arg(args, 0).asString();
        if (kind == null || !EngineContract.CONTRACT_KINDS.contains(kind)) return new Threw("RangeError");
        return new Returned(Json.bool(ContractDecoding.accepts(kind, RowsFamily.node(arg(args, 1)))));
    }

    static FamilyRunner contract() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("BRIDGE_METHODS", JsArgs.strings(EngineContract.BRIDGE_METHODS));
        reads.put("COMMANDS", JsArgs.strings(EngineContract.COMMANDS));
        reads.put("EVENTS", JsArgs.strings(EngineContract.EVENTS));
        List<String> refusals = new ArrayList<>();
        for (EngineContract.Refusal r : EngineContract.Refusal.values()) refusals.add(r.token);
        reads.put("REFUSALS", JsArgs.strings(refusals));
        reads.put("READ_KINDS", JsArgs.strings(EngineContract.READ_KINDS));
        reads.put("CAPABILITIES", JsArgs.strings(EngineContract.CAPABILITIES));
        List<String> caps = new ArrayList<>();
        for (EngineContract.RelinquishCap c : EngineContract.RelinquishCap.values()) caps.add(c.token);
        reads.put("RELINQUISH_CAPS", JsArgs.strings(caps));
        reads.put("OWNED_PREFIXES", JsArgs.strings(EngineContract.OWNED_PREFIXES));
        reads.put("CONTRACT_KINDS", JsArgs.strings(EngineContract.CONTRACT_KINDS));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("contractAccepts", ContractFamilies::contractAccepts);
        return new FamilyRunner.Pure("contract", CONTRACT_MODULE, reads, calls);
    }

    /** The schema's snapshot examples as {@code contractAccepts}, and {@code extrapolate}. */
    static FamilyRunner snapshot() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("SNAPSHOT_MODES", JsArgs.strings(EngineContract.SNAPSHOT_MODES));
        reads.put("PLAYER_STATES", JsArgs.strings(EngineContract.PLAYER_STATES));
        List<String> phases = new ArrayList<>();
        for (SessionPolicy.Phase p : SessionPolicy.Phase.values()) phases.add(p.token);
        reads.put("SESSION_PHASES", JsArgs.strings(phases));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("contractAccepts", ContractFamilies::contractAccepts);
        calls.put("extrapolate", args -> {
            // `snapshot?.<field>`: every read of a non-object is undefined. Numbers by `typeof`
            // (the port checks finiteness), flags by `=== true`.
            Json s = arg(args, 0);
            return new Returned(Json.num(EngineContract.extrapolate(
                    at(s, "positionSec").asNumber(),
                    at(s, "durationSec").asNumber(),
                    Json.TRUE.equals(at(s, "inSeamGap")),
                    Json.TRUE.equals(at(s, "buffering")),
                    Json.TRUE.equals(at(s, "running")),
                    at(s, "effectiveRate").asNumber(),
                    arg(args, 1).asNumber(),
                    arg(args, 2).asNumber())));
        });
        return new FamilyRunner.Pure("snapshot", CONTRACT_MODULE, reads, calls);
    }

    /** {@code helloRequest} and the page's {@code decideMode}. */
    static FamilyRunner handshake() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("PROTOCOL", Json.num(EngineContract.PROTOCOL_VERSION));
        reads.put("PAGE_MODES", JsArgs.strings(EngineContract.PAGE_MODES));
        reads.put("ENGINE_MODES", JsArgs.strings(EngineContract.ENGINE_MODES));
        reads.put("HANDSHAKE_REASONS", JsArgs.strings(EngineContract.HANDSHAKE_REASONS));
        reads.put("ENGINE_PLATFORMS", JsArgs.strings(EngineConstants.EngineContract.ENGINE_PLATFORMS));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("helloRequest", args -> {
            // `typeof pageBuild === "string" ? pageBuild : ""`.
            JsonNode request = EngineContract.helloRequest(arg(args, 0).asString());
            return new Returned(obj("pageBuild", Json.str(request.get("pageBuild").stringValue()),
                    "protocol", Json.num(request.get("protocol").numberValue())));
        });
        calls.put("decideMode", args -> {
            // `!ENGINE_PLATFORMS.includes(input?.platform)`, `input.methodPresent !== true`,
            // and a hello of null or undefined is no answer at all.
            Json input = arg(args, 0);
            Json hello = at(input, "hello");
            EngineContract.PageDecision d = EngineContract.decidePageMode(
                    at(input, "platform").asString(),
                    Json.TRUE.equals(at(input, "methodPresent")),
                    JsArgs.isNullish(hello) ? null : RowsFamily.node(hello));
            return new Returned(obj("mode", Json.str(d.mode()), "reason", Json.str(d.reason()),
                    "relinquish", Json.bool(d.relinquish())));
        });
        return new FamilyRunner.Pure("handshake", CONTRACT_MODULE, reads, calls);
    }

    /**
     * {@code diag-tokens}: the seven closed sets as the generator wrote them, read from the
     * ENUMS a Java emitter spells a token through (their declaration order is what has to match
     * the JS array), and {@code admitToken} against {@link TokenAdmission#admit}. A non-string
     * set or token is null here, and the port decides what null means.
     */
    static FamilyRunner diagTokens() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("VOCABULARY_SETS", JsArgs.strings(Vocabulary.SET_NAMES));
        reads.put("STAGES", tokens(Vocabulary.Stage.values()));
        reads.put("SESSION_ERRORS", tokens(Vocabulary.SessionError.values()));
        reads.put("INTERRUPTION_REASONS", tokens(Vocabulary.InterruptionReason.values()));
        reads.put("STOP_CAUSES", tokens(Vocabulary.StopCause.values()));
        reads.put("SOURCES", tokens(Vocabulary.Source.values()));
        reads.put("MODE_REASONS", tokens(Vocabulary.ModeReason.values()));
        reads.put("FAULT_KINDS", tokens(Vocabulary.FaultKind.values()));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("admitToken", args -> {
            String set = arg(args, 0).asString();
            String token = arg(args, 1).asString();
            try {
                String admitted = TokenAdmission.admit(token, set);
                return new Returned(admitted == null ? Json.NULL : Json.str(admitted));
            } catch (TokenAdmission.UnknownSet e) {
                return new Threw("RangeError");
            }
        });
        return new FamilyRunner.Pure("diag-tokens", VOCABULARY_MODULE, reads, calls);
    }

    /** An enum's tokens, in declaration order (each generated enum has a public {@code token}). */
    private static Json tokens(Enum<?>[] values) {
        List<String> out = new ArrayList<>();
        for (Enum<?> v : values) {
            try {
                out.add((String) v.getClass().getField("token").get(v));
            } catch (ReflectiveOperationException e) {
                throw new HarnessError("E_BAD_CASE", v.getClass().getSimpleName() + " has no token field");
            }
        }
        return JsArgs.strings(out);
    }
}

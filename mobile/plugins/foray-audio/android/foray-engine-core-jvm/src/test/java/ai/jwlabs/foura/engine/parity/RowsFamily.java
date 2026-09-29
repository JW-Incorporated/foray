package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.obj;

import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Rows;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code rows} family against {@link Rows} (A-23), from the fixtures recorded through
 * the page's real writers (player/parity/rows.js): the JVM twin of the Swift RowsFamily.
 * THE BYTE-IDENTICAL CHECK: each case's result is what the recording Storage saw,
 * {@code [{key, value}]} (or {@code []} for a refused write), and {@code value} is the
 * whole row as a STRING, so the comparator compares the bytes of the row the JS writer
 * wrote with the bytes {@link ai.jwlabs.foura.engine.JSWriter} wrote, not two re-sorted
 * objects.
 *
 * <p>TRANSLATION, NEVER DECISION. Every mapping is one JS read:
 * <pre>
 *   seconds, elapsedSec, ...   a number is a number; anything else is null
 *   title, segmentId, ...      a string is a string; anything else is null
 *   meta = {}                  absent meta reads as {}; a NULL meta throws, but only
 *                              past the gate, because meta.duration is read after it
 *   new Date(nowMs)            toISOString() throws a RangeError for a time a Date
 *                              cannot hold: cp_pos BEFORE its gate (the stamp is an
 *                              argument of positionRow), cp_foray and cp_last_episode AFTER
 * </pre>
 */
final class RowsFamily {
    private RowsFamily() {}

    static final String ROWS_MODULE = JvmFamilies.ROWS_MODULE;
    static final String CONTRACT_MODULE = "player/engine-contract.js";

    static FamilyRunner runner() {
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("cpPosRow", RowsFamily::cpPosRow);
        calls.put("cpForayRow", RowsFamily::cpForayRow);
        calls.put("cpLastEpisodeRow", RowsFamily::cpLastEpisodeRow);
        // The family spans two modules: the rows' adapters, and OWNED_PREFIXES from engine-contract.js.
        return new FamilyRunner.MultiModule("rows", List.of(
                new FamilyRunner.Pure("rows", ROWS_MODULE, Map.of(), calls),
                new FamilyRunner.Pure("rows", CONTRACT_MODULE, Map.of("OWNED_PREFIXES", JsArgs.strings(Rows.OWNED_PREFIXES)), Map.of())));
    }

    static Outcome cpPosRow(List<Json> args) {
        String updatedAt = timestamp(arg(args, 3));
        if (updatedAt == null) return new Threw("RangeError");
        String episodeId = id(arg(args, 0));
        Json meta = arg(args, 2);
        Rows.StoredRow row = Rows.position(episodeId, arg(args, 1).asNumber(), at(meta, "duration").asNumber(), updatedAt);
        if (row != null && JsArgs.isNull(meta)) return new Threw("TypeError");
        return new Returned(writes(row));
    }

    static Outcome cpForayRow(List<Json> args) {
        // `{...progress}`: spreading null or undefined gives {}, whose members all read as undefined.
        Json p = arg(args, 0);
        String stamp = timestamp(arg(args, 1));
        Rows.ForayProgressInput input = new Rows.ForayProgressInput(at(p, "forayId").asString(), at(p, "title").asString(),
                at(p, "elapsedSec").asNumber(), at(p, "totalSec").asNumber(), at(p, "index").asNumber(),
                at(p, "segmentId").asString(), at(p, "intoSec").asNumber());
        Rows.StoredRow row = Rows.forayProgress(input, stamp == null ? "" : stamp);
        if (row != null && stamp == null) return new Threw("RangeError");
        return new Returned(writes(row));
    }

    static Outcome cpLastEpisodeRow(List<Json> args) {
        String stamp = timestamp(arg(args, 1));
        Rows.StoredRow row = Rows.lastEpisode(node(arg(args, 0)), stamp == null ? "" : stamp);
        if (row != null && stamp == null) return new Threw("RangeError");
        return new Returned(writes(row));
    }

    /**
     * {@code new Date(nowMs).toISOString()}: null where it throws. Every recorded case
     * passes epoch milliseconds; anything else is a case this runner cannot translate.
     */
    static String timestamp(Json value) {
        Double ms = value.asNumber();
        if (ms == null) throw new HarnessError("E_BAD_CASE", "nowMs must be epoch milliseconds, got " + Json.show(Codec.encode(value)));
        return Rows.timestamp(ms);
    }

    /**
     * An episode id. Every FALSY id is refused by {@code !id}, as the empty string is, so
     * they all translate to "". A truthy non-string id has no spelling in the typed port.
     */
    static String id(Json value) {
        if (value.asString() != null) return value.asString();
        if (!JsArgs.truthy(value)) return "";
        throw new HarnessError("E_BAD_CASE", "a non-string episode id " + Json.show(Codec.encode(value)) + " has no JVM spelling");
    }

    /**
     * A JS value as the JSON {@code JSON.stringify} would write of it: an {@code undefined}
     * member is absent, an {@code undefined} array element is null. Members keep the
     * fixture's (the JS object's) order, which is the order JS would write them in.
     */
    static JsonNode node(Json value) {
        return switch (value) {
            case Json.Undefined u -> JsonNode.NULL;
            case Json.Null n -> JsonNode.NULL;
            case Json.Bool b -> JsonNode.bool(b.value());
            case Json.Num n -> JsonNode.num(n.value());
            case Json.Str s -> JsonNode.str(s.value());
            case Json.Arr a -> {
                List<JsonNode> items = new ArrayList<>();
                for (Json item : a.items()) items.add(node(item));
                yield new JsonNode.Arr(items);
            }
            case Json.Obj o -> {
                List<JsonNode.Member> members = new ArrayList<>();
                for (Map.Entry<String, Json> e : o.fields().entrySet()) {
                    if (!(e.getValue() instanceof Json.Undefined)) members.add(JsonNode.member(e.getKey(), node(e.getValue())));
                }
                yield new JsonNode.Obj(members);
            }
        };
    }

    /** What the recording Storage saw. */
    static Json writes(Rows.StoredRow row) {
        if (row == null) return new Json.Arr(List.of());
        return new Json.Arr(List.of(obj("key", Json.str(row.key()), "value", Json.str(row.value()))));
    }
}

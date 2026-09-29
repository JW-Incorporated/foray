package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The shared rows (docs/native-engine-plan.md §4.6): the three {@code CapacitorStorage.}
 * rows the native engine and the page BOTH write. The JVM twin of {@code Rows} in
 * ForayEngineCore (Persist/Rows.swift, NE-10s); card A-23 of
 * docs/plans/android-assessment.md.
 *
 * <pre>
 *   cp_pos:&lt;id&gt;       player/position-store.js  positionRow + makePositionRecord
 *   cp_foray:&lt;id&gt;     player/foray-progress.js  ForayProgressStore.save + makeProgress
 *   cp_last_episode   player/episode-progress.js makeLastEpisode (+ updated_at)
 * </pre>
 *
 * "Positions survive switching engines" only if a row the engine wrote is, BYTE FOR
 * BYTE, the row the page would have written: the page reads it back with its own
 * parser, DurableStore's {@code isNewer} orders it by its {@code updated_at}, and the
 * page may re-save it unchanged. So every builder here is its JS function line for
 * line, in the same field order, printed through {@link JSWriter}, and the {@code rows}
 * parity family (recorded from the real JS writers) compares the recorded bytes.
 *
 * <p>JS is the reference: a change to a row is a JS change, a re-record, then this
 * file. The time a row is stamped with is the caller's ({@link #timestamp}): the core
 * never reads a clock.
 */
public final class Rows {
    private Rows() {}

    /** One write to storage: the key and the exact string {@code setItem} receives. */
    public record StoredRow(String key, String value) {}

    // ---- keys

    /** The rows the engine owns ({@code player/engine-contract.js} OWNED_PREFIXES, generated). */
    public static final List<String> OWNED_PREFIXES = EngineConstants.EngineContract.OWNED_PREFIXES;

    /**
     * {@code positionKey(id)}'s prefix. position-store.js exports the function, not the
     * prefix, so it is spelled once here and pinned by every recorded cp_pos case's key.
     */
    public static final String POSITION_PREFIX = "cp_pos:";

    public static String positionKey(String id) {
        return POSITION_PREFIX + id;
    }

    /** {@code progressKey(forayId)}. */
    public static String forayKey(String forayId) {
        return EngineConstants.ForayProgress.KEY_PREFIX + forayId;
    }

    /** episode-progress.js {@code KEY}. */
    public static final String LAST_EPISODE_KEY = EngineConstants.EpisodeProgress.KEY;

    /** The {@code updated_at} every row carries: {@code new Date(epochMs).toISOString()}; null where JS throws. */
    public static String timestamp(double epochMs) {
        return JSWriter.isoString(epochMs);
    }

    // ---- cp_pos:<id>

    /**
     * {@code PositionStore.save(id, seconds, {duration})}'s write, or null where it writes
     * nothing. positionRow's gate: {@code !id || typeof seconds !== "number" ||
     * !Number.isFinite(seconds) || seconds < 0} refuses ({@code seconds} null is "not a
     * number"). Then makePositionRecord's four fields in its order; a duration that is not
     * a finite number is {@code null}. {@code -0} passes the gate and prints as {@code 0}.
     */
    public static StoredRow position(String id, Double seconds, Double duration, String updatedAt) {
        if (id == null || id.isEmpty() || seconds == null || !isFinite(seconds) || seconds < 0) return null;
        JsonNode row = new JsonNode.Obj(Arrays.asList(
                JsonNode.member("seconds", JsonNode.num(seconds)),
                JsonNode.member("duration", finiteOrNull(duration)),
                JsonNode.member("updated_at", JsonNode.str(updatedAt)),
                JsonNode.member("source", JsonNode.str("local"))));
        return new StoredRow(positionKey(id), JSWriter.stringify(row));
    }

    /** A {@code cp_pos} row as {@code PositionStore.load} accepts it. {@code duration} is null when not a number. */
    public record PositionRecord(double seconds, Double duration, String updatedAt) {}

    /** {@code PositionStore.load}: nothing for an empty or unparseable value, or one whose {@code seconds} is not finite. */
    public static PositionRecord readPosition(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        JsonNode row = JsonNode.tryParse(raw);
        Double seconds = row == null ? null : numberOf(row.get("seconds"));
        if (seconds == null || !isFinite(seconds)) return null;
        return new PositionRecord(seconds, numberOf(row.get("duration")), stringOf(row.get("updated_at")));
    }

    // ---- cp_foray:<id>

    /**
     * What {@code ForayProgressStore.save(p)} is handed, typed. Every field is null where
     * the JS value is absent OR of the wrong type: each JS default and each type check
     * lands on the same answer for both.
     */
    public record ForayProgressInput(String forayId, String title, Double elapsedSec, Double totalSec, Double index,
                                     String segmentId, Double intoSec) {}

    /**
     * {@code ForayProgressStore.save({...p, force: true})}'s write, or null where it writes
     * nothing: a blank {@code forayId}, a non-finite {@code elapsedSec}, or a
     * {@code totalSec} that is not a finite number above 0 refuses.
     */
    public static StoredRow forayProgress(ForayProgressInput p, String updatedAt) {
        if (p.forayId() == null || !nonEmpty(p.forayId())) return null;
        if (p.elapsedSec() == null || !isFinite(p.elapsedSec())) return null;
        if (p.totalSec() == null || !isFinite(p.totalSec()) || !(p.totalSec() > 0)) return null;
        return new StoredRow(forayKey(p.forayId()), JSWriter.stringify(makeForayProgress(p, updatedAt)));
    }

    /**
     * {@code makeProgress(p)}: the stored shape, with NO gate. A blank title is "", a clock
     * that is not a finite number above 0 is 0, an index that is not a non-negative
     * integer is -1, a blank segment id is null (not absent), an offset that is not a
     * finite number above 0 is 0. A null {@code forayId} is the JS {@code undefined},
     * which the row then does not carry.
     */
    public static JsonNode makeForayProgress(ForayProgressInput p, String updatedAt) {
        double index = (p.index() != null && JSMath.isInteger(p.index()) && p.index() >= 0) ? p.index() : -1;
        String title = (p.title() != null && nonEmpty(p.title())) ? p.title() : "";
        JsonNode segment = (p.segmentId() != null && nonEmpty(p.segmentId())) ? JsonNode.str(p.segmentId()) : JsonNode.NULL;
        double into = (p.intoSec() != null && isFinite(p.intoSec()) && p.intoSec() > 0) ? p.intoSec() : 0;
        List<JsonNode.Member> members = new ArrayList<>();
        if (p.forayId() != null) members.add(JsonNode.member("foray_id", JsonNode.str(p.forayId())));
        members.add(JsonNode.member("title", JsonNode.str(title)));
        members.add(JsonNode.member("elapsed_sec", JsonNode.num(clampNum(p.elapsedSec() == null ? Double.NaN : p.elapsedSec()))));
        members.add(JsonNode.member("total_sec", JsonNode.num(clampNum(p.totalSec() == null ? Double.NaN : p.totalSec()))));
        members.add(JsonNode.member("index", JsonNode.num(index)));
        members.add(JsonNode.member("segment_id", segment));
        members.add(JsonNode.member("into_sec", JsonNode.num(into)));
        members.add(JsonNode.member("updated_at", JsonNode.str(updatedAt)));
        return new JsonNode.Obj(members);
    }

    /** A {@code cp_foray} row as {@code readProgress} accepts it ({@code isProgressRecord}). */
    public record ForayProgressRecord(String forayId, String title, double elapsedSec, double totalSec, Double index,
                                      String segmentId, Double intoSec, String updatedAt) {}

    /**
     * {@code readProgress}: a row names a Foray and carries a finite clock, or it is no
     * row. {@code segment_id} and {@code into_sec} are NOT required: rows written before
     * they existed are still resume points.
     */
    public static ForayProgressRecord readForayProgress(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        JsonNode row = JsonNode.tryParse(raw);
        if (row == null || row.members() == null) return null;
        String forayId = stringOf(row.get("foray_id"));
        Double elapsed = numberOf(row.get("elapsed_sec"));
        Double total = numberOf(row.get("total_sec"));
        if (forayId == null || !nonEmpty(forayId)) return null;
        if (elapsed == null || !isFinite(elapsed) || elapsed < 0) return null;
        if (total == null || !isFinite(total) || !(total > 0)) return null;
        return new ForayProgressRecord(forayId, stringOf(row.get("title")), elapsed, total, numberOf(row.get("index")),
                stringOf(row.get("segment_id")), numberOf(row.get("into_sec")), stringOf(row.get("updated_at")));
    }

    // ---- cp_last_episode

    /**
     * episode-progress.js {@code SNAPSHOT_FIELDS}, in its order: the row's order. A
     * private const there, so spelled here and pinned by
     * {@code rows/cp-last-episode-snapshot-order-and-extras-dropped}.
     */
    public static final List<String> LAST_EPISODE_SNAPSHOT_FIELDS = Collections.unmodifiableList(Arrays.asList(
            "id", "title", "show", "artwork_url", "audio_url", "duration_min", "duration_sec"));

    /**
     * {@code writeLastEpisode(storage, makeLastEpisode(item))}, as client.js pairs them:
     * null for no item or an item with a falsy id (a null pointer would CLEAR the row, and
     * playing an id-less item must not). A field is kept unless it is absent or null
     * ({@code ""} and {@code 0} stay), written as given; then the stamp is appended. The
     * rule is idempotent, so running the page's own row back through it is verbatim, and
     * it restores the SNAPSHOT_FIELDS order a bridge map loses.
     */
    public static StoredRow lastEpisode(JsonNode item, String updatedAt) {
        if (item == null || !item.isTruthy()) return null;
        JsonNode id = item.get("id");
        if (id == null || !id.isTruthy()) return null;
        List<JsonNode.Member> members = new ArrayList<>();
        for (String field : LAST_EPISODE_SNAPSHOT_FIELDS) {
            JsonNode value = item.get(field);
            if (value != null && !(value instanceof JsonNode.Null)) members.add(JsonNode.member(field, value));
        }
        members.add(JsonNode.member("updated_at", JsonNode.str(updatedAt)));
        return new StoredRow(LAST_EPISODE_KEY, JSWriter.stringify(new JsonNode.Obj(members)));
    }

    /** {@code readLastEpisode}: an object with a truthy {@code id}, or nothing. */
    public static JsonNode readLastEpisode(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        JsonNode row = JsonNode.tryParse(raw);
        if (row == null || row.members() == null) return null;
        JsonNode id = row.get("id");
        return id != null && id.isTruthy() ? row : null;
    }

    // ---- ordering (durable-store.js isNewer)

    /**
     * durable-store.js {@code stampOf}: the first of {@code updated_at}, {@code updatedAt},
     * {@code ts} that {@code Date.parse} reads, in epoch ms; null for a value that does not
     * parse or carries none. Only a STRING field is read as a stamp.
     */
    public static Double stamp(String raw) {
        JsonNode row = JsonNode.tryParse(raw);
        if (row == null || row.members() == null) return null;
        for (String field : new String[] {"updated_at", "updatedAt", "ts"}) {
            String text = stringOf(row.get(field));
            Double time = text == null ? null : JSDate.parse(text);
            if (time != null) return time;
        }
        return null;
    }

    /** durable-store.js {@code isNewer(candidate, mine)}: true only when both carry a stamp and the candidate's is later. */
    public static boolean isNewer(String candidate, String mine) {
        Double a = stamp(candidate);
        Double b = stamp(mine);
        return a != null && b != null && a > b;
    }

    // ---- the JS helpers the builders share

    /** foray-progress.js {@code nonEmpty}: a string with something left after {@code String.prototype.trim}. */
    public static boolean nonEmpty(String text) {
        for (int i = 0; i < text.length(); i++) if (!isJSWhitespace(text.charAt(i))) return true;
        return false;
    }

    /**
     * What {@code trim} strips: ECMAScript WhiteSpace (TAB, VT, FF, SP, NBSP, ZWNBSP and
     * every Zs character) and LineTerminator (LF, CR, LS, PS). The Zs set is spelled out
     * rather than read from {@code Character}, whose Unicode version moves with the JDK
     * while V8's does not.
     */
    public static boolean isJSWhitespace(char c) {
        switch (c) {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                return true;
            default:
                return c >= 0x2000 && c <= 0x200A;
        }
    }

    /** makePositionRecord's {@code typeof duration === "number" && Number.isFinite(duration) ? duration : null}. */
    static JsonNode finiteOrNull(Double value) {
        return value != null && isFinite(value) ? JsonNode.num(value) : JsonNode.NULL;
    }

    /** foray-progress.js {@code clampNum}: a finite number above 0, else 0. */
    static double clampNum(double value) {
        return isFinite(value) && value > 0 ? value : 0;
    }

    static boolean isFinite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    static Double numberOf(JsonNode node) {
        return node == null ? null : node.numberValue();
    }

    static String stringOf(JsonNode node) {
        return node == null ? null : node.stringValue();
    }
}

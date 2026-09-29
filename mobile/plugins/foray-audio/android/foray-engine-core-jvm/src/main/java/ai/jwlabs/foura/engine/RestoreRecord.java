package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The engine-private restore record: what the engine needs to paint Now Playing and
 * answer a car's play after the OS killed the app (docs/native-engine-plan.md §4.5, the
 * cold path). The JVM twin of {@code RestoreRecord} in ForayEngineCore
 * (Persist/Rows.swift); Android's store and playback resumption use it from A-27.
 *
 * <p>{@code {v, mode, queue[], index, offsetSec, forayId?, rate, voiceId?, advanceLog,
 * pendingEvents, updated_at, build}}, stored OUTSIDE {@code CapacitorStorage.} so
 * DurableStore never sees it. Not a shared row, so no JS writer defines its bytes; it is
 * still written through {@link JSWriter} so one serialiser, with one number format,
 * writes everything the engine stores. {@code queue}, {@code advanceLog} and
 * {@code pendingEvents} are kept as the JSON they arrived as.
 */
public record RestoreRecord(Mode mode, List<JsonNode> queue, int index, double offsetSec, String forayId, double rate,
                            String voiceId, List<JsonNode> advanceLog, List<JsonNode> pendingEvents, String updatedAt,
                            String build) {
    public static final double VERSION = 1;

    public enum Mode {
        EPISODE("episode"),
        FORAY("foray"),
        /** Written at a one-way relinquish: a cold play then finds nothing, and the legacy lane owns playback. */
        RELINQUISHED("relinquished");

        public final String token;

        Mode(String token) {
            this.token = token;
        }

        public static Mode of(String token) {
            for (Mode m : values()) if (m.token.equals(token)) return m;
            return null;
        }
    }

    public RestoreRecord {
        queue = Collections.unmodifiableList(new ArrayList<>(queue));
        advanceLog = Collections.unmodifiableList(new ArrayList<>(advanceLog));
        pendingEvents = Collections.unmodifiableList(new ArrayList<>(pendingEvents));
    }

    /** The {@code {mode: "relinquished"}} record: nothing to restore, by design. */
    public static RestoreRecord relinquished(String updatedAt, String build) {
        return new RestoreRecord(Mode.RELINQUISHED, Collections.emptyList(), 0, 0, null, 1, null, Collections.emptyList(),
                Collections.emptyList(), updatedAt, build);
    }

    /**
     * The stored string. A relinquished record carries only {@code v}, {@code mode},
     * {@code updated_at} and {@code build}: a record that kept a queue would invite a
     * later build to restore it.
     */
    public String serialized() {
        List<JsonNode.Member> members = new ArrayList<>();
        members.add(JsonNode.member("v", JsonNode.num(VERSION)));
        members.add(JsonNode.member("mode", JsonNode.str(mode.token)));
        if (mode != Mode.RELINQUISHED) {
            members.add(JsonNode.member("queue", new JsonNode.Arr(queue)));
            members.add(JsonNode.member("index", JsonNode.num(index)));
            members.add(JsonNode.member("offsetSec", JsonNode.num(offsetSec)));
            if (forayId != null) members.add(JsonNode.member("forayId", JsonNode.str(forayId)));
            members.add(JsonNode.member("rate", JsonNode.num(rate)));
            if (voiceId != null) members.add(JsonNode.member("voiceId", JsonNode.str(voiceId)));
            members.add(JsonNode.member("advanceLog", new JsonNode.Arr(advanceLog)));
            members.add(JsonNode.member("pendingEvents", new JsonNode.Arr(pendingEvents)));
        }
        members.add(JsonNode.member("updated_at", JsonNode.str(updatedAt)));
        members.add(JsonNode.member("build", JsonNode.str(build)));
        return JSWriter.stringify(new JsonNode.Obj(members));
    }

    /**
     * Read a stored record back, or null. A record this build cannot trust is NO record,
     * never a guess: another version, an unknown mode, a missing stamp or build, or a queue
     * whose index or offset makes no sense.
     */
    public static RestoreRecord parse(String raw) {
        JsonNode row = JsonNode.tryParse(raw);
        if (row == null || row.members() == null) return null;
        Double v = Rows.numberOf(row.get("v"));
        Mode mode = Mode.of(Rows.stringOf(row.get("mode")));
        String updatedAt = Rows.stringOf(row.get("updated_at"));
        String build = Rows.stringOf(row.get("build"));
        if (v == null || v != VERSION || mode == null || updatedAt == null || build == null) return null;
        if (mode == Mode.RELINQUISHED) return relinquished(updatedAt, build);
        List<JsonNode> queue = row.get("queue") == null ? null : row.get("queue").arrayValue();
        Double index = Rows.numberOf(row.get("index"));
        Double offset = Rows.numberOf(row.get("offsetSec"));
        Double rate = Rows.numberOf(row.get("rate"));
        List<JsonNode> advanceLog = row.get("advanceLog") == null ? null : row.get("advanceLog").arrayValue();
        List<JsonNode> pendingEvents = row.get("pendingEvents") == null ? null : row.get("pendingEvents").arrayValue();
        if (queue == null || index == null || !JSMath.isInteger(index) || index < 0) return null;
        if (queue.isEmpty() ? index != 0 : !(index < queue.size())) return null;
        if (offset == null || !Rows.isFinite(offset) || offset < 0) return null;
        if (rate == null || !Rows.isFinite(rate) || !(rate > 0)) return null;
        if (advanceLog == null || pendingEvents == null) return null;
        String forayId = Rows.stringOf(row.get("forayId"));
        if (mode == Mode.FORAY && forayId == null) return null;
        return new RestoreRecord(mode, queue, index.intValue(), offset, forayId, rate, Rows.stringOf(row.get("voiceId")),
                advanceLog, pendingEvents, updatedAt, build);
    }
}

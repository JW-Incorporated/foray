package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.List;

/**
 * The packed {@code seam} row (plan §13 item 37): one row per real Foray seam, written the moment
 * the item after the seam becomes audible. The JVM twin of {@code SeamRow} in ForayEngineCore
 * (Diag/DiagRow.swift), cards A-40 and A-62, field for field, so a Copy from either platform reads
 * the same.
 *
 * <p>{@code observedGapMs}: from the out-point (or a line's natural end) to the next item landing
 * (the beat included); {@code askedGapMs}: the beat asked for (0 for a seam with a line in it,
 * which gets none); {@code prepared}: the standby deck had the item (the deck pair's own report
 * when it sent one); {@code grace}: a span was open; {@code stages}: what the load went through.
 * This is the row A-05 (f) in native mode measures seams from.
 *
 * <p>A-62 (NE-45s): {@code from}, {@code to} are what the seam joins, {@code clip} or {@code line}
 * (a narration line, rendered or spoken); {@code prepare} is {@code hit} (the standby deck was
 * promoted), {@code miss} (it was prepared and the item still loaded cold) or {@code none}
 * (nothing was prepared: one deck, a spoken line, the same source seeked on the playing deck).
 * All three are absent on a row from before A-62 and on a beat cut short by the listener.
 * engine-report.mjs's {@code seam-kinds} verdict reads the three.
 */
public record SeamRow(Double observedGapMs, double askedGapMs, boolean prepared, boolean grace, Double bgRemainingMs,
                      List<Vocabulary.Stage> stages, ItemKind from, ItemKind to, Prepare prepare) {
    public static final String KIND = "seam";

    /** What a seam joins ({@code from=}, {@code to=}). */
    public enum ItemKind {
        CLIP("clip"),
        LINE("line");

        public final String token;

        ItemKind(String token) {
            this.token = token;
        }

        /** A narration item ({@code kind: "tts"}) is a line, rendered or spoken; anything else is a clip. */
        public static ItemKind of(EngineItem item) {
            return item.kind == PlayerItemKind.TTS ? LINE : CLIP;
        }
    }

    /** Whether the standby deck had the item ready ({@code prepare=}). */
    public enum Prepare {
        HIT("hit"),
        MISS("miss"),
        NONE("none");

        public final String token;

        Prepare(String token) {
            this.token = token;
        }
    }

    /** A row from before A-62: no seam kinds. */
    public SeamRow(Double observedGapMs, double askedGapMs, boolean prepared, boolean grace, Double bgRemainingMs,
                   List<Vocabulary.Stage> stages) {
        this(observedGapMs, askedGapMs, prepared, grace, bgRemainingMs, stages, null, null, null);
    }

    public List<JsonNode.Member> fields() {
        List<JsonNode> stageNodes = new ArrayList<>();
        for (Vocabulary.Stage stage : stages) stageNodes.add(JsonNode.str(stage.token));
        List<JsonNode.Member> out = new ArrayList<>();
        out.add(JsonNode.member("observedGapMs", Rows.finiteOrNull(observedGapMs)));
        out.add(JsonNode.member("askedGapMs", JsonNode.num(askedGapMs)));
        out.add(JsonNode.member("prepared", JsonNode.bool(prepared)));
        out.add(JsonNode.member("grace", JsonNode.bool(grace)));
        out.add(JsonNode.member("bgRemainingMs", Rows.finiteOrNull(bgRemainingMs)));
        out.add(JsonNode.member("stages", new JsonNode.Arr(stageNodes)));
        if (from != null) out.add(JsonNode.member("from", JsonNode.str(from.token)));
        if (to != null) out.add(JsonNode.member("to", JsonNode.str(to.token)));
        if (prepare != null) out.add(JsonNode.member("prepare", JsonNode.str(prepare.token)));
        return out;
    }

    /** The seam as the ring takes it, before it is stamped. */
    public EngineCommand.DiagEntry entry() {
        return new EngineCommand.DiagEntry(KIND, fields());
    }
}

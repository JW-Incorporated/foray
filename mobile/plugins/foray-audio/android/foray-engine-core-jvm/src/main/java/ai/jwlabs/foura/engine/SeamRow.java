package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.List;

/**
 * The packed {@code seam} row (plan §13 item 37): one row per real Foray seam, written the moment
 * the load the beat held becomes audible. The JVM twin of {@code SeamRow} in ForayEngineCore
 * (Diag/DiagRow.swift), card A-40, field for field, so a Copy from either platform reads the same.
 *
 * <p>{@code observedGapMs}: from the out-point to the next item landing (the beat included);
 * {@code askedGapMs}: the beat asked for; {@code prepared}: the standby deck had the item (the deck
 * pair's own report when it sent one); {@code grace}: a span was open; {@code stages}: what the
 * load went through. This is the row A-05 (f) in native mode measures seams from.
 */
public record SeamRow(Double observedGapMs, double askedGapMs, boolean prepared, boolean grace, Double bgRemainingMs,
                      List<Vocabulary.Stage> stages) {
    public static final String KIND = "seam";

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
        return out;
    }

    /** The seam as the ring takes it, before it is stamped. */
    public EngineCommand.DiagEntry entry() {
        return new EngineCommand.DiagEntry(KIND, fields());
    }
}

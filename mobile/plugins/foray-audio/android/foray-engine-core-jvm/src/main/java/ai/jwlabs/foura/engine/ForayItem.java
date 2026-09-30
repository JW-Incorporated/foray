package ai.jwlabs.foura.engine;

/**
 * One item of a BUILT Foray queue, as the engine reads it: what {@code playForay}'s
 * {@code items} carry (plan §5.2), which {@code buildForayQueue} (player/foray-queue.js) emits and
 * the engine never builds itself (plan §3 A-1). The JVM twin of {@code ForayItem} in
 * ForayEngineCore (Policy/ForayClock.swift), card A-40.
 *
 * <p>Every field is null where the JS value is absent OR of the wrong type: the rules read each
 * one through {@code typeof x === "number"} (then {@code Number.isFinite}),
 * {@code typeof s === "string"} or {@code === true}, and each of those lands on the same answer
 * for "absent" and "wrong type". A number field may hold a non-finite double; the rules check
 * finiteness themselves, exactly where the JS calls {@code isNum}.
 */
public record ForayItem(String id, String kind, String type, String title, String show, String audioUrl, Double startSec,
                        Double endSec, Double authoredEndSec, Double durationSec, String durationSource, String script,
                        String sourceItemId, String itemId, boolean daiSuspected, boolean needsDriftCheck, String startAnchor,
                        String endAnchor, Double referenceDurationSec) {

    /** An item with no fields: what the JS reads from an entry that is not a plain object's members. */
    public static final ForayItem EMPTY = new ForayItem(null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, false, false, null, null, null);

    /**
     * A built queue item as {@code playForay} carries it: each field is the JS value when it has
     * the type the rules test for, else null, and the two flags are {@code === true}.
     */
    public static ForayItem of(JsonNode node) {
        return new ForayItem(str(node, "id"), str(node, "kind"), str(node, "type"), str(node, "title"), str(node, "show"),
                str(node, "audio_url"), num(node, "start_sec"), num(node, "end_sec"), num(node, "authored_end_sec"),
                num(node, "duration_sec"), str(node, "duration_source"), str(node, "script"), str(node, "source_item_id"),
                str(node, "item_id"), isTrue(node, "dai_suspected"), isTrue(node, "needs_drift_check"), str(node, "start_anchor"),
                str(node, "end_anchor"), num(node, "reference_duration_sec"));
    }

    /** The item as the seam rules read it (seam-gap.js {@code isSegment}). */
    public SeamGap.SeamItem seam() {
        return new SeamGap.SeamItem(startSec, endSec);
    }

    /** The item as interlude.js reads it. */
    public Interlude.InterludeItem interlude() {
        return new Interlude.InterludeItem(kind, type, sourceItemId, itemId, audioUrl, startSec, endSec);
    }

    /** The item as the lock-screen mapping reads it (media-session.js). */
    public MediaMapping.Item media() {
        return new MediaMapping.Item(kind, title, show);
    }

    private static String str(JsonNode node, String key) {
        JsonNode v = node == null ? null : node.get(key);
        return v == null ? null : v.stringValue();
    }

    private static Double num(JsonNode node, String key) {
        JsonNode v = node == null ? null : node.get(key);
        return v == null ? null : v.numberValue();
    }

    private static boolean isTrue(JsonNode node, String key) {
        JsonNode v = node == null ? null : node.get(key);
        return v instanceof JsonNode.Bool b && b.value();
    }
}

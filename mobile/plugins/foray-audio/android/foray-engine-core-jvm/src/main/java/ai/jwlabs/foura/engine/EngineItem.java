package ai.jwlabs.foura.engine;

import java.util.Objects;

/**
 * One queue item as the page built it (plan §3 A-1: the page owns the queue; the engine
 * plays what it is handed). The JVM twin of {@code EngineItem} in ForayEngineCore
 * (Engine/EngineInput.swift, NE-14s).
 *
 * <p>The node is kept VERBATIM, because rows the page reads back are built from it; the
 * fields the rules read are lifted out once, the way the JS reads them
 * ({@code typeof n === "number"} for numbers, {@code kind === "tts"}).
 */
public final class EngineItem {
    public final String id;
    public final JsonNode node;
    public final PlayerItemKind kind;
    /** {@code audio_url} when it is a non-empty string, else null. */
    public final String audioUrl;
    public final Double startSec;
    public final Double endSec;
    public final Double durationSec;

    private EngineItem(String id, JsonNode node) {
        this.id = id;
        this.node = node;
        this.kind = EngineConstants.QueueState.TTS.equals(string(node.get("kind"))) ? PlayerItemKind.TTS : PlayerItemKind.EPISODE;
        String url = string(node.get("audio_url"));
        this.audioUrl = url == null || url.isEmpty() ? null : url;
        this.startSec = number(node.get("start_sec"));
        this.endSec = number(node.get("end_sec"));
        this.durationSec = number(node.get("duration_sec"));
    }

    /**
     * The item, or null for one with no non-empty string {@code id}: the contract requires
     * one, and every rule keys on it.
     */
    public static EngineItem of(JsonNode node) {
        if (node == null) return null;
        String id = string(node.get("id"));
        if (id == null || id.isEmpty()) return null;
        return new EngineItem(id, node);
    }

    /**
     * {@code boundsOf(item)}: the slice this item occupies, or null for a whole episode. The
     * ONE definition ({@link ItemBounds#make}), so the in-point, the out-point and position
     * writes cannot disagree about a malformed item.
     */
    public ItemBounds bounds() {
        return ItemBounds.make(startSec, endSec);
    }

    /** {@code refOf(item)}: what the reducer knows of it. */
    public QueueItemRef ref() {
        return new QueueItemRef(id, kind, bounds());
    }

    // ---- what a built Foray item carries (A-40)

    /** The item as the seam rules read it. */
    public SeamGap.SeamItem seam() {
        return new SeamGap.SeamItem(startSec, endSec);
    }

    /** {@code needs_drift_check}, by truthiness (ADR-0007: the ladder runs at load). */
    public boolean needsDriftCheck() {
        JsonNode v = node.get("needs_drift_check");
        return v != null && v.isTruthy();
    }

    /** {@code dai_suspected}, by truthiness. */
    public boolean daiSuspected() {
        JsonNode v = node.get("dai_suspected");
        return v != null && v.isTruthy();
    }

    public Double referenceDurationSec() {
        return number(node.get("reference_duration_sec"));
    }

    /** ADR-0008's pad. */
    public Double adPadSec() {
        return number(node.get("ad_pad_sec"));
    }

    /**
     * §14: a RENDERED line (a file) that also carries its script, so a file that fails can be
     * read aloud instead.
     */
    public boolean canSpeakInstead() {
        if (kind != PlayerItemKind.TTS || audioUrl == null || jsTrim(audioUrl).isEmpty()) return false;
        String script = string(node.get("script"));
        return script != null && !jsTrim(script).isEmpty();
    }

    /** The item as the Foray clock and the structural check read it. */
    public ForayItem forayItem() {
        return ForayItem.of(node);
    }

    /** The item as the transport rules read it. */
    public TransportPolicy.Item transportItem() {
        JsonNode url = node.get("audio_url");
        return new TransportPolicy.Item(startSec, endSec, number(node.get("authored_end_sec")), durationSec,
                string(node.get("kind")), url != null && url.isTruthy());
    }

    /**
     * {@code _isSynthNarration(item)}: a {@code tts} item with a non-empty {@code script} and
     * no file. The narrating overlay speaks it (the core's rules since A-40; the host's
     * synthesiser is A-41's), and the rate rule reads it (a spoken line never takes the
     * listener's rate).
     */
    public boolean isSynthNarration() {
        if (kind != PlayerItemKind.TTS || audioUrl != null) return false;
        String script = string(node.get("script"));
        return script != null && !jsTrim(script).isEmpty();
    }

    /** {@code String.prototype.trim}: JavaScript's white space and line terminators, not Java's. */
    static String jsTrim(String text) {
        int start = 0;
        int end = text.length();
        while (start < end && Rows.isJSWhitespace(text.charAt(start))) start++;
        while (end > start && Rows.isJSWhitespace(text.charAt(end - 1))) end--;
        return text.substring(start, end);
    }

    private static String string(JsonNode value) {
        return value == null ? null : value.stringValue();
    }

    private static Double number(JsonNode value) {
        return value == null ? null : value.numberValue();
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof EngineItem e && e.id.equals(id) && e.node.equals(node);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id, node);
    }

    @Override
    public String toString() {
        return "EngineItem[" + id + "]";
    }
}

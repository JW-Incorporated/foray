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

    /**
     * {@code _isSynthNarration(item)}: a {@code tts} item with a non-empty {@code script} and
     * no file. The narrating overlay speaks it (A-41); until then no rule here plays one,
     * but the rate rule already reads it (a spoken line never takes the listener's rate).
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

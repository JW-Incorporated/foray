package ai.jwlabs.foura.engine;

/**
 * The interlude jingle's RULE and the native silence node's cap: the JVM twin of
 * {@code Interlude} in ForayEngineCore (Policy/Interlude.swift), card A-40, and like it the port of
 * the pure half of {@code player/interlude.js} (the {@code interlude} family). The jingle player
 * itself is the host's (A-41); it asks THIS whether a seam gets the jingle and how long silence may
 * run. The reasons for each clause live in interlude.js's header: segment -> segment and
 * narration -> segment on an auto-advance only, never after an authored JINGLE item, never
 * between two cuts of the same episode, and the seam beat is the floor.
 */
public final class Interlude {
    private Interlude() {}

    /** {@code INTERLUDE_DURATION_SEC}: the placeholder asset's measured length. */
    public static final double DURATION_SEC = EngineConstants.Interlude.INTERLUDE_DURATION_SEC;
    /** {@code INTERLUDE_CEILING_SEC}: the longest a seam is held for the jingle, and the silence node's cap. */
    public static final double CEILING_SEC = EngineConstants.Interlude.INTERLUDE_CEILING_SEC;
    /** {@code INTERLUDE_RATE}: always 1x. */
    public static final double RATE = EngineConstants.Interlude.INTERLUDE_RATE;
    /** {@code INTERLUDE_ASSET_URL}. */
    public static final String ASSET_URL = EngineConstants.Interlude.INTERLUDE_ASSET_URL;
    /** {@code JINGLE} in player/foray-queue.js: an authored jingle item's kind. */
    public static final String JINGLE_KIND = "jingle";

    /**
     * A queue item as the interlude rule sees it. Every field is null where the JS value is absent
     * or not the type the JS checks for.
     */
    public record InterludeItem(String kind, String type, String sourceItemId, String itemId, String audioUrl, Double startSec,
                                Double endSec) {
        SeamGap.SeamItem seamItem() {
            return new SeamGap.SeamItem(startSec, endSec);
        }
    }

    /** {@code isNarration(item)}: {@code kind === "tts" || type === "narration"}. */
    public static boolean isNarration(InterludeItem item) {
        return item != null && ("tts".equals(item.kind()) || "narration".equals(item.type()));
    }

    /**
     * {@code sourceKeyOf(item)} (segment-strip.js): the narrator (null here), or the first
     * NON-BLANK string of {@code source_item_id}, {@code item_id}, {@code audio_url}, else "".
     */
    static String sourceKey(InterludeItem item) {
        if (isNarration(item)) return null;
        if (item != null) {
            for (String key : new String[] {item.sourceItemId(), item.itemId(), item.audioUrl()}) {
                if (key != null && !isJSBlank(key)) return key;
            }
        }
        return "";
    }

    /**
     * {@code sameSourceEpisode(from, to)}: only a POSITIVE match counts. Two narrators are not
     * one episode, and two unidentified items are not evidence of one.
     */
    public static boolean sameSourceEpisode(InterludeItem from, InterludeItem to) {
        String a = sourceKey(from);
        if (a == null || a.isEmpty()) return false;
        String b = sourceKey(to);
        return b != null && a.equals(b);
    }

    /**
     * {@code interludeEligible({from, to, cause})}. {@code cause} null stands for a value that is
     * not a string (it can never equal {@code "auto"}).
     */
    public static boolean eligible(InterludeItem from, InterludeItem to, String cause) {
        if (!SeamGap.AUTO_ADVANCE.equals(cause)) return false;
        if (from == null || to == null) return false;
        if (!SeamGap.isSegment(to.seamItem())) return false;
        if (JINGLE_KIND.equals(from.kind())) return false;
        return !sameSourceEpisode(from, to);
    }

    /** {@link #eligible} on an automatic advance. */
    public static boolean eligible(InterludeItem from, InterludeItem to) {
        return eligible(from, to, SeamGap.AUTO_ADVANCE);
    }

    /**
     * {@code silenceNodeSec({sinceOutPointSec, running, sessionActive})}: how many more seconds
     * the silence node may render, measured from the out-point. Never beyond the ceiling; never
     * while the engine is not running or the session is not active. A time that is not a finite,
     * non-negative number is no silence at all.
     */
    public static double silenceNodeSec(Double sinceOutPointSec, boolean running, boolean sessionActive) {
        if (!running || !sessionActive) return 0;
        if (sinceOutPointSec == null || !Double.isFinite(sinceOutPointSec) || sinceOutPointSec < 0) return 0;
        return JSMath.max(0, CEILING_SEC - sinceOutPointSec);
    }

    /**
     * {@code s.trim().length === 0}: ECMAScript's WhiteSpace and LineTerminator. Measured by code
     * point (the set is all in the BMP, so a surrogate is never blank).
     */
    static boolean isJSBlank(String text) {
        for (int i = 0; i < text.length(); i++) {
            if (!Rows.isJSWhitespace(text.charAt(i))) return false;
        }
        return true;
    }
}

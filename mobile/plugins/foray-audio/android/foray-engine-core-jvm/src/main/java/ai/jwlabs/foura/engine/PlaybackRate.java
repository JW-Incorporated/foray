package ai.jwlabs.foura.engine;

import java.util.List;

/**
 * The playback-speed ladder and the synthesiser's rate: the port of
 * {@code player/playback-rate.js} (the reference, whose header carries the ladder's
 * reasons), and the JVM twin of {@code PlaybackRate} in ForayEngineCore
 * (Policy/PlaybackRate.swift, NE-09). The {@code rate} parity family is the contract.
 *
 * <p>Every number is READ from the generated {@link EngineConstants.PlaybackRate}, never
 * retyped. A null parameter stands for every value {@code typeof v === "number"} rejects
 * (absent, null, a string).
 */
public final class PlaybackRate {
    private PlaybackRate() {}

    /** {@code RATES}, ascending. */
    public static final List<Double> RATES = EngineConstants.PlaybackRate.RATES;
    /** {@code DEFAULT_RATE}: 1x, and the answer to every unusable input. */
    public static final double DEFAULT_RATE = EngineConstants.PlaybackRate.DEFAULT_RATE;
    public static final double MIN_RATE = EngineConstants.PlaybackRate.MIN_RATE;
    public static final double MAX_RATE = EngineConstants.PlaybackRate.MAX_RATE;

    /** {@code isRate(v)}: exactly one of the stops. A value that is not a finite number is never a rate. */
    public static boolean isRate(Double value) {
        if (value == null || !Rows.isFinite(value)) return false;
        for (double stop : RATES) if (stop == value) return true;
        return false;
    }

    /**
     * {@code normalizeRate(v)}: any value onto the ladder. A finite positive number snaps to
     * the NEAREST stop, a number past either end clamps to that end, and only a value that
     * is not a usable number at all (null, NaN, an infinity, 0, negative) falls back to 1x.
     * A tie keeps the LOWER stop: the JS loop replaces its best only on a strictly smaller
     * distance.
     */
    public static double normalize(Double value) {
        if (value == null || !Rows.isFinite(value) || !(value > 0)) return DEFAULT_RATE;
        if (value <= MIN_RATE) return MIN_RATE;
        if (value >= MAX_RATE) return MAX_RATE;
        double best = RATES.get(0);
        for (double stop : RATES) {
            if (Math.abs(stop - value) < Math.abs(best - value)) best = stop;
        }
        return best;
    }

    /** {@code nextRate(v)}: the next stop up, wrapping from the top. Normalises FIRST (the indexOf -1 bug). */
    public static double next(Double value) {
        double current = normalize(value);
        int at = Math.max(RATES.indexOf(current), 0);
        return RATES.get((at + 1) % RATES.size());
    }

    /** What a {@code setRate} does with the value it was handed. */
    public record Snap(double applied, boolean snapped) {}

    /**
     * The decision inside {@code PlayerQueueManager.setRate}: {@code normalizeRate}, and
     * {@code !isRate} for "did we change what you asked for?". Snapping is never silent:
     * the manager writes {@code rate.snapped} whenever {@code snapped} is true.
     */
    public static Snap snap(Double requested) {
        return new Snap(normalize(requested), !isRate(requested));
    }

    // ---- the synthesiser's rate

    public static final double UTTERANCE_MIN_RATE = EngineConstants.PlaybackRate.UTTERANCE_MIN_RATE;
    public static final double UTTERANCE_DEFAULT_RATE = EngineConstants.PlaybackRate.UTTERANCE_DEFAULT_RATE;
    public static final double UTTERANCE_MAX_RATE = EngineConstants.PlaybackRate.UTTERANCE_MAX_RATE;

    /**
     * {@code utteranceRate(multiplier)}: a playback multiplier to an AVSpeechUtterance rate,
     * on the calibrated curve the iOS plugin uses. COPIED number for number and in the same
     * arithmetic order, so the rate family's utterance-rate cases hold this port to the JS.
     * (Android's TextToSpeech takes its own rate scale; this is the shared rule, not the
     * Android mapping.) Not a positive number: the slowest rate. +Infinity clamps to the
     * fastest.
     */
    public static double utteranceRate(double multiplier) {
        if (!(multiplier > 0)) return UTTERANCE_MIN_RATE;
        double anchorRate = UTTERANCE_DEFAULT_RATE * EngineConstants.PlaybackRate.UTTERANCE_CALIBRATION_REQUESTED;
        double anchorSpan = anchorRate - UTTERANCE_DEFAULT_RATE;
        double scaled = UTTERANCE_DEFAULT_RATE
                + anchorSpan * StrictMath.log(multiplier) / StrictMath.log(EngineConstants.PlaybackRate.UTTERANCE_CALIBRATION_PERCEIVED);
        return JSMath.min(JSMath.max(scaled, UTTERANCE_MIN_RATE), UTTERANCE_MAX_RATE);
    }
}

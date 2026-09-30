package ai.jwlabs.foura.engine;

/**
 * Can a timestamp be trusted, and may a Foray segment load on the copy in hand? The JVM twin of
 * {@code SeekPolicy} in ForayEngineCore (Policy/SeekPolicy.swift), card A-40, and like it the port
 * of {@code player/seek-policy.js} (the {@code seek-policy} family: {@code seek-precision.json} and
 * {@code load-gate.json}). The JS header is the reference for every reason: corner case #2 (dynamic
 * ad insertion), ADR-0007's ladder and ADR-0008's pad.
 *
 * <pre>
 *   1. local downloaded file                -> EXACT, the timeline is frozen
 *   2. not DAI                              -> EXACT via start_sec
 *   3. DAI, |observed - reference| <= 30 s  -> EXACT, the ad load matches
 *   4. DAI, drifted                         -> the locate step (not built)
 *   5. unresolvable                         -> APPROXIMATE: the segment is SKIPPED
 * </pre>
 *
 * <p>Every parameter is typed. Null for a duration or a pad stands for every value
 * {@code typeof x === "number"} rejects; NaN and the infinities ARE numbers there, so they come in
 * as themselves and take the branch JS takes with them.
 */
public final class SeekPolicy {
    private SeekPolicy() {}

    public static final String OWN = EngineConstants.SeekPolicy.OWN;
    public static final String FOREIGN = EngineConstants.SeekPolicy.FOREIGN;
    /** {@code DRIFT_TOLERANCE_SEC} (authored 30): never widened for the pad (ADR-0008). */
    public static final double DRIFT_TOLERANCE_SEC = EngineConstants.SeekPolicy.DRIFT_TOLERANCE_SEC;
    /** {@code AD_PAD_CEILING_SEC} (authored 120). */
    public static final double AD_PAD_CEILING_SEC = EngineConstants.SeekPolicy.AD_PAD_CEILING_SEC;

    /** {@code EXACT} / {@code APPROXIMATE} / {@code PADDED}. */
    public enum Precision {
        EXACT(EngineConstants.SeekPolicy.EXACT),
        APPROXIMATE(EngineConstants.SeekPolicy.APPROXIMATE),
        PADDED(EngineConstants.SeekPolicy.PADDED);

        public final String token;

        Precision(String token) {
            this.token = token;
        }
    }

    /** What {@code seekPrecision} returns: {@code {precision, reason}}, plus {@code padSec} when PADDED. */
    public record Verdict(Precision precision, String reason, Double padSec) {
        public Verdict(Precision precision, String reason) {
            this(precision, reason, null);
        }
    }

    /** {@code locateStep()}: ADR-0007 rung 4 / ADR-0008's locate step, a named, tested absence. */
    public record LocateStep(boolean implemented, String reason) {}

    public static LocateStep locateStep() {
        return new LocateStep(false,
                "anchor resolution (ADR-0007 rung 4 / ADR-0008's locate step) is not implemented — segment skipped rather than played at a stale offset");
    }

    /**
     * {@code seekPrecision(item, ctx)}. {@code source} null stands for a non-string (never OWN).
     */
    public static Verdict seekPrecision(boolean daiSuspected, boolean isLocalFile, String source, Double observedDuration,
                                        Double recordedDuration, Double adPadSec, boolean allowAdPad) {
        if (isLocalFile) return new Verdict(Precision.EXACT, "local file");
        if (!daiSuspected) return new Verdict(Precision.EXACT, "static enclosure");

        if (OWN.equals(source)) {
            if (observedDuration != null && recordedDuration != null
                    && Math.abs(observedDuration - recordedDuration) > DRIFT_TOLERANCE_SEC) {
                return new Verdict(Precision.APPROXIMATE,
                        "ad load changed (" + whole(Math.abs(observedDuration - recordedDuration)) + "s duration drift)");
            }
            return new Verdict(Precision.EXACT, "listener's own marker on their own copy");
        }

        // Rung 3: the ad load in the copy in hand matches the reference.
        if (observedDuration != null && Double.isFinite(observedDuration) && recordedDuration != null
                && Double.isFinite(recordedDuration)) {
            double drift = Math.abs(observedDuration - recordedDuration);
            if (drift <= DRIFT_TOLERANCE_SEC) {
                return new Verdict(Precision.EXACT, "ad load matches the reference copy (" + whole(drift) + "s duration drift)");
            }
        }

        // ADR-0008's pad: the ceiling is on the PAD, and the pad must bound this copy's ad load.
        if (allowAdPad && adPadSec != null && Double.isFinite(adPadSec) && adPadSec > 0) {
            double pad = adPadSec;
            if (pad > AD_PAD_CEILING_SEC) {
                return new Verdict(Precision.APPROXIMATE,
                        "LOCATE-REQUIRED: " + whole(pad) + "s pad exceeds the " + whole(AD_PAD_CEILING_SEC) + "s ceiling (ADR-0008)");
            }
            if (observedDuration != null && Double.isFinite(observedDuration) && recordedDuration != null
                    && Double.isFinite(recordedDuration)) {
                double load = Math.abs(observedDuration - recordedDuration);
                if (load > pad) {
                    return new Verdict(Precision.APPROXIMATE,
                            "this copy carries " + whole(load) + "s of ad load, beyond the " + whole(pad) + "s the pad bounds (ADR-0008)");
                }
            }
            return new Verdict(Precision.PADDED,
                    "PADDABLE: " + whole(pad) + "s pad within the " + whole(AD_PAD_CEILING_SEC) + "s ceiling (ADR-0008)", pad);
        }

        return new Verdict(Precision.APPROXIMATE, "dynamic ad insertion; " + locateStep().reason());
    }

    /** {@code canSeekExactly(item, ctx)}: only EXACT is a hard seek. */
    public static boolean canSeekExactly(Verdict verdict) {
        return verdict.precision() == Precision.EXACT;
    }

    /** {@code canPlaySegment(item, ctx)}: exact plays, padded plays with an extended stop, approximate is skipped. */
    public static boolean canPlaySegment(Verdict verdict) {
        return verdict.precision() != Precision.APPROXIMATE;
    }

    /** What {@code segmentLoadGate} answers: {@code {ok: true}}, {@code {ok: true, note}} or {@code {ok: false, reason}}. */
    public record LoadGate(boolean ok, String reason, String note) {
        public static final LoadGate ALLOWED = new LoadGate(true, null, null);

        public static LoadGate refused(String reason) {
            return new LoadGate(false, reason, null);
        }

        public static LoadGate noted(String note) {
            return new LoadGate(true, null, note);
        }
    }

    /**
     * {@code segmentLoadGate(item, {observedDuration, isLocalFile, allowAdPad})}: the ladder AT
     * LOAD, once the copy in hand reports its duration. Only an item the builder flagged
     * ({@code needs_drift_check}) is checked; a flagged item whose copy reports no finite duration
     * cannot be compared, so it does not load. Otherwise the ladder's answer, with the source
     * always FOREIGN.
     */
    public static LoadGate segmentLoadGate(boolean needsDriftCheck, boolean daiSuspected, Double referenceDurationSec,
                                           Double adPadSec, Double observedDuration, boolean isLocalFile, boolean allowAdPad) {
        if (!needsDriftCheck) return LoadGate.ALLOWED;
        if (observedDuration == null || !Double.isFinite(observedDuration)) {
            return LoadGate.refused("the copy in hand reports no duration, so the ad load cannot be compared to the reference");
        }
        Verdict verdict = seekPrecision(daiSuspected, isLocalFile, FOREIGN, observedDuration, referenceDurationSec, adPadSec,
                allowAdPad);
        if (verdict.precision() == Precision.APPROXIMATE) return LoadGate.refused(verdict.reason());
        return LoadGate.noted(verdict.precision().token + " — " + verdict.reason());
    }

    /** {@code `${Math.round(x)}`}: JavaScript's rounding (ties up), printed as JavaScript prints a number. */
    static String whole(double value) {
        return JSWriter.numberToString(JSMath.round(value));
    }
}

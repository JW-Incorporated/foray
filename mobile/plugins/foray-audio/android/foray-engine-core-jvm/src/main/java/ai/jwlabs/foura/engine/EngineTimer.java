package ai.jwlabs.foura.engine;

/**
 * The timers the core arms through {@code timerArm} and hears back from: the JVM twin of
 * {@code EngineTimer} in ForayEngineCore (Engine/EngineInput.swift). The seam beat, the
 * narration pulse and the silence cap came with the Foray tape (A-40).
 */
public enum EngineTimer {
    /** The periodic position write while playing (corner case #17). */
    POSITION_TICK("position-tick"),
    /** The grace span's expiration fired. */
    GRACE_EXPIRED("grace-expired"),
    /** {@code pauseHoldPolicy = until(m)} ran out while paused. */
    HOLD_EXPIRED("hold-expired"),
    /** The seam beat's remainder ran out: the parked load becomes audible. */
    SEAM_BEAT("seam-beat"),
    /** The narration pulse ({@code NARRATION_TICK_MS}): a spoken line's clock, deadline and suspension checks. */
    NARRATION_TICK("narration-tick"),
    /** The silence node's hard cap ({@code INTERLUDE_CEILING_SEC} from the out-point). */
    SILENCE_CAP("silence-cap");

    public final String token;

    EngineTimer(String token) {
        this.token = token;
    }
}

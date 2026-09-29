package ai.jwlabs.foura.engine;

/**
 * The timers the core arms through {@code timerArm} and hears back from: the JVM twin of
 * {@code EngineTimer} in ForayEngineCore (Engine/EngineInput.swift). The seam beat, the
 * narration pulse and the silence cap arrive with the Foray tape and the narrating overlay
 * (A-40, A-41).
 */
public enum EngineTimer {
    /** The periodic position write while playing (corner case #17). */
    POSITION_TICK("position-tick"),
    /** The grace span's expiration fired. */
    GRACE_EXPIRED("grace-expired"),
    /** {@code pauseHoldPolicy = until(m)} ran out while paused. */
    HOLD_EXPIRED("hold-expired");

    public final String token;

    EngineTimer(String token) {
        this.token = token;
    }
}

package ai.jwlabs.foura.engine;

import java.util.Objects;

/**
 * How a core is built: what it cannot learn from an input. The JVM twin of
 * {@code EngineConfig} in ForayEngineCore (Engine/EngineCore.swift), the episode subset:
 * the Foray tape's switches (the tape, the seam gap, the standby deck) arrive with A-40
 * and the narrating overlay's (the pulse, the jingle, the silence node, the voice at boot)
 * with A-41. Without them the core is exactly M1's episode engine.
 *
 * <p>{@code build}: the app's version code, stamped into the restore record.
 * {@code holdPolicy}: {@code pauseHoldPolicy} (plan §4.4). {@code rate}: the listener's
 * stored speed ({@code cp_rate}), snapped onto the ladder; null when none is stored.
 */
public record EngineConfig(String build, SessionPolicy.HoldPolicy holdPolicy, Double rate) {
    public EngineConfig {
        Objects.requireNonNull(build, "build");
        Objects.requireNonNull(holdPolicy, "holdPolicy");
    }

    public EngineConfig(String build) {
        this(build, SessionPolicy.HoldPolicy.DEFAULT, null);
    }

    public EngineConfig() {
        this("");
    }
}

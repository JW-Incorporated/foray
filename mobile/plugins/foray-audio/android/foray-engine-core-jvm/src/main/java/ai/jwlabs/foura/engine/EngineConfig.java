package ai.jwlabs.foura.engine;

import java.util.Objects;

/**
 * How a core is built: what it cannot learn from an input. The JVM twin of
 * {@code EngineConfig} in ForayEngineCore (Engine/EngineCore.swift).
 *
 * <p>{@code build}: the app's version code, stamped into the restore record.
 * {@code holdPolicy}: {@code pauseHoldPolicy} (plan §4.4). {@code rate}: the listener's
 * stored speed ({@code cp_rate}), snapped onto the ladder; null when none is stored.
 *
 * <p>THE FORAY TAPE (A-40, the Swift NE-30s switches), OFF by default so the short
 * constructors build exactly M1's episode engine (the {@code manager-episode} family runs so):
 * <ul>
 *   <li>{@code forayTapeEnabled}: the {@code playForay} command, ADR-0007's load-time ladder, the
 *       seam beat and its transport cuts, the standby deck's prepare, rendered and spoken
 *       narration bridges and the {@code cp_foray} cadence. Off, {@code playForay} is refused
 *       {@code capability-off} and every episode path is M1's.</li>
 *   <li>{@code seamGapSec}: {@code SEAM_GAP_SEC} (0.5 s), passed straight through;
 *       {@link SeamGap} owns what a nonsense length means (no beat).</li>
 *   <li>{@code deckPairEnabled}: the core decides nothing on it; the host reads it to choose
 *       which deck it builds (the pair opens the prefetch window, a single deck never does).</li>
 *   <li>{@code narrationFollowsListenerRate}: OQ-3 ("1x for now"): OFF, a spoken line is uttered
 *       at {@code NARRATION_RATE} whatever the listener's speed.</li>
 *   <li>{@code narrationPulse}: a surface listens to the narration pulse (the app always does;
 *       the parity driver sets it from {@code setup.narrationTicks}).</li>
 *   <li>{@code interludeAvailable}: the host has a jingle player; off, no seam gets a jingle.</li>
 *   <li>{@code interludeEnabled}: {@code cp_interlude} as read at boot (default on).</li>
 *   <li>{@code silenceNodeEnabled}: the silence node, OFF.</li>
 *   <li>{@code voiceId}: the listener's narration voice at boot, null for the synthesiser's pick.</li>
 * </ul>
 */
public record EngineConfig(String build, SessionPolicy.HoldPolicy holdPolicy, Double rate, boolean forayTapeEnabled,
                           double seamGapSec, boolean deckPairEnabled, boolean narrationFollowsListenerRate, boolean narrationPulse,
                           boolean interludeAvailable, boolean interludeEnabled, boolean silenceNodeEnabled, String voiceId) {
    public EngineConfig {
        Objects.requireNonNull(build, "build");
        Objects.requireNonNull(holdPolicy, "holdPolicy");
    }

    /** M1's episode engine: the tape and everything behind it off. */
    public EngineConfig(String build, SessionPolicy.HoldPolicy holdPolicy, Double rate) {
        this(build, holdPolicy, rate, false, SeamGap.DEFAULT_GAP_SEC, false, false, true, false, true, false, null);
    }

    public EngineConfig(String build) {
        this(build, SessionPolicy.HoldPolicy.DEFAULT, null);
    }

    public EngineConfig() {
        this("");
    }

    /** This config with the listener's stored speed replaced (a cold boot's record carries its own). */
    public EngineConfig withRate(Double newRate) {
        return new EngineConfig(build, holdPolicy, newRate, forayTapeEnabled, seamGapSec, deckPairEnabled,
                narrationFollowsListenerRate, narrationPulse, interludeAvailable, interludeEnabled, silenceNodeEnabled, voiceId);
    }

    /** This config with the Foray tape (and, for a host, the deck pair) switched. */
    public EngineConfig withForayTape(boolean tape, boolean deckPair) {
        return new EngineConfig(build, holdPolicy, rate, tape, seamGapSec, deckPair, narrationFollowsListenerRate, narrationPulse,
                interludeAvailable, interludeEnabled, silenceNodeEnabled, voiceId);
    }
}

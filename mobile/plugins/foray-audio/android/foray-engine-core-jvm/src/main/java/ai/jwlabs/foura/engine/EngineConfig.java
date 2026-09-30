package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
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
 *
 * <p>ROUTE RESUME (A-61, the Swift NE-38rs fields):
 * <ul>
 *   <li>{@code routeResumeBluetooth}: the Bluetooth arm ({@code ROUTE_RESUME_BLUETOOTH_DEFAULT}),
 *       OFF. The service reads it from mobile/ENGINE_DEFAULT.json's android block through
 *       {@code EngineLane.ROUTE_RESUME_BLUETOOTH}, which shell-invariants holds to the file.</li>
 *   <li>{@code routeSalt}: the install's salt for route keys ({@link RouteResume#hashedKey}), kept
 *       beside the known set in {@code ForayEngine.knownRoutes}; empty in a headless core.</li>
 *   <li>{@code knownRoutes}: the known set the host read back from that key.</li>
 * </ul>
 */
public record EngineConfig(String build, SessionPolicy.HoldPolicy holdPolicy, Double rate, boolean forayTapeEnabled,
                           double seamGapSec, boolean deckPairEnabled, boolean narrationFollowsListenerRate, boolean narrationPulse,
                           boolean interludeAvailable, boolean interludeEnabled, boolean silenceNodeEnabled, String voiceId,
                           boolean routeResumeBluetooth, String routeSalt, List<String> knownRoutes) {
    public EngineConfig {
        Objects.requireNonNull(build, "build");
        Objects.requireNonNull(holdPolicy, "holdPolicy");
        if (routeSalt == null) routeSalt = "";
        knownRoutes = knownRoutes == null ? Collections.<String>emptyList()
                : Collections.unmodifiableList(new ArrayList<>(knownRoutes));
    }

    /** Everything up to the voice, with route resume at its defaults: the arm off, no salt, nothing known. */
    public EngineConfig(String build, SessionPolicy.HoldPolicy holdPolicy, Double rate, boolean forayTapeEnabled,
                        double seamGapSec, boolean deckPairEnabled, boolean narrationFollowsListenerRate, boolean narrationPulse,
                        boolean interludeAvailable, boolean interludeEnabled, boolean silenceNodeEnabled, String voiceId) {
        this(build, holdPolicy, rate, forayTapeEnabled, seamGapSec, deckPairEnabled, narrationFollowsListenerRate, narrationPulse,
                interludeAvailable, interludeEnabled, silenceNodeEnabled, voiceId, RouteResume.BLUETOOTH_DEFAULT, "", null);
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
                narrationFollowsListenerRate, narrationPulse, interludeAvailable, interludeEnabled, silenceNodeEnabled, voiceId,
                routeResumeBluetooth, routeSalt, knownRoutes);
    }

    /** This config with the jingle player's presence switched (A-41: the host has one only when its pinned asset shipped). */
    public EngineConfig withInterludeAvailable(boolean available) {
        return new EngineConfig(build, holdPolicy, rate, forayTapeEnabled, seamGapSec, deckPairEnabled, narrationFollowsListenerRate,
                narrationPulse, available, interludeEnabled, silenceNodeEnabled, voiceId, routeResumeBluetooth, routeSalt, knownRoutes);
    }

    /** This config with the Foray tape (and, for a host, the deck pair) switched. */
    public EngineConfig withForayTape(boolean tape, boolean deckPair) {
        return new EngineConfig(build, holdPolicy, rate, tape, seamGapSec, deckPair, narrationFollowsListenerRate, narrationPulse,
                interludeAvailable, interludeEnabled, silenceNodeEnabled, voiceId, routeResumeBluetooth, routeSalt, knownRoutes);
    }

    /**
     * This config with route resume's inputs (A-61): the Bluetooth arm, the install's salt and the
     * known set the host read back from {@code ForayEngine.knownRoutes}.
     */
    public EngineConfig withRouteResume(boolean bluetooth, String salt, List<String> known) {
        return new EngineConfig(build, holdPolicy, rate, forayTapeEnabled, seamGapSec, deckPairEnabled, narrationFollowsListenerRate,
                narrationPulse, interludeAvailable, interludeEnabled, silenceNodeEnabled, voiceId, bluetooth, salt, known);
    }
}

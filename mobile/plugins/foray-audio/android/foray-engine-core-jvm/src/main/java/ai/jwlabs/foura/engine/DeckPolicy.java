package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The episode deck's decisions: the port of {@code player/deck-policy.js}, and the JVM twin
 * of {@code DeckPolicy} in ForayEngineCore (Policy/DeckPolicy.swift, NE-14s). The
 * {@code deck-episode} parity family is the contract (card A-24).
 *
 * <p>WHY THESE ARE THE CORE'S AND NOT THE DECK'S. The ExoPlayer deck (A-25) is an adapter:
 * it runs commands against Media3 and reports what it saw. Every choice a deck makes that
 * the web deck also makes (when the out-point's fine watch arms and for how long, what a
 * fine wake does, how long a load may take, when the next item is a seek in the buffer
 * rather than a refetch, what the handover's recovery may still do after a stop) is made
 * HERE, once, and pinned by the fixtures JS records. Every number is read from the
 * generated {@link EngineConstants}.
 *
 * <p>The Foray half of deck-policy.js (the standby deck's {@code prefetchDecision} and
 * {@code warmPromotion}, the out-point layers) belongs to the {@code deck}, {@code prepare}
 * and {@code outpoint} families, which A-25 ports with the deck itself.
 *
 * <p>Nothing here reads a clock, the deck or storage: facts in, an answer out.
 */
public final class DeckPolicy {
    private DeckPolicy() {}

    /** {@code OUT_POINT_ARM_LEAD_SEC}: how much WALL clock before the boundary the fine stage takes over. */
    public static final double OUT_POINT_ARM_LEAD_SEC = EngineConstants.DeckPolicy.OUT_POINT_ARM_LEAD_SEC;
    /** {@code OUT_POINT_MIN_TIMER_MS}: never ask a timer for less. */
    public static final double OUT_POINT_MIN_TIMER_MS = EngineConstants.DeckPolicy.OUT_POINT_MIN_TIMER_MS;
    /** {@code LOAD_SETTLE_TIMEOUT_MS}: a visible load's deadline. */
    public static final double LOAD_SETTLE_TIMEOUT_MS = EngineConstants.DeckPolicy.LOAD_SETTLE_TIMEOUT_MS;
    /** {@code LOAD_SETTLE_TIMEOUT_HIDDEN_MS}: a hidden load's deadline (a hidden load is a different machine). */
    public static final double LOAD_SETTLE_TIMEOUT_HIDDEN_MS = EngineConstants.DeckPolicy.LOAD_SETTLE_TIMEOUT_HIDDEN_MS;
    /** {@code SETTLE_NEAR_SEC}: how close an in-place seek must land to count. */
    public static final double SETTLE_NEAR_SEC = EngineConstants.DeckPolicy.SETTLE_NEAR_SEC;

    /** {@code FINE_WAKE}: what a fine-watch wake does. */
    public enum FineWake {
        /** The playhead reached the boundary: pause and report the out-point. */
        STOP(EngineConstants.DeckPolicy.FineWake.STOP),
        /** Woke early with progress (timer jitter): arm again for what is left. */
        RESCHEDULE(EngineConstants.DeckPolicy.FineWake.RESCHEDULE),
        /** Woke early with NO progress since the last wake: a stall; hand back to the coarse stage. */
        STAND_DOWN(EngineConstants.DeckPolicy.FineWake.STAND_DOWN);

        public final String token;

        FineWake(String token) {
            this.token = token;
        }
    }

    /** {@code RECOVERY}: what the handover's recovery does once its load settles. */
    public enum Recovery {
        ARM_OUT_POINT(EngineConstants.DeckPolicy.Recovery.ARM_OUT_POINT),
        PLAY(EngineConstants.DeckPolicy.Recovery.PLAY),
        REPORT(EngineConstants.DeckPolicy.Recovery.REPORT);

        public final String token;

        Recovery(String token) {
            this.token = token;
        }
    }

    /**
     * {@code deckRate(playbackRate)}: the rate the fine watch divides by, the deck's own when
     * it is a positive number, else 1x. {@code null} stands for every value
     * {@code typeof x === "number"} rejects.
     */
    public static double deckRate(Double rate) {
        if (rate == null || !(rate > 0)) return 1;
        return rate;
    }

    /** {@code outPointArmed({atSec, outPointSec})}: armed only while the playhead is BEFORE the boundary. */
    public static boolean outPointArmed(double atSec, double outPointSec) {
        return atSec < outPointSec;
    }

    /**
     * {@code fineWatchDelayMs({outPointSec, atSec, rate, armed, paused})}: how long, in
     * WALL-CLOCK ms, to arm the fine watch for, or null when it must not be armed now (no
     * boundary, disarmed, paused, or further than the lead). The remaining CONTENT divided
     * by the rate, rounded UP, never below the timer floor; the JS operations in the JS
     * order, so the IEEE results are the same bits.
     */
    public static Double fineWatchDelayMs(Double outPointSec, double atSec, Double rate, boolean armed, boolean paused) {
        if (outPointSec == null || !armed || paused) return null;
        double remainingWallSec = (outPointSec - atSec) / deckRate(rate);
        if (remainingWallSec > OUT_POINT_ARM_LEAD_SEC) return null;
        return JSMath.max(OUT_POINT_MIN_TIMER_MS, Math.ceil(remainingWallSec * 1000));
    }

    /**
     * {@code fineWakeAction({atSec, outPointSec, lastWakeAtSec})}. THE STOP IS NEVER EARLY: a
     * wake stops only on a real crossing; an early wake with progress reschedules, one with
     * none since the last early wake stands down instead of spinning.
     */
    public static FineWake fineWakeAction(double atSec, double outPointSec, Double lastWakeAtSec) {
        if (atSec >= outPointSec) return FineWake.STOP;
        if (lastWakeAtSec != null && atSec <= lastWakeAtSec) return FineWake.STAND_DOWN;
        return FineWake.RESCHEDULE;
    }

    /**
     * {@code loadDeadlineMs({pinnedMs, hidden})}: a pinned deadline wins at either
     * visibility; otherwise only a page KNOWN to be hidden gets the hidden budget.
     */
    public static double loadDeadlineMs(Double pinnedMs, boolean hidden) {
        if (pinnedMs != null) return pinnedMs;
        return hidden ? LOAD_SETTLE_TIMEOUT_HIDDEN_MS : LOAD_SETTLE_TIMEOUT_MS;
    }

    /**
     * {@code sameSourceIsSeek({loadedUrl, url, hasMetadata, failed})}: SAME SOURCE = A SEEK,
     * NOT A LOAD. A deck already holding this URL, with metadata and no error, moves its
     * playhead inside the buffer it has, so an in-place resume costs no network round trip;
     * a FAILED item is rebuilt.
     */
    public static boolean sameSourceIsSeek(String loadedUrl, String url, boolean hasMetadata, boolean failed) {
        if (loadedUrl == null || loadedUrl.isEmpty()) return false;
        return loadedUrl.equals(url) && hasMetadata && !failed;
    }

    /** {@code settledNear({atSec, targetSec})}: within SETTLE_NEAR_SEC of the target. */
    public static boolean settledNear(double atSec, double targetSec) {
        return Math.abs(atSec - targetSec) <= SETTLE_NEAR_SEC;
    }

    /**
     * {@code recoveryLoadedOps({superseded, stopped, boundarySec})}: a superseded recovery
     * does nothing; a STOPPED one arms but does not play (#267); otherwise arm, then play.
     * Only a real boundary is armed.
     */
    public static List<Recovery> recoveryLoadedOps(boolean superseded, boolean stopped, Double boundarySec) {
        List<Recovery> ops = new ArrayList<>();
        if (superseded) return Collections.unmodifiableList(ops);
        if (boundarySec != null) ops.add(Recovery.ARM_OUT_POINT);
        if (!stopped) ops.add(Recovery.PLAY);
        return Collections.unmodifiableList(ops);
    }

    /** {@code recoveryFailedOps({superseded, stopped})}: only a failure somebody is still waiting on is reported. */
    public static List<Recovery> recoveryFailedOps(boolean superseded, boolean stopped) {
        return superseded || stopped ? Collections.<Recovery>emptyList() : Collections.singletonList(Recovery.REPORT);
    }
}

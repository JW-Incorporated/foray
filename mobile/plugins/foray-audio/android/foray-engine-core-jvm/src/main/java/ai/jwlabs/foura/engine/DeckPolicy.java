package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

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
 * <p>A-25 ported the rest of deck-policy.js with the ExoPlayer deck (foray-audio's
 * {@code ExoDeck}), the JVM twins of Policy/DeckPolicyOutPoint.swift and
 * Policy/DeckPolicyReadings.swift:
 * <ul>
 *   <li>THE NATIVE OUT-POINT ({@link #outPointStep}, the {@code outpoint} family): three
 *       layers and a windowed watchdog, never early in any of them;
 *   <li>THE DECK'S GUARDS ({@link #deckSeekTarget}, {@link #deckVolume},
 *       {@link #deckDuration}, {@link #deckReportedRate}, the {@code deck} family's
 *       {@code deck-readings});
 *   <li>THE STANDBY DECK'S DECISIONS ({@link #prefetchDecision}, {@link #warmPromotion} and
 *       the rest of the handover, the {@code deck} family's {@code deck-pair}), which the
 *       Android deck pair (A-40) will ask exactly as the Swift DeckPair does.
 * </ul>
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

    // ==== THE NATIVE OUT-POINT (the outpoint family; Swift DeckPolicyOutPoint.swift) ====
    //
    // Plan §4.3, P-2. The first layer to fire wins, per load token:
    //   1. endTime: the player stops itself at the boundary (AVPlayer's
    //      forwardPlaybackEndTime; ExoDeck says which Media3 mechanism stands in for it);
    //   2. boundary: a position-triggered callback at the same instant;
    //   3. watchdog: ONE timer until OUT_POINT_WATCHDOG_WINDOW_SEC of wall clock before the
    //      predicted crossing, then a poll every OUT_POINT_WATCHDOG_POLL_MS inside that
    //      window only, re-armed on every seek and every rate change.
    // NEVER EARLY, IN EVERY LAYER: a report before the playhead reached the boundary stops
    // nothing (outPoint.early:), and the watchdog is re-armed from where the playhead is.

    /** {@code OUT_POINT_WATCHDOG_WINDOW_SEC}: how much WALL clock before the boundary the watchdog starts polling. */
    public static final double OUT_POINT_WATCHDOG_WINDOW_SEC = EngineConstants.DeckPolicy.OUT_POINT_WATCHDOG_WINDOW_SEC;
    /** {@code OUT_POINT_WATCHDOG_POLL_MS}: the poll inside the window. */
    public static final double OUT_POINT_WATCHDOG_POLL_MS = EngineConstants.DeckPolicy.OUT_POINT_WATCHDOG_POLL_MS;

    /** {@code OUT_POINT_LAYER}: the three layers, as they name themselves in the op log and the {@code outPoint} row. */
    public enum OutPointLayer {
        END_TIME(EngineConstants.DeckPolicy.OutPointLayer.END_TIME),
        BOUNDARY(EngineConstants.DeckPolicy.OutPointLayer.BOUNDARY),
        WATCHDOG(EngineConstants.DeckPolicy.OutPointLayer.WATCHDOG);

        public final String token;

        OutPointLayer(String token) {
            this.token = token;
        }
    }

    /** {@code WATCHDOG_WAKE}: what a watchdog wake does. */
    public enum WatchdogWake {
        /** The playhead has reached the boundary: stop, attributed to the watchdog. */
        STOP(EngineConstants.DeckPolicy.WatchdogWake.STOP),
        /** Not there yet: arm again for what is left. */
        REARM(EngineConstants.DeckPolicy.WatchdogWake.REARM);

        public final String token;

        WatchdogWake(String token) {
            this.token = token;
        }
    }

    /**
     * {@code watchdogDelayMs({outPointSec, atSec, rate, armed, paused})}: how long, in
     * WALL-CLOCK ms, to arm the watchdog's one timer for, or null for no timer (no finite
     * boundary, not armed, paused, or the playhead already at or past it). Outside the
     * window: the time until the window opens, rounded UP. Inside it: one poll, never later
     * than the predicted crossing, never below the timer floor.
     */
    public static Double watchdogDelayMs(Double outPointSec, double atSec, Double rate, boolean armed, boolean paused) {
        if (outPointSec == null || !Rows.isFinite(outPointSec) || !armed || paused) return null;
        if (!(atSec < outPointSec)) return null;
        double remainingWallSec = (outPointSec - atSec) / deckRate(rate);
        double untilWindowSec = remainingWallSec - OUT_POINT_WATCHDOG_WINDOW_SEC;
        if (untilWindowSec > 0) return Math.ceil(untilWindowSec * 1000);
        return JSMath.max(OUT_POINT_MIN_TIMER_MS, JSMath.min(OUT_POINT_WATCHDOG_POLL_MS, Math.ceil(remainingWallSec * 1000)));
    }

    /** {@code watchdogWakeAction({atSec, outPointSec})}: the wake re-reads the playhead and stops only on a genuine crossing. */
    public static WatchdogWake watchdogWakeAction(double atSec, double outPointSec) {
        return atSec >= outPointSec ? WatchdogWake.STOP : WatchdogWake.REARM;
    }

    /** {@code outPointOvershootMs({atSec, outPointSec})}: how far past the boundary a stop landed, in whole ms of CONTENT. Never negative. */
    public static double outPointOvershootMs(double atSec, double outPointSec) {
        return JSMath.max(0, JSMath.round((atSec - outPointSec) * 1000));
    }

    /**
     * The watch {@link #outPointStep} reduces over; {@code new OutPointWatch()} is
     * {@code initialOutPointWatch()}. A small mutable value: the step copies it and never
     * changes the caller's.
     */
    public static final class OutPointWatch {
        public int token;
        /** The boundary in the source's seconds, null for an unbounded item. */
        public Double outPointSec;
        /** The boundary is ahead of the playhead (layers 1 and 2 hold it). */
        public boolean armed;
        /** A layer stopped this token. */
        public boolean fired;
        public boolean playing;
        /** The deck's rate, already through {@link #deckRate}. */
        public double rate = 1;
        /** When the watchdog's one timer comes due, null when none is armed. */
        public Double timerDueMs;

        public OutPointWatch copy() {
            OutPointWatch c = new OutPointWatch();
            c.token = token;
            c.outPointSec = outPointSec;
            c.armed = armed;
            c.fired = fired;
            c.playing = playing;
            c.rate = rate;
            c.timerDueMs = timerDueMs;
            return c;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof OutPointWatch w && w.token == token && Objects.equals(w.outPointSec, outPointSec)
                    && w.armed == armed && w.fired == fired && w.playing == playing
                    && Double.compare(w.rate, rate) == 0 && Objects.equals(w.timerDueMs, timerDueMs);
        }

        @Override
        public int hashCode() {
            return Objects.hash(token, outPointSec, armed, fired, playing, rate, timerDueMs);
        }

        @Override
        public String toString() {
            return "OutPointWatch[token=" + token + ", outPointSec=" + outPointSec + ", armed=" + armed + ", fired=" + fired
                    + ", playing=" + playing + ", rate=" + rate + ", timerDueMs=" + timerDueMs + "]";
        }
    }

    /** An event the watch reduces. Each carries the playhead ({@code atSec}) and, where time matters, the wall clock. */
    public sealed interface OutPointEvent permits OutPointEvent.Load, OutPointEvent.Play, OutPointEvent.Pause, OutPointEvent.Seek,
            OutPointEvent.Rate, OutPointEvent.Timer, OutPointEvent.Layer, OutPointEvent.Ended {
        /**
         * A new item and token; the deck is paused after a load. A boundary that is not a
         * finite number, or at or behind the in-point, is not armed: the item free-plays.
         */
        record Load(int token, Double outPointSec, double atSec) implements OutPointEvent {}

        record Play(double atSec, double nowMs) implements OutPointEvent {}

        record Pause(double atSec) implements OutPointEvent {}

        /** Re-derives {@code armed} from the new playhead (a scrub past frees the item; a scrub back re-arms it). */
        record Seek(double atSec, double nowMs) implements OutPointEvent {}

        /** {@code rate} null is any value that is not a number (1x). */
        record Rate(Double rate, double atSec, double nowMs) implements OutPointEvent {}

        /** The watchdog's timer came due. */
        record Timer(double atSec, double nowMs) implements OutPointEvent {}

        /** Layer 1 or 2 reported the boundary for {@code token}. */
        record Layer(OutPointLayer layer, int token, double atSec, double nowMs) implements OutPointEvent {}

        /** The FILE ran out before the boundary: the item's one, natural, end. */
        record Ended(double atSec) implements OutPointEvent {}
    }

    /** What the native deck is commanded to do; {@link #token()} is the op-log spelling. */
    public sealed interface OutPointOp permits OutPointOp.EndTime, OutPointOp.Boundary, OutPointOp.WatchdogArm,
            OutPointOp.WatchdogCancel, OutPointOp.Stop, OutPointOp.Early, OutPointOp.Stale, OutPointOp.EndedNatural {
        /** Set (or clear, null) layer 1. */
        record EndTime(Double sec) implements OutPointOp {}

        /** Set (or clear, null) layer 2. */
        record Boundary(Double sec) implements OutPointOp {}

        record WatchdogArm(double ms) implements OutPointOp {}

        record WatchdogCancel() implements OutPointOp {}

        /** Pause the deck and report the item's end, attributed to {@code layer}. */
        record Stop(OutPointLayer layer, double overshootMs) implements OutPointOp {}

        /** A report before the boundary: nothing stops. */
        record Early(OutPointLayer layer) implements OutPointOp {}

        /** A report for another token, an unarmed boundary, or after the stop. */
        record Stale(OutPointLayer layer) implements OutPointOp {}

        /** The file ran out first: the item's one, natural, end. */
        record EndedNatural() implements OutPointOp {}

        default String token() {
            return switch (this) {
                case EndTime e -> "endTime:" + num(e.sec());
                case Boundary b -> "boundary:" + num(b.sec());
                case WatchdogArm a -> "watchdog.arm:" + num(a.ms());
                case WatchdogCancel c -> "watchdog.cancel";
                case Stop s -> "outPoint.stop:" + s.layer().token + ":" + num(s.overshootMs());
                case Early e -> "outPoint.early:" + e.layer().token;
                case Stale s -> "outPoint.stale:" + s.layer().token;
                case EndedNatural n -> "ended:natural";
            };
        }

        private static String num(Double value) {
            return value == null ? "null" : JSWriter.numberToString(value);
        }
    }

    /** One step of the out-point reducer: the next watch and the ops, in order. */
    public record OutPointStep(OutPointWatch state, List<OutPointOp> ops) {
        public OutPointStep {
            ops = Collections.unmodifiableList(new ArrayList<>(ops));
        }
    }

    /** {@code outPointStep(state, event)}: the native out-point as a reducer. */
    public static OutPointStep outPointStep(OutPointWatch state, OutPointEvent event) {
        List<OutPointOp> ops = new ArrayList<>();
        OutPointWatch next = state.copy();
        switch (event) {
            case OutPointEvent.Load e -> {
                Double outPointSec = e.outPointSec() != null && Rows.isFinite(e.outPointSec()) ? e.outPointSec() : null;
                boolean armed = outPointSec != null && e.atSec() < outPointSec;
                if (state.timerDueMs != null) ops.add(new OutPointOp.WatchdogCancel());
                ops.addAll(boundaryOps(armed, outPointSec));
                next.token = e.token();
                next.outPointSec = outPointSec;
                next.armed = armed;
                next.fired = false;
                next.playing = false;
                next.timerDueMs = null;
                return new OutPointStep(next, ops);
            }
            case OutPointEvent.Play e -> {
                if (state.fired) return new OutPointStep(next, ops);
                next.playing = true;
                return new OutPointStep(rearmWatchdog(next, e.atSec(), e.nowMs(), ops), ops);
            }
            case OutPointEvent.Pause e -> {
                if (state.timerDueMs != null) ops.add(new OutPointOp.WatchdogCancel());
                next.playing = false;
                next.timerDueMs = null;
                return new OutPointStep(next, ops);
            }
            case OutPointEvent.Seek e -> {
                boolean armed = state.outPointSec != null && e.atSec() < state.outPointSec;
                if (armed != state.armed) ops.addAll(boundaryOps(armed, state.outPointSec));
                next.armed = armed;
                next.fired = armed ? false : state.fired;
                return new OutPointStep(rearmWatchdog(next, e.atSec(), e.nowMs(), ops), ops);
            }
            case OutPointEvent.Rate e -> {
                next.rate = deckRate(e.rate());
                return new OutPointStep(rearmWatchdog(next, e.atSec(), e.nowMs(), ops), ops);
            }
            case OutPointEvent.Timer e -> {
                Double due = state.timerDueMs;
                if (due == null || !(e.nowMs() >= due)) return new OutPointStep(next, ops);
                next.timerDueMs = null;
                if (!next.playing || !next.armed || next.fired || next.outPointSec == null) return new OutPointStep(next, ops);
                if (watchdogWakeAction(e.atSec(), next.outPointSec) == WatchdogWake.STOP) {
                    return new OutPointStep(stopAt(next, OutPointLayer.WATCHDOG, e.atSec(), ops), ops);
                }
                return new OutPointStep(rearmWatchdog(next, e.atSec(), e.nowMs(), ops), ops);
            }
            case OutPointEvent.Layer e -> {
                if (e.token() != state.token || !state.armed || state.fired || state.outPointSec == null) {
                    ops.add(new OutPointOp.Stale(e.layer()));
                    return new OutPointStep(next, ops);
                }
                if (e.atSec() < state.outPointSec) {
                    ops.add(new OutPointOp.Early(e.layer()));
                    return new OutPointStep(rearmWatchdog(next, e.atSec(), e.nowMs(), ops), ops);
                }
                return new OutPointStep(stopAt(next, e.layer(), e.atSec(), ops), ops);
            }
            case OutPointEvent.Ended e -> {
                if (state.timerDueMs != null) ops.add(new OutPointOp.WatchdogCancel());
                ops.add(new OutPointOp.EndedNatural());
                next.fired = true;
                next.playing = false;
                next.timerDueMs = null;
                return new OutPointStep(next, ops);
            }
        }
    }

    /** Layers 1 and 2 hold the boundary while it is armed and are cleared when it is not. */
    private static List<OutPointOp> boundaryOps(boolean armed, Double outPointSec) {
        Double value = armed ? outPointSec : null;
        return Arrays.<OutPointOp>asList(new OutPointOp.EndTime(value), new OutPointOp.Boundary(value));
    }

    /** Cancel the one timer (if any), then arm it again from here (if it should be armed at all). */
    private static OutPointWatch rearmWatchdog(OutPointWatch next, double atSec, double nowMs, List<OutPointOp> ops) {
        if (next.timerDueMs != null) {
            ops.add(new OutPointOp.WatchdogCancel());
            next.timerDueMs = null;
        }
        if (next.fired) return next;
        Double delay = watchdogDelayMs(next.outPointSec, atSec, next.rate, next.armed, !next.playing);
        if (delay == null) return next;
        ops.add(new OutPointOp.WatchdogArm(delay));
        next.timerDueMs = nowMs + delay;
        return next;
    }

    private static OutPointWatch stopAt(OutPointWatch next, OutPointLayer layer, double atSec, List<OutPointOp> ops) {
        if (next.timerDueMs != null) ops.add(new OutPointOp.WatchdogCancel());
        ops.add(new OutPointOp.Stop(layer, outPointOvershootMs(atSec, next.outPointSec != null ? next.outPointSec : atSec)));
        next.fired = true;
        next.playing = false;
        next.timerDueMs = null;
        return next;
    }

    // ==== THE DECK'S GUARDS (the deck family's deck-readings; Swift DeckPolicyReadings.swift) ====

    /** {@code deckSeekTarget(seconds)}: where a seek goes, or null when the value is junk (not a number, not finite, or negative). */
    public static Double deckSeekTarget(Double seconds) {
        if (seconds == null || !Rows.isFinite(seconds) || !(seconds >= 0)) return null;
        return seconds;
    }

    /** {@code deckVolume(v)}: {@code Math.min(1, Math.max(0, Number(v) || 0))}; the argument is {@code Number(v)} already. */
    public static double deckVolume(double number) {
        double value = Double.isNaN(number) ? 0 : number;
        return JSMath.min(1, JSMath.max(0, value));
    }

    /** {@code deckDuration(d)}: a finite number, else null (never NaN). */
    public static Double deckDuration(Double duration) {
        if (duration == null || !Rows.isFinite(duration)) return null;
        return duration;
    }

    /**
     * {@code deckReportedRate({elementRate, pendingRate})}: the element's own rate when it is a
     * usable one (a finite number above 0), else the rate we asked for.
     */
    public static Double deckReportedRate(Double elementRate, Double pendingRate) {
        if (elementRate != null && Rows.isFinite(elementRate) && elementRate > 0) return elementRate;
        return pendingRate;
    }

    // ==== THE STANDBY DECK (the deck family's deck-pair; the Android deck pair is A-40's) ====

    /** {@code warmOffset(startOffset)}: the in-point a warm load is parked at, a positive finite offset, else 0. */
    public static double warmOffset(Double startOffset) {
        if (startOffset == null || !Rows.isFinite(startOffset) || !(startOffset > 0)) return 0;
        return startOffset;
    }

    /** A load held warm on the standby deck. */
    public record Warm(String itemId, String url, double offsetSec, boolean ready, boolean failed) {}

    /** {@code prefetchDecision(...)}'s answers. */
    public enum PrefetchDecision {
        /** No standby deck, parked, released or stood down. */
        UNAVAILABLE("unavailable"),
        /** Nothing to fetch. */
        NO_URL("no-url"),
        /** The next item is in the source the player already holds: the same-source seek covers that seam. */
        SAME_EPISODE("same-episode"),
        /** The standby deck already holds exactly this (url, offset). */
        ALREADY("already"),
        /** Warm it. */
        START("start");

        public final String token;

        PrefetchDecision(String token) {
            this.token = token;
        }
    }

    /** {@code prefetchDecision({available, url, currentUrl, warm, offsetSec})}. */
    public static PrefetchDecision prefetchDecision(boolean available, String url, String currentUrl, Warm warm, double offsetSec) {
        if (!available) return PrefetchDecision.UNAVAILABLE;
        if (url == null || url.isEmpty()) return PrefetchDecision.NO_URL;
        if (url.equals(currentUrl)) return PrefetchDecision.SAME_EPISODE;
        if (warm != null && url.equals(warm.url()) && warm.offsetSec() == offsetSec && !warm.failed()) return PrefetchDecision.ALREADY;
        return PrefetchDecision.START;
    }

    /** {@code warmPromotion(...)}'s answers: promote, or why not. */
    public enum Promotion {
        PROMOTE("promote"),
        NO_WARM("none"),
        NOT_READY("not-ready"),
        FAILED("failed"),
        DIFFERENT_ITEM("different-item"),
        WRONG_OFFSET("wrong-offset"),
        BUFFER_GONE("buffer-gone"),
        DRIFTED("drifted");

        public final String token;

        Promotion(String token) {
            this.token = token;
        }
    }

    /**
     * {@code warmPromotion({warm, url, offsetSec, canPlay, atSec})}: may the warm deck BECOME the
     * player for the load in front of it? Readiness is re-asserted at the boundary, never trusted.
     */
    public static Promotion warmPromotion(Warm warm, String url, double offsetSec, boolean canPlay, Double atSec) {
        if (warm == null) return Promotion.NO_WARM;
        if (warm.failed()) return Promotion.FAILED;
        if (!warm.ready()) return Promotion.NOT_READY;
        if (!warm.url().equals(url)) return Promotion.DIFFERENT_ITEM;
        if (warm.offsetSec() != offsetSec) return Promotion.WRONG_OFFSET;
        if (!canPlay) return Promotion.BUFFER_GONE;
        if (Math.abs((atSec != null ? atSec : 0) - offsetSec) > SETTLE_NEAR_SEC) return Promotion.DRIFTED;
        return Promotion.PROMOTE;
    }

    /**
     * {@code warmSettled({offsetSec, atSec, canPlay})}: a warm load is READY only once the
     * playhead is at its in-point AND the deck can produce audio. An in-point of 0 needs no seek.
     */
    public static boolean warmSettled(double offsetSec, Double atSec, boolean canPlay) {
        boolean near = offsetSec == 0 || Math.abs((atSec != null ? atSec : 0) - offsetSec) <= SETTLE_NEAR_SEC;
        return near && canPlay;
    }

    /** One step of the handover ({@code handoverSteps()}), as the op log spells it. */
    public enum HandoverStep {
        DETACH_OUTGOING("detach-outgoing"),
        PAUSE_OUTGOING("pause-outgoing"),
        SWAP_ROLES("swap-roles"),
        ATTACH_INCOMING("attach-incoming"),
        ADOPT_IDENTITY("adopt-identity"),
        CARRY_VOLUME("carry-volume"),
        CARRY_RATE("carry-rate");

        public final String token;

        HandoverStep(String token) {
            this.token = token;
        }
    }

    /**
     * {@code handoverSteps()}: THE ORDER IS THE SAFETY PROPERTY. The outgoing deck stops
     * reporting and is paused BEFORE the roles swap, so no instant has two decks un-paused.
     */
    public static List<HandoverStep> handoverSteps() {
        return Collections.unmodifiableList(Arrays.asList(HandoverStep.values()));
    }

    /** {@code discardFreesBuffer(cause)}: forgetting a warm load drops its buffer only at {@code release}. */
    public static boolean discardFreesBuffer(String cause) {
        return "release".equals(cause);
    }

    /** {@code playRefusalAction(...)}'s answers. */
    public enum RefusalAction {
        RECOVER("recover"),
        REPORT("report");

        public final String token;

        RefusalAction(String token) {
            this.token = token;
        }
    }

    /**
     * {@code playRefusalAction({errorName, handoverUnproven, isPlayer = true, released = false})}:
     * recover only an autoplay refusal of a handover not yet proven by a {@code playing}, on the
     * live player of an unreleased deck. (ExoPlayer has no autoplay policy; the rule is ported so
     * the family is whole.)
     */
    public static RefusalAction playRefusalAction(String errorName, boolean handoverUnproven, boolean isPlayer, boolean released) {
        if (released || !isPlayer || !handoverUnproven) return RefusalAction.REPORT;
        return "NotAllowedError".equals(errorName) ? RefusalAction.RECOVER : RefusalAction.REPORT;
    }

    /** {@code unexplainedPauseAction(...)}'s answers. */
    public enum UnexplainedPause {
        /** The pause we caused. */
        OWN("own"),
        /** The file ran out. */
        RAN_OUT("ran-out"),
        /** Tell the core (it reconciles). */
        REPORT("report"),
        /** Report AND stop warming for good: a warm load was in flight. */
        STAND_DOWN("stand-down");

        public final String token;

        UnexplainedPause(String token) {
            this.token = token;
        }
    }

    /** {@code unexplainedPauseAction({expected, ended, warmInFlight})}. */
    public static UnexplainedPause unexplainedPauseAction(boolean expected, boolean ended, boolean warmInFlight) {
        if (expected) return UnexplainedPause.OWN;
        if (ended) return UnexplainedPause.RAN_OUT;
        return warmInFlight ? UnexplainedPause.STAND_DOWN : UnexplainedPause.REPORT;
    }

    /**
     * {@code prefetchWindowOpens({available, outPointSec, armed, paused, atSec, rate, leadSec,
     * alreadyOpened = false})}: only while the player is AUDIBLE, with an armed boundary, once
     * per boundary, and within {@code leadSec} of WALL clock.
     */
    public static boolean prefetchWindowOpens(boolean available, Double outPointSec, boolean armed, boolean paused, double atSec,
            Double rate, double leadSec, boolean alreadyOpened) {
        if (!available || outPointSec == null || !armed || paused || alreadyOpened) return false;
        return !((outPointSec - atSec) / deckRate(rate) > leadSec);
    }

    /**
     * When, in WALL-CLOCK ms from now, the prefetch window will open for a deck playing toward
     * {@code outPointSec}: 0 when it is open already, null when it cannot open (the same guards as
     * {@link #prefetchWindowOpens}). Rounded up, so the timer never fires before the window is open.
     */
    public static Double prefetchWindowDelayMs(boolean available, Double outPointSec, boolean armed, boolean paused, double atSec,
            Double rate, double leadSec, boolean alreadyOpened) {
        if (!available || outPointSec == null || !Rows.isFinite(outPointSec) || !armed || paused || alreadyOpened
                || !(atSec < outPointSec)) {
            return null;
        }
        double untilSec = (outPointSec - atSec) / deckRate(rate) - leadSec;
        return untilSec <= 0 ? 0.0 : Math.ceil(untilSec * 1000);
    }
}

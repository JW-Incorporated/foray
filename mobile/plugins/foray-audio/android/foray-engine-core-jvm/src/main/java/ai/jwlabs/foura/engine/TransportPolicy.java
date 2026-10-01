package ai.jwlabs.foura.engine;

/**
 * The client layer's transport rules: the port of {@code player/transport-policy.js}
 * (the reference, whose comments carry each rule's reason), and the JVM twin of
 * {@code TransportPolicy} in ForayEngineCore (Policy/TransportPolicy.swift, NE-09). The
 * {@code transport} parity family is the contract.
 *
 * <p>QUIRKS ARE PORTED, NOT TIDIED ({@code skipTarget}'s {@code Number(offset || 0)}): a
 * change goes JS first, then a re-record, then this file. Every token is an enum whose
 * token is the generated {@link EngineConstants.Transport} value; every number is read
 * from the generated constants.
 */
public final class TransportPolicy {
    private TransportPolicy() {}

    /** {@code RESTART_WINDOW_SEC}: below this far into an item, previous means the one before. */
    public static final double RESTART_WINDOW_SEC = EngineConstants.Transport.RESTART_WINDOW_SEC;
    /** {@code SEEK_INSIDE_END_SEC}: how far inside an item's end a Foray-clock seek lands. */
    public static final double SEEK_INSIDE_END_SEC = EngineConstants.Transport.SEEK_INSIDE_END_SEC;
    /** {@code SEEK_END_GUARD_SEC}: an episode seek stops this far short of the end. */
    public static final double SEEK_END_GUARD_SEC = EngineConstants.Transport.SEEK_END_GUARD_SEC;
    /** {@code INTERRUPTION_REWIND_SEC}: how far back an OS interruption's should-resume picks the audio up. */
    public static final double INTERRUPTION_REWIND_SEC = EngineConstants.Transport.INTERRUPTION_REWIND_SEC;

    /** {@code TOGGLE}: what a play/pause press does. */
    public enum Toggle {
        PLAY_RESTORED(EngineConstants.Transport.Toggle.PLAY_RESTORED),
        START_OVER(EngineConstants.Transport.Toggle.START_OVER),
        NONE(EngineConstants.Transport.Toggle.NONE),
        LOAD(EngineConstants.Transport.Toggle.LOAD),
        RESUME(EngineConstants.Transport.Toggle.RESUME),
        PAUSE(EngineConstants.Transport.Toggle.PAUSE);

        public final String token;

        Toggle(String token) {
            this.token = token;
        }
    }

    /** {@code NUDGE}: what a 15 / 30 nudge inside a Foray does. */
    public enum Nudge {
        SEEK(EngineConstants.Transport.Nudge.SEEK),
        RESTART_LINE(EngineConstants.Transport.Nudge.RESTART_LINE),
        SKIP_LINE(EngineConstants.Transport.Nudge.SKIP_LINE),
        NONE(EngineConstants.Transport.Nudge.NONE);

        public final String token;

        Nudge(String token) {
            this.token = token;
        }
    }

    /** {@code PREVIOUS}: what "previous" does inside a Foray. */
    public enum Previous {
        ITEM_BEFORE(EngineConstants.Transport.Previous.ITEM_BEFORE),
        MANAGER(EngineConstants.Transport.Previous.MANAGER);

        public final String token;

        Previous(String token) {
            this.token = token;
        }
    }

    /** {@code SEEK}: where an episode seek goes. */
    public enum Seek {
        PEND(EngineConstants.Transport.Seek.PEND),
        SEEK(EngineConstants.Transport.Seek.SEEK);

        public final String token;

        Seek(String token) {
            this.token = token;
        }
    }

    /** {@code REMOTE_STOP}: what a stop from outside the page does. */
    public enum RemoteStop {
        CLOSE(EngineConstants.Transport.RemoteStop.CLOSE),
        PAUSE(EngineConstants.Transport.RemoteStop.PAUSE);

        public final String token;

        RemoteStop(String token) {
            this.token = token;
        }
    }

    /**
     * A queue item as these rules read it. A null number is every value
     * {@code typeof n === "number"} rejects; {@code hasAudioUrl}: {@code item.audio_url}
     * is truthy (a rendered narration has a file).
     */
    public record Item(Double startSec, Double endSec, Double authoredEndSec, Double durationSec, String kind,
                       boolean hasAudioUrl) {
        /**
         * {@code itemRuntimeSec(item)} (player/foray-queue.js): how long the item plays. A
         * slice's authored end (else its end) minus its start; else a positive
         * {@code duration_sec}; else 0.
         */
        public double runtimeSec() {
            Double end = isNum(authoredEndSec) ? authoredEndSec : endSec;
            if (isNum(startSec) && isNum(end) && end > startSec) return end - startSec;
            if (isNum(durationSec) && durationSec > 0) return durationSec;
            return 0;
        }
    }

    /** foray-queue.js / transport-policy.js {@code isNum}: a finite number. */
    static boolean isNum(Double value) {
        return value != null && Rows.isFinite(value);
    }

    /** JavaScript truthiness of a number: not 0 and not NaN (null is falsy). */
    static boolean truthy(Double value) {
        return value != null && value != 0 && !Double.isNaN(value);
    }

    // ---- play/pause

    /** {@code endedPlayAction({foray, stateType})}: a FINISHED Foray starts over; null when the ordinary resume applies. */
    public static Toggle endedPlayAction(boolean foray, String stateType) {
        return foray && "ended".equals(stateType) ? Toggle.START_OVER : null;
    }

    /**
     * {@code resolveToggle(...)}: the decision inside every play/pause press. The ORDER is
     * the rule: a restored bar wins; a finished Foray starts over; a press asking for what
     * the transport already is does nothing; then play loads an empty queue that has
     * something showing, or resumes; and pause pauses. {@code queueLength} is compared
     * with {@code === 0}, so null (not a number) is not 0.
     */
    public static Toggle resolveToggle(boolean want, boolean restored, boolean foray, String stateType, boolean running,
                                       boolean hasCurrent, Double queueLength) {
        if (want && restored) return Toggle.PLAY_RESTORED;
        if (want) {
            Toggle ended = endedPlayAction(foray, stateType);
            if (ended != null) return ended;
        }
        if (want == running) return Toggle.NONE;
        if (!want) return Toggle.PAUSE;
        if (hasCurrent && queueLength != null && queueLength == 0) return Toggle.LOAD;
        return Toggle.RESUME;
    }

    // ---- previous

    /**
     * {@code previousAction({index, positionSec, segmentStartSec})}: restart this item while
     * inside it, go to the one before in the first RESTART_WINDOW_SEC, measured from the
     * segment's own start ON THE FORAY'S CLOCK. A null {@code positionSec} is a jump in
     * flight and reads as deep inside (restart); a NaN start makes {@code into} NaN, which
     * is never below the window.
     */
    public static Previous previousAction(double index, Double positionSec, double segmentStartSec) {
        double into = positionSec != null ? positionSec - segmentStartSec : Double.POSITIVE_INFINITY;
        return index > 0 && into < RESTART_WINDOW_SEC ? Previous.ITEM_BEFORE : Previous.MANAGER;
    }

    /** {@code episodePreviousRestarts({positionSec})}: on an episode, previous RESTARTS from RESTART_WINDOW_SEC in. */
    public static boolean episodePreviousRestarts(double positionSec) {
        return positionSec >= RESTART_WINDOW_SEC;
    }

    // ---- skip and seek

    /**
     * {@code clampEpisodeTarget(seconds, dur)}: never below 0, never past
     * {@code dur - SEEK_END_GUARD_SEC}; null for a target that is not a finite number.
     * {@code seconds} is the value after {@code Number(seconds)}. A falsy duration is
     * "unknown": the target is only floored.
     */
    public static Double clampEpisodeTarget(double seconds, Double duration) {
        if (!Rows.isFinite(seconds)) return null;
        double floor = JSMath.max(0, seconds);
        if (!truthy(duration)) return floor;
        return JSMath.min(floor, JSMath.max(0, duration - SEEK_END_GUARD_SEC));
    }

    /**
     * {@code skipTarget({foray, positionSec, offsetSec, durationSec})}: where a 15 / 30
     * nudge lands. In a Foray the step is on the Foray's clock, floored at 0 and, given a
     * total, stopped SEEK_END_GUARD_SEC short of it; on an episode it is
     * {@code clampEpisodeTarget}. {@code Number(offsetSec || 0)}: a falsy offset is no step.
     */
    public static Double skipTarget(boolean foray, double positionSec, Double offsetSec, Double durationSec) {
        double offset = truthy(offsetSec) ? offsetSec : 0;
        if (foray) {
            double floor = JSMath.max(0, positionSec + offset);
            if (durationSec == null || !(durationSec > 0)) return floor;
            return JSMath.min(floor, JSMath.max(0, durationSec - SEEK_END_GUARD_SEC));
        }
        return clampEpisodeTarget(positionSec + offset, durationSec);
    }

    /**
     * {@code nudgeAction({offsetSec, landsInCurrentItem, narrationPlayhead, onLastItem})}: a
     * nudge that stays inside a spoken line says what it does (back re-speaks it, forward
     * skips it, forward from the LAST line does nothing); anything else is a seek.
     */
    public static Nudge nudgeAction(double offsetSec, boolean landsInCurrentItem, boolean narrationPlayhead,
                                    boolean onLastItem) {
        if (!(landsInCurrentItem && narrationPlayhead)) return Nudge.SEEK;
        if (offsetSec < 0) return Nudge.RESTART_LINE;
        return onLastItem ? Nudge.NONE : Nudge.SKIP_LINE;
    }

    /** {@code seekAction({restored, stateType})}: with nothing loaded to seek in, the target is written down as pending. */
    public static Seek seekAction(boolean restored, String stateType) {
        return restored || "idle".equals(stateType) || "ended".equals(stateType) ? Seek.PEND : Seek.SEEK;
    }

    // ---- the Foray clock to a source file's clock

    /**
     * {@code sourceOffsetFor(item, into)}: where in the element's own clock a point
     * {@code into} seconds into {@code item} lives; null when there is nothing to seek. At
     * least SEEK_INSIDE_END_SEC inside the item's end; a slice adds its start; a SPOKEN
     * narration (a tts item with no file) cannot start mid-sentence, so null; a rendered
     * one's file is the item, so {@code into} itself.
     */
    public static Double sourceOffset(Item item, Double into) {
        if (item == null || into == null || !Rows.isFinite(into)) return null;
        double length = item.runtimeSec();
        double inside = Rows.isFinite(length) && length > 0
                ? JSMath.min(JSMath.max(0, into), JSMath.max(0, length - SEEK_INSIDE_END_SEC))
                : JSMath.max(0, into);
        if (item.startSec() != null && Rows.isFinite(item.startSec())) return item.startSec() + inside;
        if (EngineConstants.QueueState.TTS.equals(item.kind()) && !item.hasAudioUrl()) return null;
        return inside;
    }

    /**
     * {@code scrubTarget(...)}'s answer. {@code reload}: the target needs its own load (another
     * item, nothing loaded, or a rendered line in {@code transitioning}, where the reducer refuses
     * a seek). {@code restart}: it lands in the SPOKEN line already sounding, which has no offset,
     * so the line is said again from the top.
     */
    public record Scrub(double index, boolean reload, boolean restart, Double offset) {}

    /**
     * {@code scrubTarget({at, item, currentIndex, stateType})}, once the Foray clock has said
     * where it lands. {@code at.index !== currentIndex}: a null {@code currentIndex} is
     * never the same index. M2 drive 2026-10-01: a line reached by its seam is
     * {@code transitioning}, so a same-index answer is never a seek there.
     */
    public static Scrub scrubTarget(double atIndex, Double into, Item item, Double currentIndex, String stateType) {
        Double offset = sourceOffset(item, into);
        boolean sameIndex = currentIndex != null && currentIndex == atIndex;
        boolean elsewhere = !sameIndex || "ended".equals(stateType) || "idle".equals(stateType);
        boolean restart = !elsewhere && offset == null;
        boolean reload = elsewhere || (!restart && "transitioning".equals(stateType));
        return new Scrub(atIndex, reload, restart, offset);
    }

    // ---- remote stop

    /**
     * {@code remoteStopAction(details)}: a stop from outside the page PAUSES, unless it is
     * the Android notification's own Stop ({@code details.close === true}), which closes.
     * Only a real {@code true} closes, so a car's stop can never blank the display.
     */
    public static RemoteStop remoteStopAction(Boolean close) {
        return Boolean.TRUE.equals(close) ? RemoteStop.CLOSE : RemoteStop.PAUSE;
    }

    // ---- interruption resume

    /**
     * {@code interruptionResumeOffset({playheadSec, startSec})}: INTERRUPTION_REWIND_SEC
     * back, never before the item's own start (a slice's in-point, else 0:00). Null when
     * the playhead is not a finite number.
     */
    public static Double interruptionResumeOffset(Double playheadSec, Double startSec) {
        if (playheadSec == null || !Rows.isFinite(playheadSec)) return null;
        double floor = startSec != null && Rows.isFinite(startSec) ? startSec : 0;
        return JSMath.max(floor, playheadSec - INTERRUPTION_REWIND_SEC);
    }
}

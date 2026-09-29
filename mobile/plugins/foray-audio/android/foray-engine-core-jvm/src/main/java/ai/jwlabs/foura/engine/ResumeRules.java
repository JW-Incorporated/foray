package ai.jwlabs.foura.engine;

/**
 * Where to resume, what a saved position looks like, and WHEN one is written: the port of
 * the pure rules in {@code player/position-store.js} ({@code resumeOffsetFor},
 * {@code positionRow}, {@code positionEvent}), of the manager's tick throttle
 * ({@code positionTickDue}, {@code player/queue-manager.js}) and of the Foray store's
 * ({@code forayWriteDue}, {@code player/foray-progress.js}). The JVM twin of
 * {@code ResumeRules} in ForayEngineCore (Policy/ResumeRules.swift, NE-09); the
 * {@code resume-rules} parity family is the contract, and those modules' comments carry
 * the reasons (pocketing the phone loses at most 15 s; an unknown position never
 * overwrites a known one).
 *
 * <p>Every number is READ from the generated {@link EngineConstants}. A null numeric
 * parameter stands for every value {@code typeof n === "number"} rejects.
 */
public final class ResumeRules {
    private ResumeRules() {}

    /** {@code MIN_RESUME_SEC}: under this there is nothing worth resuming to. */
    public static final double MIN_RESUME_SEC = EngineConstants.PositionStore.MIN_RESUME_SEC;
    /** {@code NEAR_END_SEC}: inside this of the end, the episode is finished. */
    public static final double NEAR_END_SEC = EngineConstants.PositionStore.NEAR_END_SEC;
    /** {@code POSITION_EVENT_EVERY_SEC}: at most one position event per this many media seconds per item. */
    public static final double POSITION_EVENT_EVERY_SEC = EngineConstants.PositionStore.POSITION_EVENT_EVERY_SEC;
    /** {@code POSITION_INTERVAL_MS}: the episode's periodic write. */
    public static final double POSITION_INTERVAL_MS = EngineConstants.QueueManager.POSITION_INTERVAL_MS;
    /** {@code POSITION_MIN_DELTA_SEC}: how far the playhead must move on one item before a TICK writes again. */
    public static final double POSITION_MIN_DELTA_SEC = EngineConstants.QueueManager.POSITION_MIN_DELTA_SEC;
    /** foray-progress.js {@code SAVE_EVERY_SEC}: a Foray's clock is written this often. */
    public static final double FORAY_WRITE_EVERY_SEC = EngineConstants.ForayProgress.SAVE_EVERY_SEC;

    // ---- where to resume

    /** A stored {@code cp_pos:} row as the store's {@code load} returns it ({@code seconds} validated there). */
    public record StoredPosition(double seconds, Double duration) {}

    /**
     * {@code resumeOffsetFor(record, {duration})}. No row: 0; under MIN_RESUME_SEC: 0;
     * inside NEAR_END_SEC of the end: 0; otherwise the stored seconds. The caller's
     * duration wins and the row's stands in ({@code ??}: only a MISSING caller duration
     * defers), and the end check reads it by truthiness, so 0 and NaN skip it.
     */
    public static double resumeOffset(StoredPosition record, Double duration) {
        if (record == null) return 0;
        if (record.seconds() < MIN_RESUME_SEC) return 0;
        Double dur = duration != null ? duration : record.duration();
        if (dur != null && dur != 0 && !Double.isNaN(dur) && record.seconds() > dur - NEAR_END_SEC) return 0;
        return record.seconds();
    }

    // ---- what a saved position looks like

    public static final String LOCAL_SOURCE = "local";

    /** The row {@code save} writes. {@code duration} is finite or null; {@code updatedAt} null is the JS undefined. */
    public record PositionRow(double seconds, Double duration, String updatedAt, String source) {}

    /**
     * {@code positionRow(id, seconds, meta, updatedAt)}: the row, or null when there is
     * nothing to write (no id, or a position that is not a finite, non-negative number).
     */
    public static PositionRow positionRow(String id, Double seconds, Double duration, String updatedAt) {
        if (id == null || id.isEmpty() || seconds == null || !Rows.isFinite(seconds) || seconds < 0) return null;
        Double kept = duration != null && Rows.isFinite(duration) ? duration : null;
        return new PositionRow(seconds, kept, updatedAt, LOCAL_SOURCE);
    }

    // ---- the once-a-minute position event

    /** {@code mark}: what to remember as the last-emitted position (UNROUNDED); {@code seconds}: {@code Math.round}ed. */
    public record PositionEvent(double mark, double seconds, Double duration) {}

    /**
     * {@code positionEvent(lastEmitted, seconds, duration)}: at most once every
     * POSITION_EVENT_EVERY_SEC media seconds per item, and always when nothing (or 0) was
     * emitted before; null = no event.
     */
    public static PositionEvent positionEvent(Double lastEmitted, double seconds, Double duration) {
        double last = lastEmitted != null ? lastEmitted : 0;
        if (!(seconds - last >= POSITION_EVENT_EVERY_SEC || last == 0)) return null;
        return new PositionEvent(seconds, JSMath.round(seconds), duration);
    }

    // ---- when a tick writes

    /** The last write the tick throttle measures from ({@code _lastPersisted}). */
    public record LastWrite(String id, Double seconds) {}

    /**
     * {@code positionTickDue(last, id, seconds)}: never for a clock that is not a finite
     * number; not while the SAME item has moved less than POSITION_MIN_DELTA_SEC (either
     * direction) since the last write; at once for another item or a first write. A
     * missing last position is NaN in JS, and NaN is never less than anything, so it is due.
     */
    public static boolean positionTickDue(LastWrite last, String id, Double seconds) {
        if (seconds == null || !Rows.isFinite(seconds)) return false;
        if (last != null && id.equals(last.id())) {
            double lastSeconds = last.seconds() != null ? last.seconds() : Double.NaN;
            if (Math.abs(seconds - lastSeconds) < POSITION_MIN_DELTA_SEC) return false;
        }
        return true;
    }

    /**
     * {@code forayWriteDue(lastWritten, elapsedSec, {everySec, force})}: never for an
     * elapsed value that is not a finite number; always when forced or on the first write;
     * otherwise once the CLOCK has moved {@code everySec}. {@code !(d < everySec)} rather
     * than {@code d >= everySec}: the two differ on NaN.
     */
    public static boolean forayWriteDue(Double lastWritten, Double elapsedSec, double everySec, boolean force) {
        if (elapsedSec == null || !Rows.isFinite(elapsedSec)) return false;
        if (force || lastWritten == null) return true;
        return !(Math.abs(elapsedSec - lastWritten) < everySec);
    }

    /** {@link #forayWriteDue} with its defaults ({@code everySec = SAVE_EVERY_SEC}, not forced). */
    public static boolean forayWriteDue(Double lastWritten, Double elapsedSec) {
        return forayWriteDue(lastWritten, elapsedSec, FORAY_WRITE_EVERY_SEC, false);
    }
}

package ai.jwlabs.foura.engine;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The Foray's resume rules: the JVM twin of the {@code ResumeRules} extension in ForayEngineCore
 * (Policy/ForayProgressRules.swift), card A-40, and like it the port of the rules in
 * {@code player/foray-progress.js} the engine needs to resume a Foray and to write its
 * {@code cp_foray:<id>} row: the thresholds, the row's validity, the resume decision with #40's
 * drift verdicts, the throttled writer and the labels. The {@code foray-progress} family (the pure
 * half as calls, the storage half through {@code player/parity/foray-store.js}) is the contract.
 *
 * <p>The row's exact bytes are {@link Rows#forayProgress} / {@link Rows#makeForayProgress}; the
 * 5-second cadence is {@link ResumeRules#forayWriteDue}. A row here is TYPED: each field is null
 * where the stored JSON value is absent OR of a type the JS rule rejects.
 */
public final class ForayProgressRules {
    private ForayProgressRules() {}

    /** foray-progress.js {@code MIN_RESUME_SEC}: under this, nothing to resume. */
    public static final double MIN_RESUME_SEC = EngineConstants.ForayProgress.MIN_RESUME_SEC;
    /** {@code NEAR_END_SEC}: inside this of the end, the Foray is finished. */
    public static final double NEAR_END_SEC = EngineConstants.ForayProgress.NEAR_END_SEC;
    /** {@code MAX_AGE_H}: a dated row older than this is left out of the list. */
    public static final double MAX_AGE_H = EngineConstants.ForayProgress.MAX_AGE_H;
    /** {@code DRIFT_TOLERANCE_SEC}. */
    public static final double DRIFT_TOLERANCE_SEC = EngineConstants.ForayProgress.DRIFT_TOLERANCE_SEC;
    /** {@code PLAYED_LABEL}. */
    public static final String PLAYED_LABEL = EngineConstants.ForayProgress.PLAYED_LABEL;

    /** The five {@code DRIFT_*} verdicts (#40, FD-05). */
    public enum Drift {
        UNVERIFIED(EngineConstants.ForayProgress.DRIFT_UNVERIFIED),
        EXACT(EngineConstants.ForayProgress.DRIFT_EXACT),
        MOVED(EngineConstants.ForayProgress.DRIFT_MOVED),
        DROPPED(EngineConstants.ForayProgress.DRIFT_DROPPED),
        UNANCHORED(EngineConstants.ForayProgress.DRIFT_UNANCHORED);

        public final String token;

        Drift(String token) {
            this.token = token;
        }
    }

    /** A {@code cp_foray} row as the rules read it (null: absent, or not the type the rule tests for). */
    public record ForayRow(String forayId, Double elapsedSec, Double totalSec, Double index, String segmentId, Double intoSec) {}

    /**
     * {@code isProgressRecord(r)}: a row names a Foray and carries a finite clock (elapsed >= 0,
     * total > 0). {@code segment_id} and {@code into_sec} are NOT required. Null is no row.
     */
    public static boolean isProgressRecord(ForayRow row) {
        if (row == null || row.forayId() == null || !Rows.nonEmpty(row.forayId())) return false;
        Double elapsed = row.elapsedSec();
        Double total = row.totalSec();
        return elapsed != null && Double.isFinite(elapsed) && elapsed >= 0 && total != null && Double.isFinite(total) && total > 0;
    }

    /** One item of the LIVE running order ({@code progressSegments}), as {@code reconcileSegment} reads it. */
    public record LiveSegment(String id, Double startSec, Double durationSec) {
        /** {@code isSegmentDescriptor}: a finite start >= 0 and a finite length >= 0. */
        boolean isDescriptor() {
            return startSec != null && Double.isFinite(startSec) && startSec >= 0 && durationSec != null
                    && Double.isFinite(durationSec) && durationSec >= 0;
        }
    }

    /** What {@code reconcileSegment} answers: {@code elapsedSec} and the LIVE {@code index} for exact and moved only. */
    public record Reconciled(Drift drift, Double elapsedSec, Integer index) {}

    /**
     * {@code reconcileSegment(record, segments, {present})}: what the stored row means against the
     * running order as it exists now. {@code present: false} is checked first. A list with no
     * usable entry is no live order. The anchor is found by id among the usable entries, but its
     * index counts the caller's own array. The clock is re-derived from where that segment starts
     * now, clamped one tolerance INSIDE the segment.
     */
    public static Reconciled reconcileSegment(ForayRow row, List<LiveSegment> segments, boolean present) {
        if (!present) return new Reconciled(Drift.DROPPED, null, null);
        boolean anyDescriptor = false;
        if (segments != null) {
            for (LiveSegment s : segments) if (s != null && s.isDescriptor()) anyDescriptor = true;
        }
        if (!anyDescriptor) return new Reconciled(Drift.UNVERIFIED, null, null);
        if (!isProgressRecord(row)) return new Reconciled(Drift.UNVERIFIED, null, null);
        String storedId = row.segmentId();
        if (storedId == null || !Rows.nonEmpty(storedId)) return new Reconciled(Drift.UNANCHORED, null, null);
        int at = -1;
        for (int i = 0; i < segments.size(); i++) {
            LiveSegment s = segments.get(i);
            if (s != null && s.isDescriptor() && storedId.equals(s.id())) {
                at = i;
                break;
            }
        }
        if (at < 0) return new Reconciled(Drift.DROPPED, null, null);
        LiveSegment segment = segments.get(at);
        double start = segment.startSec();
        double length = segment.durationSec();
        Double intoValue = row.intoSec();
        double into = intoValue != null && Double.isFinite(intoValue) && intoValue > 0 ? intoValue : 0;
        double room = JSMath.max(0, length - DRIFT_TOLERANCE_SEC);
        double elapsed = start + JSMath.min(into, room);
        // `record.index === at`: only a number can equal it.
        double stored = row.elapsedSec() == null ? Double.NaN : row.elapsedSec();
        boolean unmoved = row.index() != null && row.index() == at && Math.abs(elapsed - stored) <= DRIFT_TOLERANCE_SEC;
        return new Reconciled(unmoved ? Drift.EXACT : Drift.MOVED, elapsed, at);
    }

    /** Where a Foray resumes, and whether to offer it at all. */
    public record ResumePoint(double elapsedSec, double index, double remainingSec, double percent, boolean finished, Drift drift) {}

    /**
     * {@code resumePoint(record, {totalSec, maxIndex, segments, present})}. The LIVE total (a
     * finite number above 0, else the row's) and last index are the authority; with a live order
     * the clock is re-derived ({@code moved}) or verified ({@code exact}); a dropped anchor paints
     * no row. Under {@link #MIN_RESUME_SEC}: null. Inside {@link #NEAR_END_SEC} of the end: finished.
     */
    public static ResumePoint resumePoint(ForayRow row, Double totalSec, Double maxIndex, List<LiveSegment> segments, boolean present) {
        if (row == null || !isProgressRecord(row)) return null;
        double stored = row.elapsedSec();
        double rowTotal = row.totalSec();
        double total = totalSec != null && Double.isFinite(totalSec) && totalSec > 0 ? totalSec : rowTotal;
        Reconciled at = reconcileSegment(row, segments, present);
        double base = at.elapsedSec() != null && Double.isFinite(at.elapsedSec()) ? at.elapsedSec() : stored;
        double elapsed = JSMath.min(base, total);
        double index;
        if (at.drift() == Drift.DROPPED) {
            index = -1;
        } else if (at.index() != null) {
            index = at.index();
        } else {
            index = clampIndex(row.index(), maxIndex);
        }
        if (elapsed < MIN_RESUME_SEC) return null;
        if (elapsed > total - NEAR_END_SEC) return new ResumePoint(elapsed, index, 0, 100, true, at.drift());
        return new ResumePoint(elapsed, index, total - elapsed, percentDone(elapsed, total), false, at.drift());
    }

    /** {@code clampIndex(index, maxIndex)}: -1 survives; past the live end is -1, never the last segment. */
    public static double clampIndex(Double index, Double maxIndex) {
        if (index == null || !JSMath.isInteger(index) || !(index >= 0)) return -1;
        if (maxIndex == null || !JSMath.isInteger(maxIndex) || !(maxIndex >= 0)) return index;
        return index > maxIndex ? -1 : index;
    }

    /** {@code percentDone(elapsedSec, totalSec)}: 0-100, rounded, clamped. */
    public static double percentDone(Double elapsedSec, Double totalSec) {
        if (elapsedSec == null || !Double.isFinite(elapsedSec) || totalSec == null || !Double.isFinite(totalSec) || !(totalSec > 0)) {
            return 0;
        }
        return JSMath.max(0, JSMath.min(100, JSMath.round(elapsedSec / totalSec * 100)));
    }

    /**
     * {@code remainingLabel(remainingSec, {estimated})}: "N min left" in MEDIA minutes, rolling
     * over past the hour, hedged with "about " when estimated; "under a minute left" under 60 s;
     * "finished" for nothing left.
     */
    public static String remainingLabel(Double remainingSec, boolean estimated) {
        if (remainingSec == null || !Double.isFinite(remainingSec) || !(remainingSec > 0)) return "finished";
        if (remainingSec < 60) return "under a minute left";
        double mins = JSMath.round(remainingSec / 60);
        double h = Math.floor(mins / 60);
        double m = mins % 60;
        String about = estimated ? "about " : "";
        if (h != 0) {
            return about + JSWriter.numberToString(h) + " hr" + (m != 0 ? " " + JSWriter.numberToString(m) + " min" : "") + " left";
        }
        return about + JSWriter.numberToString(m) + " min left";
    }

    /** {@code progressLabel(point, {estimated})}: "Played" when finished, the remaining label otherwise. */
    public static String progressLabel(boolean finished, Double remainingSec, boolean estimated) {
        return finished ? PLAYED_LABEL : remainingLabel(remainingSec, estimated);
    }

    /**
     * {@code isStale(record, {now, maxAgeH})} inside {@code listProgress}: a DATED row older than
     * {@code maxAgeH} hours. An undated row is kept, never silently dropped.
     */
    public static boolean rowIsStale(Double updatedAtMs, double nowMs, double maxAgeH) {
        if (updatedAtMs == null || !Double.isFinite(updatedAtMs)) return false;
        return (nowMs - updatedAtMs) / 3.6e6 > maxAgeH;
    }

    /**
     * listProgress's order, most recent first:
     * {@code String(b.updated_at).localeCompare(String(a.updated_at))} for ISO stamps (code unit
     * by code unit). True when {@code a} sorts before {@code b}.
     */
    public static boolean rowSortsBefore(String a, String b) {
        // b lexicographically precedes a (UTF-16 code units: String.compareTo).
        return b.compareTo(a) < 0;
    }

    /**
     * {@code ForayProgressStore}'s throttle: the gate, the 5-second clock throttle per Foray, and
     * the count of refused writes. The engine asks {@link #due} on every tick, performs the write,
     * and reports the outcome with {@link #recorded}, exactly as {@code save} does around
     * {@code writeProgress}.
     */
    public static final class WriteThrottle {
        public final double everySec;
        private int refusedWrites;
        private final Map<String, Double> lastWritten = new HashMap<>();

        /** {@code everySec}: a finite number above 0, else {@code SAVE_EVERY_SEC}. */
        public WriteThrottle(Double everySec) {
            this.everySec = everySec != null && Double.isFinite(everySec) && everySec > 0 ? everySec : ResumeRules.FORAY_WRITE_EVERY_SEC;
        }

        public WriteThrottle() {
            this(null);
        }

        public int refusedWrites() {
            return refusedWrites;
        }

        /**
         * {@code save(p)} up to its write: the row to write now, or null where it writes nothing (a
         * blank id, a clock that is not a finite number, a total that is not a finite number above
         * 0, or the throttle).
         */
        public Rows.StoredRow due(Rows.ForayProgressInput p, boolean force, String updatedAt) {
            String id = p.forayId();
            Double elapsed = p.elapsedSec();
            Double total = p.totalSec();
            if (id == null || !Rows.nonEmpty(id) || elapsed == null || !Double.isFinite(elapsed) || total == null
                    || !Double.isFinite(total) || !(total > 0)) {
                return null;
            }
            if (!ResumeRules.forayWriteDue(lastWritten.get(id), elapsed, everySec, force)) return null;
            return Rows.forayProgress(p, updatedAt);
        }

        /** The write's outcome: a landed write moves the throttle; a refused one is COUNTED and does not. */
        public void recorded(String forayId, double elapsedSec, boolean ok) {
            if (ok) {
                lastWritten.put(forayId, elapsedSec);
            } else {
                refusedWrites += 1;
            }
        }

        /** {@code clear(forayId)}: the next save of this Foray is due at once. */
        public void clear(String forayId) {
            lastWritten.remove(forayId);
        }
    }
}

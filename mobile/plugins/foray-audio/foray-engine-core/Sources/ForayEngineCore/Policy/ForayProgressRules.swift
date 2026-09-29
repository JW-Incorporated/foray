import Foundation

/// ResumeRules gains the Foray's (card NE-29s): the Swift port of the rules in
/// `player/foray-progress.js` that the engine needs to resume a Foray and to
/// write its `cp_foray:<id>` row: the thresholds, the row's validity, the
/// resume decision with #40's drift verdicts, the throttled writer and the
/// labels. JS is the reference; the `foray-progress` parity family (the pure
/// half as calls, the storage half through `player/parity/foray-store.js`) is
/// the contract, and the JS module's comments are where the reasons live.
///
/// The row's exact bytes are `Rows.forayProgress` / `Rows.makeForayProgress`
/// (NE-10s's `rows` family pins them); the 5-second cadence arithmetic is
/// `forayWriteDue` (NE-09). Every number is READ from `EngineConstants`.
///
/// A row here is TYPED: each field is nil where the stored JSON value is
/// absent OR of a type the JS rule rejects (`typeof x === "number"` and
/// `Number.isFinite`, `typeof s === "string"`), because every JS read of it
/// lands on the same answer for both.
public extension ResumeRules {
    /// foray-progress.js `MIN_RESUME_SEC`: under this, nothing to resume.
    static let forayMinResumeSec: Double = EngineConstants.ForayProgress.minResumeSec
    /// `NEAR_END_SEC`: inside this of the end, the Foray is finished.
    static let forayNearEndSec: Double = EngineConstants.ForayProgress.nearEndSec
    /// `MAX_AGE_H`: a dated row older than this is left out of the list.
    static let forayMaxAgeH: Double = EngineConstants.ForayProgress.maxAgeH
    /// `DRIFT_TOLERANCE_SEC`: how far a re-derived clock may sit from the
    /// stored one and still be `exact`; also how far inside a shortened
    /// segment a resume is clamped.
    static let forayDriftToleranceSec: Double = EngineConstants.ForayProgress.driftToleranceSec
    /// `PLAYED_LABEL`: a finished Foray's label, the word a finished episode uses.
    static let forayPlayedLabel: String = EngineConstants.ForayProgress.playedLabel

    /// The five `DRIFT_*` verdicts (#40, FD-05).
    enum ForayDrift: String, CaseIterable, Equatable {
        /// No live running order to check against: the clock, clamped.
        case unverified
        /// The anchor segment is where the row left it.
        case exact
        /// The anchor segment moved; the clock is re-derived from it.
        case moved
        /// The anchor segment (or the whole Foray) is gone: clamped clock, no row painted.
        case dropped
        /// The row has no anchor (written before `segment_id` existed).
        case unanchored

        public static let tokens: [String] = [
            EngineConstants.ForayProgress.driftUnverified, EngineConstants.ForayProgress.driftExact,
            EngineConstants.ForayProgress.driftMoved, EngineConstants.ForayProgress.driftDropped,
            EngineConstants.ForayProgress.driftUnanchored
        ]
    }

    /// A `cp_foray` row as the rules read it (see the type comment on nil).
    struct ForayRow: Equatable {
        public var forayId: String?
        public var elapsedSec: Double?
        public var totalSec: Double?
        public var index: Double?
        public var segmentId: String?
        public var intoSec: Double?

        public init(forayId: String?, elapsedSec: Double?, totalSec: Double?, index: Double? = nil,
                    segmentId: String? = nil, intoSec: Double? = nil) {
            self.forayId = forayId
            self.elapsedSec = elapsedSec
            self.totalSec = totalSec
            self.index = index
            self.segmentId = segmentId
            self.intoSec = intoSec
        }
    }

    /// `isProgressRecord(r)`: a row names a Foray and carries a finite clock
    /// (elapsed >= 0, total > 0). `segment_id` and `into_sec` are NOT required:
    /// rows written before they existed are still resume points. nil (not an
    /// object) is no row.
    static func isForayProgressRecord(_ row: ForayRow?) -> Bool {
        guard let row, let id = row.forayId, Rows.nonEmpty(id),
              let elapsed = row.elapsedSec, elapsed.isFinite, elapsed >= 0,
              let total = row.totalSec, total.isFinite, total > 0 else { return false }
        return true
    }

    /// One item of the LIVE running order (`progressSegments`), as
    /// `reconcileSegment` reads it: nil fields where the value is not a
    /// string / a number. A nil entry is not an object.
    struct LiveSegment: Equatable {
        public var id: String?
        public var startSec: Double?
        public var durationSec: Double?

        public init(id: String?, startSec: Double?, durationSec: Double?) {
            self.id = id
            self.startSec = startSec
            self.durationSec = durationSec
        }

        /// `isSegmentDescriptor`: a finite start >= 0 and a finite length >= 0.
        var isDescriptor: Bool {
            guard let start = startSec, start.isFinite, start >= 0,
                  let length = durationSec, length.isFinite, length >= 0 else { return false }
            return true
        }
    }

    /// What `reconcileSegment` answers.
    struct Reconciled: Equatable {
        public let drift: ForayDrift
        /// Present for `exact` and `moved` only.
        public let elapsedSec: Double?
        /// The LIVE index, present for `exact` and `moved` only.
        public let index: Int?
    }

    /// `reconcileSegment(record, segments, {present})`: what the stored row
    /// means against the running order as it exists now. `present: false`
    /// (the Foray itself is gone, FD-05) is checked first. A list with no
    /// usable entry is no live order. The anchor is found by id among the
    /// usable entries, but its index counts the caller's own array (it paints
    /// the running order). The clock is re-derived from where that segment
    /// starts now, clamped one tolerance INSIDE the segment.
    static func reconcileSegment(_ row: ForayRow?, segments: [LiveSegment?]?, present: Bool = true) -> Reconciled {
        if !present { return Reconciled(drift: .dropped, elapsedSec: nil, index: nil) }
        guard let live = segments, live.contains(where: { $0?.isDescriptor == true }) else {
            return Reconciled(drift: .unverified, elapsedSec: nil, index: nil)
        }
        guard let row, isForayProgressRecord(row) else { return Reconciled(drift: .unverified, elapsedSec: nil, index: nil) }
        guard let storedId = row.segmentId, Rows.nonEmpty(storedId) else {
            return Reconciled(drift: .unanchored, elapsedSec: nil, index: nil)
        }
        guard let at = live.firstIndex(where: { $0?.isDescriptor == true && $0?.id == storedId }),
              let segment = live[at], let start = segment.startSec, let length = segment.durationSec else {
            return Reconciled(drift: .dropped, elapsedSec: nil, index: nil)
        }
        let into: Double = {
            guard let value = row.intoSec, value.isFinite, value > 0 else { return 0 }
            return value
        }()
        let room = JSMath.max(0, length - forayDriftToleranceSec)
        let elapsed = start + JSMath.min(into, room)
        // `record.index === at`: only a number can equal it.
        let unmoved = row.index == Double(at)
            && Swift.abs(elapsed - (row.elapsedSec ?? .nan)) <= forayDriftToleranceSec
        return Reconciled(drift: unmoved ? .exact : .moved, elapsedSec: elapsed, index: at)
    }

    /// Where a Foray resumes, and whether to offer it at all.
    struct ForayResumePoint: Equatable {
        public let elapsedSec: Double
        /// The running-order row to paint; -1 is "we do not know".
        public let index: Double
        public let remainingSec: Double
        public let percent: Double
        public let finished: Bool
        public let drift: ForayDrift
    }

    /// `resumePoint(record, {totalSec, maxIndex, segments, present})`. The
    /// LIVE total (a finite number above 0, else the row's) and last index are
    /// the authority; with a live order the clock is re-derived (`moved`) or
    /// verified (`exact`); a dropped anchor paints no row. Under
    /// `forayMinResumeSec`: nil. Inside `forayNearEndSec` of the end: finished.
    /// `maxIndex` is the JS value when it is a number (nil otherwise).
    static func forayResumePoint(_ row: ForayRow?, totalSec: Double? = nil, maxIndex: Double? = nil,
                                 segments: [LiveSegment?]? = nil, present: Bool = true) -> ForayResumePoint? {
        guard let row, isForayProgressRecord(row), let stored = row.elapsedSec, let rowTotal = row.totalSec else { return nil }
        let total: Double = {
            guard let value = totalSec, value.isFinite, value > 0 else { return rowTotal }
            return value
        }()
        let at = reconcileSegment(row, segments: segments, present: present)
        let elapsed = JSMath.min(at.elapsedSec.flatMap { $0.isFinite ? $0 : nil } ?? stored, total)
        let index: Double
        if at.drift == .dropped {
            index = -1
        } else if let live = at.index {
            index = Double(live)
        } else {
            index = clampIndex(row.index, maxIndex: maxIndex)
        }
        if elapsed < forayMinResumeSec { return nil }
        if elapsed > total - forayNearEndSec {
            return ForayResumePoint(elapsedSec: elapsed, index: index, remainingSec: 0, percent: 100,
                                    finished: true, drift: at.drift)
        }
        return ForayResumePoint(elapsedSec: elapsed, index: index, remainingSec: total - elapsed,
                                percent: percentDone(elapsedSec: elapsed, totalSec: total), finished: false,
                                drift: at.drift)
    }

    /// `clampIndex(index, maxIndex)`: -1 survives; past the live end is -1,
    /// never the last segment.
    static func clampIndex(_ index: Double?, maxIndex: Double?) -> Double {
        guard let index, MediaMapping.isInteger(index), index >= 0 else { return -1 }
        guard let maxIndex, MediaMapping.isInteger(maxIndex), maxIndex >= 0 else { return index }
        return index > maxIndex ? -1 : index
    }

    /// `percentDone(elapsedSec, totalSec)`: 0-100, rounded, clamped.
    static func percentDone(elapsedSec: Double?, totalSec: Double?) -> Double {
        guard let elapsed = elapsedSec, elapsed.isFinite, let total = totalSec, total.isFinite, total > 0 else { return 0 }
        return JSMath.max(0, JSMath.min(100, JSMath.round(elapsed / total * 100)))
    }

    /// `remainingLabel(remainingSec, {estimated})`: "N min left" in MEDIA
    /// minutes (a founder decision, #242), rolling over past the hour, hedged
    /// with "about " when the total is partly an estimate; "under a minute
    /// left" under 60 s; "finished" for nothing left.
    static func remainingLabel(_ remainingSec: Double?, estimated: Bool = false) -> String {
        guard let remaining = remainingSec, remaining.isFinite, remaining > 0 else { return "finished" }
        if remaining < 60 { return "under a minute left" }
        let mins = JSMath.round(remaining / 60)
        let h = (mins / 60).rounded(.down)
        let m = mins.truncatingRemainder(dividingBy: 60)
        let about = estimated ? "about " : ""
        if h != 0 {
            return about + JSWriter.numberToString(h) + " hr" + (m != 0 ? " " + JSWriter.numberToString(m) + " min" : "") + " left"
        }
        return about + JSWriter.numberToString(m) + " min left"
    }

    /// `progressLabel(point, {estimated})`: "Played" when finished, the
    /// remaining label otherwise, "" for no point. `finished` is the point's
    /// truthiness, `remainingSec` its value when it is a number.
    static func progressLabel(finished: Bool, remainingSec: Double?, estimated: Bool = false) -> String {
        finished ? forayPlayedLabel : remainingLabel(remainingSec, estimated: estimated)
    }

    // MARK: - The stored rows

    /// `isStale(record, {now, maxAgeH})` inside `listProgress`: a DATED row
    /// older than `maxAgeH` hours. An undated row (no stamp `Date.parse`
    /// reads) is kept, never silently dropped.
    static func forayRowIsStale(updatedAtMs: Double?, nowMs: Double, maxAgeH: Double = forayMaxAgeH) -> Bool {
        guard let stamp = updatedAtMs, stamp.isFinite else { return false }
        return (nowMs - stamp) / 3.6e6 > maxAgeH
    }

    /// listProgress's order, most recent first:
    /// `String(b.updated_at).localeCompare(String(a.updated_at))`, for the
    /// ISO stamps every writer produces (compared code unit by code unit,
    /// which is the collation's order for them). True when `a` sorts before `b`.
    static func forayRowSortsBefore(_ a: String, _ b: String) -> Bool {
        let (x, y) = (Array(a.utf16), Array(b.utf16))
        return y.lexicographicallyPrecedes(x)
    }

    /// `ForayProgressStore`'s throttle: the gate, the 5-second clock throttle
    /// per Foray, and the count of refused writes. The engine asks `due` on
    /// every tick, performs the write, and reports the outcome with
    /// `recorded`, exactly as `save` does around `writeProgress`.
    struct ForayWriteThrottle: Equatable {
        public let everySec: Double
        public private(set) var refusedWrites: Int = 0
        private var lastWritten: [String: Double] = [:]

        /// `everySec`: a finite number above 0, else `forayWriteEverySec`.
        public init(everySec: Double? = nil) {
            if let value = everySec, value.isFinite, value > 0 {
                self.everySec = value
            } else {
                self.everySec = ResumeRules.forayWriteEverySec
            }
        }

        /// `save(p)` up to its write: the row to write now, or nil where it
        /// writes nothing (a blank id, a clock that is not a finite number, a
        /// total that is not a finite number above 0, or the throttle).
        public func due(_ p: Rows.ForayProgressInput, force: Bool, updatedAt: String) -> StoredRow? {
            guard let id = p.forayId, Rows.nonEmpty(id), let elapsed = p.elapsedSec, elapsed.isFinite,
                  let total = p.totalSec, total.isFinite, total > 0 else { return nil }
            guard ResumeRules.forayWriteDue(lastWritten: lastWritten[id], elapsedSec: elapsed,
                                            everySec: everySec, force: force) else { return nil }
            return Rows.forayProgress(p, updatedAt: updatedAt)
        }

        /// The write's outcome: a landed write moves the throttle; a refused
        /// one is COUNTED ("silently forgot you" is the defect) and does not.
        public mutating func recorded(forayId: String, elapsedSec: Double, ok: Bool) {
            if ok { lastWritten[forayId] = elapsedSec } else { refusedWrites += 1 }
        }

        /// `clear(forayId)`: the next save of this Foray is due at once.
        public mutating func clear(forayId: String) {
            lastWritten[forayId] = nil
        }
    }
}

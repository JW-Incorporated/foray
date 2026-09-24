import Foundation

/// Where to resume, what a saved position looks like, and WHEN one is
/// written: the Swift port of the pure rules in `player/position-store.js`
/// (`resumeOffsetFor`, `positionRow`, `positionEvent`), of the manager's tick
/// throttle (`positionTickDue`, `player/queue-manager.js`) and of the Foray
/// store's (`forayWriteDue`, `player/foray-progress.js`). JS is the reference;
/// the `resume-rules` parity family (player/parity/fixtures/resume-rules, one
/// file per JS module) is the contract, and those modules' comments are where
/// the reasons live (corner case #17: pocketing the phone loses <= 15 s; #263:
/// an unknown position never overwrites a known one).
///
/// Every number is READ from the generated `EngineConstants` (NE-04). The
/// engine's use of these (the cadence it writes `cp_pos:` rows at, and where
/// it resumes an episode) is NE-14s; the row's exact bytes are NE-10s's
/// `rows` family. This file only decides.
///
/// `nil` in a numeric parameter stands for every value JavaScript's
/// `typeof n === "number"` rejects; where a JS rule reads a value with a
/// looser test (truthiness, `?? 0`), the doc comment says which.
public enum ResumeRules {
    /// `MIN_RESUME_SEC`: under this there is nothing worth resuming to.
    public static let minResumeSec: Double = EngineConstants.PositionStore.minResumeSec
    /// `NEAR_END_SEC`: inside this of the end, the episode is finished.
    public static let nearEndSec: Double = EngineConstants.PositionStore.nearEndSec
    /// `POSITION_EVENT_EVERY_SEC`: at most one cp_events position row per this
    /// many MEDIA seconds per item.
    public static let positionEventEverySec: Double = EngineConstants.PositionStore.positionEventEverySec
    /// `POSITION_INTERVAL_MS`: the episode's periodic write, 15 s.
    public static let positionIntervalMs: Double = EngineConstants.QueueManager.positionIntervalMs
    /// `POSITION_MIN_DELTA_SEC`: how far (media seconds) the playhead must
    /// move on one item before a TICK writes again, 10 s.
    public static let positionMinDeltaSec: Double = EngineConstants.QueueManager.positionMinDeltaSec
    /// `SAVE_EVERY_SEC` of foray-progress.js: a Foray's clock is written every 5 s.
    public static let forayWriteEverySec: Double = EngineConstants.ForayProgress.saveEverySec

    // MARK: where to resume

    /// A stored `cp_pos:` row as the store's `load` returns it: `seconds` is
    /// validated there (a finite number, or no row at all); `duration` is not.
    public struct StoredPosition: Equatable {
        public let seconds: Double
        public let duration: Double?

        public init(seconds: Double, duration: Double?) {
            self.seconds = seconds
            self.duration = duration
        }
    }

    /// `resumeOffsetFor(record, {duration})`: where to resume a stored row.
    /// No row -> 0; under `minResumeSec` -> 0; inside `nearEndSec` of the end
    /// -> 0 (effectively finished); otherwise the stored seconds.
    ///
    /// The caller's duration wins and the row's stands in (`??`: only a
    /// MISSING caller duration defers, so a caller's 0 is kept, and 0 then
    /// means "length unknown" because the end check reads the duration by
    /// truthiness: 0 and NaN skip it).
    public static func resumeOffset(for record: StoredPosition?, duration: Double? = nil) -> Double {
        guard let record else { return 0 }
        if record.seconds < minResumeSec { return 0 }
        if let dur = duration ?? record.duration, dur != 0, !dur.isNaN,
           record.seconds > dur - nearEndSec {
            return 0
        }
        return record.seconds
    }

    // MARK: what a saved position looks like

    /// The row `save` writes: `{seconds, duration, updated_at, source: "local"}`.
    public struct PositionRow: Equatable {
        public static let localSource = "local"

        public let seconds: Double
        /// A finite number or null: any other duration is stored as null.
        public let duration: Double?
        /// The caller's clock, as given (nil = the JS `undefined`).
        public let updatedAt: String?
        public let source: String
    }

    /// `positionRow(id, seconds, meta, updatedAt)`: the row, or nil when there
    /// is nothing to write (no id, or a position that is not a finite,
    /// non-negative number). An unknown position therefore never reaches the
    /// store, so it never overwrites a known one.
    public static func positionRow(id: String, seconds: Double?, duration: Double?,
                                   updatedAt: String?) -> PositionRow? {
        guard !id.isEmpty, let seconds, seconds.isFinite, !(seconds < 0) else { return nil }
        let kept: Double? = {
            guard let duration, duration.isFinite else { return nil }
            return duration
        }()
        return PositionRow(seconds: seconds, duration: kept, updatedAt: updatedAt, source: PositionRow.localSource)
    }

    // MARK: the once-a-minute position event

    public struct PositionEvent: Equatable {
        /// What to remember as this item's last-emitted position: UNROUNDED.
        public let mark: Double
        /// The event's seconds, `Math.round`ed.
        public let seconds: Double
        public let duration: Double?
    }

    /// `positionEvent(lastEmitted, seconds, duration)`: an event at most once
    /// every `positionEventEverySec` media seconds per item, and always when
    /// nothing (or 0) was emitted before; nil = no event. The event carries
    /// the position rounded the JavaScript way (`JSMath.round`) and the mark
    /// unrounded, so 72.2 after a mark of 12.4 is 59.8 s on, not 60.2.
    public static func positionEvent(lastEmitted: Double?, seconds: Double, duration: Double?) -> PositionEvent? {
        let last = lastEmitted ?? 0
        guard seconds - last >= positionEventEverySec || last == 0 else { return nil }
        return PositionEvent(mark: seconds, seconds: JSMath.round(seconds), duration: duration)
    }

    // MARK: when a tick writes

    /// The last write the tick throttle measures from (`_lastPersisted`).
    public struct LastWrite: Equatable {
        public let id: String?
        public let seconds: Double?

        public init(id: String?, seconds: Double?) {
            self.id = id
            self.seconds = seconds
        }
    }

    /// `positionTickDue(last, id, seconds)`: whether a periodic tick writes
    /// the playhead now. Never for a clock that is not a finite number (an
    /// unknown position never overwrites a known one); not while the SAME
    /// item has moved less than `positionMinDeltaSec` (either direction)
    /// since the last write; at once for another item or a first write.
    public static func positionTickDue(last: LastWrite?, id: String, seconds: Double?) -> Bool {
        guard let seconds, seconds.isFinite else { return false }
        // `Math.abs(seconds - last.seconds) < delta`: a missing last position
        // is NaN in JS, and NaN is never less than anything, so it is due.
        if let last, last.id == id, Swift.abs(seconds - (last.seconds ?? .nan)) < positionMinDeltaSec {
            return false
        }
        return true
    }

    /// `forayWriteDue(lastWritten, elapsedSec, {everySec, force})`: whether a
    /// Foray's playhead is written now. Never for an elapsed value that is not
    /// a finite number (#263); always when forced (pause, page-hide) or on the
    /// first write; otherwise once the CLOCK has moved `everySec` since the
    /// last write. `!(d < everySec)` rather than `d >= everySec`: the JS is the
    /// negation of the old skip test, and the two differ on NaN.
    public static func forayWriteDue(lastWritten: Double?, elapsedSec: Double?,
                                     everySec: Double = forayWriteEverySec, force: Bool = false) -> Bool {
        guard let elapsedSec, elapsedSec.isFinite else { return false }
        guard !force, let lastWritten else { return true }
        return !(Swift.abs(elapsedSec - lastWritten) < everySec)
    }
}

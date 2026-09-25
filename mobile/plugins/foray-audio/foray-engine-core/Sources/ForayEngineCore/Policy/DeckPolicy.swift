import Foundation

/// The episode deck's decisions: the Swift port of `player/deck-policy.js`
/// (card NE-14s; the rules moved out of `HtmlAudioBackend` in NE-14j).
///
/// WHY THESE ARE THE CORE'S AND NOT AVDECK'S. AVDeck (NE-15) is an adapter: it
/// runs commands against AVFoundation and reports what it saw. Every choice a
/// deck makes that the web deck also makes (when the out-point's fine watch
/// arms and for how long, what a fine wake does, how long a load may take,
/// when the next item is a seek in the buffer rather than a refetch, what the
/// handover's recovery may still do after a stop) is made HERE, once, and
/// pinned by the `deck-episode` fixtures that JS records. A rule changed in
/// one runtime and not the other is a red parity case, not a car test.
///
/// JS IS THE REFERENCE (plan §6). A change is a JS PR that re-records the
/// family, then a Swift PR that makes it pass; the numbers and
/// `fineWakeAction` are AUTHORED cases in the fixtures, so the never-early rule
/// cannot move by accident in either runtime. Every number is read from the
/// generated `EngineConstants` (NE-04); the derivations live beside the JS
/// constants, not here.
///
/// Nothing here reads a clock, the deck or storage: facts in, an answer out.
public enum DeckPolicy {
    /// `OUT_POINT_ARM_LEAD_SEC`: how much WALL clock before the boundary the
    /// fine stage takes over (wider than the worst recorded tick gap).
    public static let outPointArmLeadSec: Double = EngineConstants.DeckPolicy.outPointArmLeadSec
    /// `OUT_POINT_MIN_TIMER_MS`: never ask a timer for less.
    public static let outPointMinTimerMs: Double = EngineConstants.DeckPolicy.outPointMinTimerMs
    /// `LOAD_SETTLE_TIMEOUT_MS`: a visible load's deadline.
    public static let loadSettleTimeoutMs: Double = EngineConstants.DeckPolicy.loadSettleTimeoutMs
    /// `LOAD_SETTLE_TIMEOUT_HIDDEN_MS`: a hidden load's deadline (a hidden
    /// load is a different machine, not the same one running slower).
    public static let loadSettleTimeoutHiddenMs: Double = EngineConstants.DeckPolicy.loadSettleTimeoutHiddenMs
    /// `SETTLE_NEAR_SEC`: how close an in-place seek must land to count.
    public static let settleNearSec: Double = EngineConstants.DeckPolicy.settleNearSec

    /// `FINE_WAKE`: what a fine-watch wake does.
    public enum FineWake: String, CaseIterable, Sendable {
        /// The playhead reached the boundary: pause and report the out-point.
        case stop
        /// Woke early with progress (timer jitter): arm again for what is left.
        case reschedule
        /// Woke early with NO progress since the last wake: a stall. Hand back
        /// to the coarse stage rather than spin at the timer floor.
        case standDown = "stand-down"
    }

    /// `RECOVERY`: what the handover's recovery does once its load settles.
    public enum Recovery: String, CaseIterable, Sendable {
        case armOutPoint = "arm-out-point"
        case play
        case report
    }

    /// `deckRate(playbackRate)`: the rate the fine watch divides by: the
    /// deck's own when it is a positive number, else 1x (never divide by
    /// nothing). `nil` stands for every value `typeof x === "number"` rejects.
    public static func deckRate(_ rate: Double?) -> Double {
        guard let rate, rate > 0 else { return 1 }
        return rate
    }

    /// `outPointArmed({atSec, outPointSec})`: armed only while the playhead is
    /// BEFORE the boundary. The watch fires on a crossing from below, so a
    /// scrub past it free-plays and a scrub back re-arms.
    public static func outPointArmed(atSec: Double, outPointSec: Double) -> Bool {
        atSec < outPointSec
    }

    /// `fineWatchDelayMs({outPointSec, atSec, rate, armed, paused})`: how long,
    /// in WALL-CLOCK ms, to arm the fine watch for, or nil when it must not be
    /// armed now (no boundary, disarmed, paused, or further than the lead).
    /// The remaining CONTENT divided by the rate, so armed x rate is constant
    /// and a faster rate never widens what a late wake can spill; rounded UP,
    /// never below the timer floor. The operations are the JS ones in the JS
    /// order, so the IEEE results (1,825 vs 1,826 ms at the ladder stops) are
    /// the same bits.
    public static func fineWatchDelayMs(outPointSec: Double?, atSec: Double, rate: Double?,
                                        armed: Bool = true, paused: Bool = false) -> Double? {
        guard let outPointSec, armed, !paused else { return nil }
        let remainingWallSec = (outPointSec - atSec) / deckRate(rate)
        if remainingWallSec > outPointArmLeadSec { return nil }
        return JSMath.max(outPointMinTimerMs, (remainingWallSec * 1000).rounded(.up))
    }

    /// `fineWakeAction({atSec, outPointSec, lastWakeAtSec})`. THE STOP IS NEVER
    /// EARLY: a wake re-reads the playhead and stops only on a real crossing;
    /// an early wake with progress reschedules, one with none since the last
    /// early wake stands down instead of spinning.
    public static func fineWakeAction(atSec: Double, outPointSec: Double, lastWakeAtSec: Double? = nil) -> FineWake {
        if atSec >= outPointSec { return .stop }
        if let lastWakeAtSec, atSec <= lastWakeAtSec { return .standDown }
        return .reschedule
    }

    /// `loadDeadlineMs({pinnedMs, hidden})`: a pinned deadline wins at either
    /// visibility; otherwise only a page KNOWN to be hidden gets the hidden
    /// budget, and visible or unknown gets the visible one.
    public static func loadDeadlineMs(pinnedMs: Double? = nil, hidden: Bool = false) -> Double {
        if let pinnedMs { return pinnedMs }
        return hidden ? loadSettleTimeoutHiddenMs : loadSettleTimeoutMs
    }

    /// `sameSourceIsSeek({loadedUrl, url, hasMetadata, failed})`: SAME SOURCE =
    /// A SEEK, NOT A LOAD. A deck already holding this URL, with metadata and
    /// no error, moves its playhead inside the buffer it has: no refetch, no
    /// gap, and no ad-stitched host handing back a different stitch. This is
    /// what makes the core's in-place resume (an interruption's rewind, a
    /// paused listener's play) cost no network round trip on the healthy item,
    /// while a FAILED item is rebuilt (plan §4.4).
    public static func sameSourceIsSeek(loadedUrl: String?, url: String?, hasMetadata: Bool, failed: Bool) -> Bool {
        guard let loadedUrl, !loadedUrl.isEmpty else { return false }
        return loadedUrl == url && hasMetadata && !failed
    }

    /// `settledNear({atSec, targetSec})`: within `settleNearSec` of the target.
    public static func settledNear(atSec: Double, targetSec: Double) -> Bool {
        Swift.abs(atSec - targetSec) <= settleNearSec
    }

    /// `recoveryLoadedOps({superseded, stopped, boundarySec})`: a superseded
    /// recovery does nothing (arming the old boundary over the new load is a
    /// wrong out-point); a STOPPED one arms but does not play (#267: one press
    /// must resume it still bounded); otherwise arm, then play. Only a real
    /// boundary is armed.
    public static func recoveryLoadedOps(superseded: Bool, stopped: Bool, boundarySec: Double?) -> [Recovery] {
        if superseded { return [] }
        var ops: [Recovery] = boundarySec != nil ? [.armOutPoint] : []
        if !stopped { ops.append(.play) }
        return ops
    }

    /// `recoveryFailedOps({superseded, stopped})`: only a failure somebody is
    /// still waiting on is reported; after a stop it would be a lie about
    /// causation, after a supersede it would overwrite the newer load.
    public static func recoveryFailedOps(superseded: Bool, stopped: Bool) -> [Recovery] {
        superseded || stopped ? [] : [.report]
    }
}

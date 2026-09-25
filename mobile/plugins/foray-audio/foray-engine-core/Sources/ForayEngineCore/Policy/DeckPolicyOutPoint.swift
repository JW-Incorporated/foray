import Foundation

/// The native out-point: three layers and a windowed watchdog. The Swift port
/// of the NE-28j half of `player/deck-policy.js` (card NE-28s; the fixtures are
/// the `outpoint` family: `outpoint-policy.json` pins the arithmetic,
/// `outpoint-watch.json` drives `outPointStep` over a driven clock and pins
/// the op log).
///
/// Plan §4.3, P-2. The first layer to fire wins, per load token:
///
///   1. `forwardPlaybackEndTime`: the player item stops itself at the boundary;
///   2. a boundary time observer at the same instant;
///   3. a watchdog: ONE timer until `OUT_POINT_WATCHDOG_WINDOW_SEC` of wall
///      clock before the predicted crossing, then a poll every
///      `OUT_POINT_WATCHDOG_POLL_MS` inside that window only. Re-armed on
///      every seek and every rate change (DV-11: one wakeup outside the
///      window, not four a second for a whole Foray).
///
/// NEVER EARLY, IN EVERY LAYER. A report before the playhead has reached the
/// boundary stops nothing: it is written down (`outPoint.early:`) and the
/// watchdog is re-armed from where the playhead really is.
///
/// Pure, like the rest of DeckPolicy: every event carries the playhead and,
/// where time matters, the wall clock; every answer is a new watch plus the
/// ops the native deck is commanded to perform, in order.
extension DeckPolicy {
    /// `OUT_POINT_WATCHDOG_WINDOW_SEC` (authored 1.5): how much WALL clock
    /// before the boundary the watchdog starts polling.
    public static let outPointWatchdogWindowSec: Double = EngineConstants.DeckPolicy.outPointWatchdogWindowSec
    /// `OUT_POINT_WATCHDOG_POLL_MS` (authored 250): the poll inside the window.
    public static let outPointWatchdogPollMs: Double = EngineConstants.DeckPolicy.outPointWatchdogPollMs

    /// `OUT_POINT_LAYER`: the three layers, as they name themselves in the op
    /// log and the `outPoint` row.
    public enum OutPointLayer: String, CaseIterable, Sendable {
        case endTime
        case boundary
        case watchdog
    }

    /// `WATCHDOG_WAKE`: what a watchdog wake does.
    public enum WatchdogWake: String, CaseIterable, Sendable {
        /// The playhead has reached the boundary: stop, attributed to the watchdog.
        case stop
        /// Not there yet: arm again for what is left.
        case rearm
    }

    /// `watchdogDelayMs({outPointSec, atSec, rate, armed, paused})`: how long,
    /// in WALL-CLOCK ms, to arm the watchdog's one timer for, or nil for no
    /// timer (no finite boundary, not armed, paused, or the playhead already at
    /// or past it). Outside the window: the time until the window opens,
    /// rounded UP. Inside it: one poll, never later than the predicted
    /// crossing, never below the timer floor. `nil` rate is any value
    /// `typeof x === "number"` rejects (`deckRate` makes it 1x).
    public static func watchdogDelayMs(outPointSec: Double?, atSec: Double, rate: Double?,
                                       armed: Bool = true, paused: Bool = false) -> Double? {
        guard let outPointSec, outPointSec.isFinite, armed, !paused else { return nil }
        guard atSec < outPointSec else { return nil }
        let remainingWallSec = (outPointSec - atSec) / deckRate(rate)
        let untilWindowSec = remainingWallSec - outPointWatchdogWindowSec
        if untilWindowSec > 0 { return (untilWindowSec * 1000).rounded(.up) }
        return JSMath.max(outPointMinTimerMs, JSMath.min(outPointWatchdogPollMs, (remainingWallSec * 1000).rounded(.up)))
    }

    /// `watchdogWakeAction({atSec, outPointSec})`: the timer was a prediction;
    /// the wake re-reads the playhead and stops only on a genuine crossing.
    public static func watchdogWakeAction(atSec: Double, outPointSec: Double) -> WatchdogWake {
        atSec >= outPointSec ? .stop : .rearm
    }

    /// `outPointOvershootMs({atSec, outPointSec})`: how far past the boundary a
    /// stop landed, in whole ms of CONTENT. Never negative.
    public static func outPointOvershootMs(atSec: Double, outPointSec: Double) -> Double {
        JSMath.max(0, JSMath.round((atSec - outPointSec) * 1000))
    }

    /// The watch `outPointStep` reduces over (`initialOutPointWatch()` is
    /// `OutPointWatch()`).
    public struct OutPointWatch: Equatable, Sendable {
        public var token: Int = 0
        /// The boundary in the source's seconds, nil for an unbounded item.
        public var outPointSec: Double?
        /// The boundary is ahead of the playhead (layers 1 and 2 hold it).
        public var armed = false
        /// A layer stopped this token.
        public var fired = false
        public var playing = false
        /// The deck's rate, already through `deckRate`.
        public var rate: Double = 1
        /// When the watchdog's one timer comes due, nil when none is armed.
        public var timerDueMs: Double?

        public init() {}
    }

    /// An event the watch reduces. Each carries the playhead (`atSec`) and,
    /// where time matters, the wall clock (`nowMs`).
    public enum OutPointEvent: Equatable, Sendable {
        /// A new item and token; the deck is paused after a load. A boundary
        /// that is not a finite number, or at or behind the in-point, is not
        /// armed: the item free-plays.
        case load(token: Int, outPointSec: Double?, atSec: Double)
        case play(atSec: Double, nowMs: Double)
        case pause(atSec: Double)
        /// Re-derives `armed` from the new playhead (a scrub past frees the
        /// episode; a scrub back re-arms it, even after a stop on this token).
        case seek(atSec: Double, nowMs: Double)
        /// `rate` nil is any value that is not a number (1x).
        case rate(Double?, atSec: Double, nowMs: Double)
        /// The watchdog's timer came due.
        case timer(atSec: Double, nowMs: Double)
        /// Layer 1 or 2 reported the boundary for `token`.
        case layer(OutPointLayer, token: Int, atSec: Double, nowMs: Double)
    }

    /// What the native deck is commanded to do. `token` is the op-log spelling.
    public enum OutPointOp: Equatable, Sendable {
        /// Set (or clear, nil) layer 1's `forwardPlaybackEndTime`.
        case endTime(Double?)
        /// Set (or clear, nil) layer 2's boundary observer.
        case boundary(Double?)
        case watchdogArm(ms: Double)
        case watchdogCancel
        /// Pause the deck and report the item's end, attributed to `layer`.
        case stop(OutPointLayer, overshootMs: Double)
        /// A report before the boundary: nothing stops.
        case early(OutPointLayer)
        /// A report for another token, an unarmed boundary, or after the stop.
        case stale(OutPointLayer)

        public var token: String {
            func num(_ value: Double?) -> String { value.map(JSWriter.numberToString) ?? "null" }
            switch self {
            case let .endTime(sec): return "endTime:\(num(sec))"
            case let .boundary(sec): return "boundary:\(num(sec))"
            case let .watchdogArm(ms): return "watchdog.arm:\(num(ms))"
            case .watchdogCancel: return "watchdog.cancel"
            case let .stop(layer, overshootMs): return "outPoint.stop:\(layer.rawValue):\(num(overshootMs))"
            case let .early(layer): return "outPoint.early:\(layer.rawValue)"
            case let .stale(layer): return "outPoint.stale:\(layer.rawValue)"
            }
        }
    }

    /// `outPointStep(state, event)`: the native out-point as a reducer.
    public static func outPointStep(_ state: OutPointWatch, _ event: OutPointEvent) -> (state: OutPointWatch, ops: [OutPointOp]) {
        var ops: [OutPointOp] = []
        switch event {
        case let .load(token, rawBoundary, atSec):
            let outPointSec = rawBoundary.flatMap { $0.isFinite ? $0 : nil }
            let armed = outPointSec.map { atSec < $0 } ?? false
            if state.timerDueMs != nil { ops.append(.watchdogCancel) }
            ops += boundaryOps(armed: armed, outPointSec: outPointSec)
            var next = state
            next.token = token
            next.outPointSec = outPointSec
            next.armed = armed
            next.fired = false
            next.playing = false
            next.timerDueMs = nil
            return (next, ops)

        case let .play(atSec, nowMs):
            if state.fired { return (state, ops) }
            var next = state
            next.playing = true
            let result = rearmWatchdog(next, atSec: atSec, nowMs: nowMs, ops: &ops)
            return (result, ops)

        case .pause:
            if state.timerDueMs != nil { ops.append(.watchdogCancel) }
            var next = state
            next.playing = false
            next.timerDueMs = nil
            return (next, ops)

        case let .seek(atSec, nowMs):
            let armed = state.outPointSec.map { atSec < $0 } ?? false
            if armed != state.armed { ops += boundaryOps(armed: armed, outPointSec: state.outPointSec) }
            var next = state
            next.armed = armed
            next.fired = armed ? false : state.fired
            let result = rearmWatchdog(next, atSec: atSec, nowMs: nowMs, ops: &ops)
            return (result, ops)

        case let .rate(rate, atSec, nowMs):
            var next = state
            next.rate = deckRate(rate)
            let result = rearmWatchdog(next, atSec: atSec, nowMs: nowMs, ops: &ops)
            return (result, ops)

        case let .timer(atSec, nowMs):
            guard let due = state.timerDueMs, nowMs >= due else { return (state, ops) }
            var next = state
            next.timerDueMs = nil
            guard next.playing, next.armed, !next.fired, let outPointSec = next.outPointSec else { return (next, ops) }
            if watchdogWakeAction(atSec: atSec, outPointSec: outPointSec) == .stop {
                let result = stopAt(next, layer: .watchdog, atSec: atSec, ops: &ops)
                return (result, ops)
            }
            let result = rearmWatchdog(next, atSec: atSec, nowMs: nowMs, ops: &ops)
            return (result, ops)

        case let .layer(layer, token, atSec, nowMs):
            guard token == state.token, state.armed, !state.fired, let outPointSec = state.outPointSec else {
                ops.append(.stale(layer))
                return (state, ops)
            }
            if atSec < outPointSec {
                ops.append(.early(layer))
                let result = rearmWatchdog(state, atSec: atSec, nowMs: nowMs, ops: &ops)
                return (result, ops)
            }
            let result = stopAt(state, layer: layer, atSec: atSec, ops: &ops)
            return (result, ops)
        }
    }

    /// Layers 1 and 2 hold the boundary while it is armed and are cleared
    /// when it is not (an end time left behind would stop a freed episode).
    static func boundaryOps(armed: Bool, outPointSec: Double?) -> [OutPointOp] {
        let value = armed ? outPointSec : nil
        return [.endTime(value), .boundary(value)]
    }

    /// Cancel the one timer (if any), then arm it again from here (if it
    /// should be armed at all).
    static func rearmWatchdog(_ state: OutPointWatch, atSec: Double, nowMs: Double, ops: inout [OutPointOp]) -> OutPointWatch {
        var next = state
        if next.timerDueMs != nil {
            ops.append(.watchdogCancel)
            next.timerDueMs = nil
        }
        if next.fired { return next }
        guard let delay = watchdogDelayMs(outPointSec: next.outPointSec, atSec: atSec, rate: next.rate,
                                          armed: next.armed, paused: !next.playing) else { return next }
        ops.append(.watchdogArm(ms: delay))
        next.timerDueMs = nowMs + delay
        return next
    }

    static func stopAt(_ state: OutPointWatch, layer: OutPointLayer, atSec: Double, ops: inout [OutPointOp]) -> OutPointWatch {
        if state.timerDueMs != nil { ops.append(.watchdogCancel) }
        ops.append(.stop(layer, overshootMs: outPointOvershootMs(atSec: atSec, outPointSec: state.outPointSec ?? atSec)))
        var next = state
        next.fired = true
        next.playing = false
        next.timerDueMs = nil
        return next
    }
}

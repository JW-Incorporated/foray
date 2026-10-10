import Foundation

/// The real `EngineTiming` (card NE-15h; plan §4.2-§4.3): the clocks, and
/// timers that are `DispatchSourceTimer`s on the MAIN queue.
///
/// WHY DISPATCH SOURCES AND NOT `Timer`. A `Timer` belongs to a run loop
/// mode: a default-mode timer does not fire while a scroll view tracks. A
/// source on the main queue fires whatever the mode, and a `cancel()` issued
/// on main is final (the handler is queued on the same serial queue, so it
/// cannot run after the cancel returns). The plan names it (§4.3) because
/// NE-32's out-point watchdog re-arms one on every seek and rate change.
///
/// WHY MAIN. The engine is main-confined (plan §4.2); a timer firing
/// elsewhere would be one more hop, and one more place an input could be
/// reordered against a turn.
final class MainQueueTiming: EngineTiming {

    /// Coalescing the system may apply. What runs on the default 50 ms
    /// (code-health-3 R1-12): the core's timers (`EngineTimer`: the position
    /// cadence, the hold release, the seam beat, the narration tick, the
    /// silence cap), the host's 1 Hz Now Playing heartbeat (#1124), the
    /// bridge's snapshot window, the ownership watchdogs, the jingle's ceiling
    /// and the session probe. None of them needs better: the tightest are the
    /// narration tick (250 ms) and the seam beat (500 ms). The one timer that
    /// does is AVDeck's out-point watchdog, which builds its own instance at
    /// 1 ms (NE-32).
    private let leeway: DispatchTimeInterval

    init(leeway: DispatchTimeInterval = .milliseconds(50)) {
        self.leeway = leeway
    }

    var wallMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// Uptime: never jumps when the wall clock is set under a drive.
    var monoMs: Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

    func schedule(afterMs: Double, repeating: Bool, fire: @escaping () -> Void) -> EngineObservation {
        let source = DispatchSource.makeTimerSource(queue: .main)
        // Whole microseconds, at least one: a zero or negative interval would
        // make a repeating source spin the main queue.
        let micros = afterMs.isFinite ? max(1, Int((afterMs * 1000).rounded())) : 1
        let interval = DispatchTimeInterval.microseconds(micros)
        source.schedule(deadline: .now() + interval, repeating: repeating ? interval : .never, leeway: leeway)
        source.setEventHandler(handler: fire)
        source.resume()
        return DispatchTimerObservation(source)
    }
}

/// Cancels its source exactly once, when told to or when dropped. A
/// dispatch source is only ever cancelled here, after `resume()`, so the
/// "cancel a suspended source" trap cannot happen.
private final class DispatchTimerObservation: EngineObservation {
    private var source: DispatchSourceTimer?

    init(_ source: DispatchSourceTimer) {
        self.source = source
    }

    func cancel() {
        source?.cancel()
        source = nil
    }

    deinit {
        source?.cancel()
    }
}

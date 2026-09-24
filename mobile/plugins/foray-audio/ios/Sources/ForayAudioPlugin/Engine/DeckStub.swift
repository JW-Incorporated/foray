import Foundation

// ── A STUB OF THE CORE'S DECK VOCABULARY (card NE-15) ──────────────────────
//
// docs/native-engine-plan.md §14, NE-15: AVDeck starts in week 1, before
// `EngineCore` exists, "against a stub DeckEvent/DeckCommand type in the
// plugin", and swaps to the core's types when NE-14s lands them in
// `foray-engine-core/Sources/ForayEngineCore/Engine/`. So these three types
// are deliberately the SMALLEST shape the adapter needs, not a design for the
// core: NE-14s owns the real vocabulary, and NE-15h moves `DeckDriving` into
// `Engine/Seams.swift` beside the other seams. Nothing outside `Engine/` and
// its tests uses them, and no page, bridge method or legacy path reaches
// AVDeck yet: the app behaves exactly as before this file existed.
//
// The adapter DOES NOT DECIDE. Every event below is an observation handed to
// the core ("observe, don't believe", plan §4.3); what a pause means, whether
// a duration passes the ADR-0007 gate, and what to do after a deadline are
// the core's rulings, fixture-pinned in the `deck-episode` family.

/// The core's load token (plan §4.2 `loadToken`). Every event carries the
/// token of the load it belongs to, so a superseded load's late callback is
/// recognisable as stale by the core as well as by the deck.
typealias DeckToken = Int

/// What the core asks one deck to do.
enum DeckCommand: Equatable {
    /// Attach `url`, then run the readiness-gated pipeline to `startSec`.
    /// `preciseTiming` maps to `AVURLAssetPreferPreciseDurationAndTimingKey`
    /// (P-7: provisional, precise for bounded segments and local files).
    case load(token: DeckToken, url: URL, startSec: Double, preciseTiming: Bool)
    /// Legal only after `.ready` for the current token; refused otherwise.
    case play
    case pause
    /// Zero-tolerance. Before `.ready` it moves the pending start instead.
    case seek(toSec: Double)
    /// Held by the deck and re-applied on every play (plan §4.3).
    case setRate(Float)
    case unload
}

/// `timeControlStatus`, as the core reads it (P-14: waiting is `buffering`).
enum DeckTimeControl: String, Equatable {
    case paused
    case waiting
    case playing
}

/// What one deck observed. Raw facts plus the load token; no policy.
enum DeckEvent: Equatable {
    /// The asset's duration loaded (`nil` when indefinite). The core runs the
    /// ADR-0007 gate on it and may `.unload`; the deck does not wait.
    case durationLoaded(token: DeckToken, durationSec: Double?)
    /// Seeked with zero tolerance and (when `prerolled`) prerolled at rate 0:
    /// `play` is legal from here. `landedSec` is `currentTime()` after the
    /// seek; `elapsedMs` runs from the `.load` command.
    case ready(token: DeckToken, landedSec: Double, prerolled: Bool, elapsedMs: Int)
    /// An interrupted seek or a `preroll` that finished `false`: "not ready".
    /// The deck retries once, then falls back to an ordinary load.
    case notReady(token: DeckToken, attempt: Int, cause: String)
    /// The load did not reach `.ready` inside the deadline (P-13). The deck
    /// has already detached the item, so nothing late can preroll or sound.
    case deadlineExceeded(token: DeckToken, afterMs: Int)
    case failed(token: DeckToken, message: String)
    /// A command the deck will not run (`play` before `.ready`).
    case refused(command: String, reason: String)
    case timeControl(token: DeckToken, status: DeckTimeControl, waitingReason: String?)
    /// The player stopped while the deck intended to play, not at the end of
    /// the item: the reconcile input (plan §4.3 Q-9). The core attributes it
    /// (route change, interruption, or `stop cause=system-pause`).
    case pausedUncommanded(token: DeckToken, atSec: Double)
    case seeked(token: DeckToken, landedSec: Double, finished: Bool)
    case stalled(token: DeckToken)
    case ended(token: DeckToken)
}

/// The seam the engine host drives a deck through (plan §4.1 `Seams.swift`;
/// NE-15h moves it there and adds the recording fake beside the others). The
/// host is main-confined, so a conformer delivers `onEvent` on main.
protocol DeckDriving: AnyObject {
    var onEvent: ((DeckEvent) -> Void)? { get set }
    func send(_ command: DeckCommand)
}

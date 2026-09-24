import Foundation

// ── THE DECK'S VOCABULARY (card NE-14s; plan §4.2-§4.3) ────────────────────
//
// What the core asks ONE deck to do, and what a deck reports back. NE-15
// built AVDeck in week 1 against a stub of these types inside the plugin
// (`ForayAudioPlugin/Engine/DeckStub.swift`, deleted by NE-15h), saying that
// the real vocabulary is this card's; the cases below keep the stub's names
// and payloads so that NE-15h's swap was a deletion, plus the two things the
// core needs that the stub did not: the item id on a load (the core, not the
// deck, knows which queue item a URL is), and the out-point a bounded item
// carries. The seam a deck sits behind, `DeckDriving`, is the plugin's
// (`ForayAudioPlugin/Engine/Seams.swift`), because only the plugin has decks.
//
// The deck DOES NOT DECIDE. Every event is an observation ("observe, don't
// believe", plan §4.3); what it means is `EngineCore`'s ruling.

/// The core's load token (plan §4.2 `loadToken`). Every load gets a fresh one
/// and every event carries the token of the load it belongs to, so a
/// superseded load's late callback is recognisably stale.
public typealias DeckToken = Int

/// What the core asks the deck to do.
public enum DeckCommand: Equatable, Sendable {
    /// Attach the item's audio and run the readiness-gated pipeline to
    /// `startSec` (plan §4.3). The deck answers `.ready` or `.failed` /
    /// `.deadlineExceeded` for THIS token. When the deck already holds the same
    /// healthy source, the load is a seek in its buffer (`DeckPolicy
    /// .sameSourceIsSeek`), which is what makes an interruption's in-place
    /// resume cost no network round trip. `url` is nil only for an item with
    /// no audio of its own (a fixture's bare `$ep`, a spoken line), which the
    /// deck reports as a failed load.
    case load(token: DeckToken, itemId: String, url: String?, startSec: Double, preciseTiming: Bool)
    /// Legal only after `.ready` for the current token. The core also emits it
    /// only with the audio session active (`SessionPolicy`'s audible-start
    /// invariant); the adapter's implicit-activation check is the backstop.
    case play
    case pause
    /// Zero tolerance.
    case seek(toSec: Double)
    /// Held by the deck and re-applied on every play (plan §4.3).
    case setRate(Double)
    /// A bounded item's out-point in the source's seconds (nil disarms). The
    /// three-layer never-early watch is NE-32's; a load drops the armed one.
    case setOutPoint(sec: Double?)
    case unload
}

/// `timeControlStatus`, as the core reads it (P-14: waiting is `buffering`).
public enum DeckTimeControl: String, Equatable, Sendable {
    case paused
    case waiting
    case playing
}

/// What the deck observed. Raw facts plus the load token; no policy.
public enum DeckEvent: Equatable, Sendable {
    /// The asset's duration loaded (nil when indefinite).
    case durationLoaded(token: DeckToken, durationSec: Double?)
    /// Seeked with zero tolerance and prerolled: `play` is legal from here.
    case ready(token: DeckToken, landedSec: Double, prerolled: Bool, elapsedMs: Int)
    /// An interrupted seek or an unfinished preroll; the deck retries itself.
    case notReady(token: DeckToken, attempt: Int, cause: String)
    /// The load did not become ready inside its deadline (P-13).
    case deadlineExceeded(token: DeckToken, afterMs: Int)
    case failed(token: DeckToken, message: String)
    /// A command the deck would not run (`play` before `.ready`).
    case refused(command: String, reason: String)
    case timeControl(token: DeckToken, status: DeckTimeControl, waitingReason: String?)
    /// The player stopped while the deck intended to play, not at the item's
    /// end: the reconcile input (plan §4.3 Q-9).
    case pausedUncommanded(token: DeckToken, atSec: Double)
    case seeked(token: DeckToken, landedSec: Double, finished: Bool)
    case stalled(token: DeckToken)
    /// The item played to its end (or to its out-point).
    case ended(token: DeckToken)
}

/// What the deck says RIGHT NOW, read synchronously on main by the host
/// before every input (`AVPlayer.currentTime()`, the item's duration,
/// `timeControlStatus`, whether the item reached its end).
///
/// WHY A READING AND NOT STATE THE CORE KEEPS. The JS manager asks its
/// element at the moment it decides (`backend.currentTime` for the position it
/// saves, `backend.paused` for "is the listener hearing this"), and a position
/// the core remembered from the last periodic observation would be up to a
/// tick stale at every pause: a pause at 42.7 s would save 42.0. The host's
/// reading costs one property access; the core stays pure because the reading
/// is an input like any other.
public struct DeckReading: Equatable, Sendable {
    /// The playhead in the source's seconds; nil while nothing is loaded.
    public var positionSec: Double?
    public var durationSec: Double?
    /// Sound is coming out (the deck's rate is non-zero).
    public var audible: Bool
    /// The item ran out and the deck is parked on its end.
    public var ended: Bool

    public init(positionSec: Double? = nil, durationSec: Double? = nil, audible: Bool = false, ended: Bool = false) {
        self.positionSec = positionSec
        self.durationSec = durationSec
        self.audible = audible
        self.ended = ended
    }

    public static let idle = DeckReading()
}

/// The moment an input arrives: both clocks (wall for rows the page reads,
/// monotonic for every duration, because the wall clock can jump under a
/// drive) and the deck's reading.
public struct EngineNow: Equatable, Sendable {
    public var wallMs: Double
    public var monoMs: Double
    public var deck: DeckReading

    public init(wallMs: Double, monoMs: Double, deck: DeckReading = .idle) {
        self.wallMs = wallMs
        self.monoMs = monoMs
        self.deck = deck
    }
}

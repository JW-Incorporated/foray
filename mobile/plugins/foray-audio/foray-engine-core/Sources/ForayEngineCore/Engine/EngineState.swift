import Foundation

/// The engine's composite state (plan §4.2): the six reducer states plus
/// everything the JS manager keeps beside its reducer, as one value. The core
/// is a function of this and an input, so a scenario, an XCTest and the car
/// all start from the same place and can compare where they ended up.
///
/// Every field the JS manager has is named after it, so the port can be read
/// against `player/queue-manager.js` line for line.
public struct EngineState: Equatable {
    /// The reducer (`PlayerQueueState`, NE-07s): what the transport believes.
    public var player: PlayerQueueState = .idle

    // MARK: the queue, and the loaded/target split

    public var queue: [EngineItem] = []
    /// `currentIndex`: what is LOADED (or being loaded). `savePosition` writes
    /// against it, so it moves only when a load starts, never at the skip.
    public var currentIndex: Int = -1
    /// `_targetIndex`: where a skip is HEADING before its load starts. Kept
    /// apart from `currentIndex` so two fast skips advance two items while
    /// the outgoing episode's playhead is still saved against the right id.
    public var targetIndex: Int?
    /// `_loadedId` (`playheadItemId`): the item the deck actually HOLDS, set
    /// only when its load lands. A failed or superseded load never claims it.
    public var loadedId: String?
    /// The token of the load the deck holds (`loadedId`'s).
    public var loadedToken: DeckToken?
    /// The load in flight that owns the deck, if any. A `.ready` for any
    /// other token is a superseded load and plays nothing (corner case #19).
    public var pendingLoad: PendingLoad?
    public var lastToken: DeckToken = 0

    // MARK: the audio session (plan §4.4)

    public var session: SessionPolicy.Phase = .inactive
    public var holdPolicy: SessionPolicy.HoldPolicy = .default
    /// Whether THIS process activated the session (a stale `appWasSuspended`
    /// interruption is told apart by it).
    public var activatedInProcess = false
    /// An intent parked for the activation it asked for, answered in the same
    /// turn by `.sessionResult`.
    public var pendingActivation: PendingActivation?
    public var lastRequestId = 0
    public var holdTimerArmed = false

    // MARK: who paused, and why (the manager's flags)

    /// `_pausedByListener`: the last pause was a press or a stop, so an OS
    /// should-resume must not bring it back (audit round 2, p-car-3).
    public var pausedByListener = false
    /// `_pausedByRoute`: a route went away (corner case #13); only a press or
    /// a known car route reappearing clears it.
    public var pausedByRoute = false
    /// `_knownCarRoutes`.
    public var knownCarRoutes: Set<String> = []
    /// For the 500 ms route attribution of an uncommanded pause (plan §4.3).
    public var lastRouteLostAtMono: Double?
    public var lastUncommandedPauseAtMono: Double?

    // MARK: rate and position

    /// `_rate`: the listener's speed, always on the ladder.
    public var rate: Double = PlaybackRate.defaultRate
    /// A seek written down while nothing is loaded (`SEEK.PEND`): the next
    /// play's own start.
    public var pendingStartSec: Double?
    /// The stored `cp_pos:` rows the engine owns, read for a cold resume.
    public var positions: [String: ResumeRules.StoredPosition] = [:]
    /// `_lastPersisted`: what the periodic writer measures its delta from.
    public var lastPersisted: ResumeRules.LastWrite?
    /// PositionStore's `_lastEmitted`: the once-a-minute event mark per item.
    public var eventMarks: [String: Double] = [:]
    public var pendingEvents: [PendingEvent] = []
    public var lastEventSeq = 0
    public var positionTimerArmed = false
    public var buffering = false

    // MARK: continuation (plan §5.5)

    public var autoAdvance = false
    public var planSeq: Int?
    public var chain: [EngineContract.Hop] = []
    public var previousHop: EngineContract.Hop?
    public var advanceLog: [AdvanceEntry] = []
    public var lastAdvanceSeq = 0
    /// The hop whose item is loading now, so a failed start is `chain-start`.
    public var startingHop: EngineContract.Hop?

    // MARK: rows the page reads back

    /// `lastEpisodeRow` as the page sent it, stored verbatim plus
    /// `updated_at` when its item actually plays.
    public var lastEpisodeRow: JSONNode?
    public var lastEpisodeRowWritten = false
    public var forayId: String?
    /// The listener closed the player, or deleted their data (card NE-18):
    /// the snapshot's `mode` is `none` from then until something is played
    /// or loaded again, which is the one moment Now Playing becomes nil and
    /// every remote command is disabled (plan §4.5). A pause, an interruption
    /// and a relinquish never set it.
    public var closed = false

    // MARK: the Foray tape (NE-30s)

    /// `_gapUntil`: the seam beat's ABSOLUTE deadline on the monotonic clock,
    /// stamped at the out-point, so the next load runs INSIDE the beat rather
    /// than before it. Non-nil exactly while a beat is running (`inSeamGap`),
    /// which includes the load happening inside it.
    public var gapUntilMono: Double?
    /// When the beat was armed (the out-point) and the gap it asked for, for
    /// the packed seam row.
    public var gapArmedAtMono: Double?
    public var gapAskedMs: Double = 0
    /// `_gapFinish`: the load whose `itemLoaded` waits out the beat's
    /// remainder, by its token. Compared with `lastToken` when the wait ends:
    /// a newer load (a skip, a jump, the ladder) means it is abandoned.
    public var gapParkedToken: DeckToken?
    /// `_gapCut`: a transport action cut the beat; the parked wait is released
    /// only once that action has issued whatever load it was going to.
    public var gapCut = false
    /// The `.seamBeat` timer is armed.
    public var seamTimerArmed = false
    /// `_forayOptions`: what the load-time ladder reads (`setQueueFromForay`).
    public var forayIsLocalFile = false
    public var forayAllowAdPad = false
    /// The Foray's title, for its `cp_foray` row.
    public var forayTitle: String?
    /// The item the standby deck was last asked to prepare (a seam that finds
    /// it there was a prepare hit).
    public var preparedItemId: String?
    /// The DeckPair's report on the load in flight (NE-32, `.prepared`), for
    /// the packed seam row; nil when the deck sent none (one deck, the
    /// parity driver), and the row then says what it said before NE-32.
    public var deckPrepare: DeckPrepareReport?
    /// Segments ADR-0007's ladder refused at load (the snapshot's `skippedSegments`).
    public var skippedSegments = 0
    /// The `cp_foray` write throttle: foray-progress.js `ForayProgressStore`'s
    /// gate, its 5 s clock throttle per Foray, and the refused-write count.
    var forayThrottle = ResumeRules.ForayWriteThrottle()
    /// A finished Foray's row is marked once (client.js `persistForayProgress`).
    public var forayFinishedWritten = false

    /// `inSeamGap`: a beat is running.
    public var inSeamGap: Bool { gapUntilMono != nil }

    // MARK: the app around the engine

    public var backgrounded = false
    public var pageVisible = true
    /// BackgroundGrace: `held(reason)` from begin to end.
    public var grace: GraceReason?
    /// The last remote press, for `dupCandidate` (recorded, never dropped).
    public var lastRemote: LastRemote?

    public init() {}

    /// The item `currentIndex` points at.
    public var currentItem: EngineItem? {
        queue.indices.contains(currentIndex) ? queue[currentIndex] : nil
    }

    /// Whether the transport believes something is (or is about to be)
    /// audible: `playing`, `loadingItem`, `transitioning`.
    public var isRunning: Bool {
        switch player {
        case .playing, .loadingItem, .transitioning: return true
        case .idle, .ended, .interrupted: return false
        }
    }

    /// The reducer says `playing`.
    public var isPlaying: Bool {
        if case .playing = player { return true }
        return false
    }

    /// The reducer state's `type`, as the JS names it.
    public var stateType: String { EngineState.typeName(player) }

    public static func typeName(_ state: PlayerQueueState) -> String {
        switch state {
        case .idle: return "idle"
        case .loadingItem: return "loadingItem"
        case .playing: return "playing"
        case .transitioning: return "transitioning"
        case .interrupted: return "interrupted"
        case .ended: return "ended"
        }
    }
}

/// A load in flight, and the second it was asked to land on: until the deck
/// holds the item, that is where the listener is (client.js
/// `episodePositionSec`'s `loadingStart`, audit round 2 p-impatient-1).
public struct PendingLoad: Equatable {
    public let token: DeckToken
    public let itemId: String
    public let startSec: Double
    /// A rendered narration bridge (`_playTransitionBridge`, NE-30s): it plays
    /// the moment it lands, with no `itemLoaded` (the reducer is
    /// `transitioning`, not loading).
    public var bridge = false
}

/// A play-ish intent waiting for its activation's answer.
public struct PendingActivation: Equatable {
    public let requestId: Int
    public let intent: DeferredIntent
    public let source: EngineSource
}

/// What runs once the session is active.
public enum DeferredIntent: Equatable {
    case playIndex(Int, startSec: Double?)
    case resume
    case skipNext
    case skipPrevious
    case interruptionResume
    case routeResume
    case coldPlay
    case walkHop(EngineContract.Hop)
    case audition(text: String, voiceId: String?)
}

public struct LastRemote: Equatable {
    public let command: MediaMapping.RemoteCommand
    public let atMono: Double
}

/// What the DeckPair said about one load (NE-32; `DeckEvent.prepared`).
public struct DeckPrepareReport: Equatable {
    public var token: DeckToken
    public var hit: Bool
    public var stages: [Vocabulary.Stage]

    public init(token: DeckToken, hit: Bool, stages: [Vocabulary.Stage]) {
        self.token = token
        self.hit = hit
        self.stages = stages
    }
}

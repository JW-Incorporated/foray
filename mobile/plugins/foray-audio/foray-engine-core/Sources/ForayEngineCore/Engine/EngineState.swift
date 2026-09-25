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

    // MARK: the narrating overlay and the jingle (NE-31s)

    /// `_voice`: the listener's chosen narration voice, or nil for the
    /// synthesiser's own pick. Read at every `speak`, never cached; kept in
    /// the restore record so a cold narration speaks in the same voice.
    public var voiceId: String?
    /// `lastVoiceFallback`: whether the last line spoke in another voice than
    /// the one asked for (V-01's notice); nil until a line has spoken, and
    /// again after a speak that failed.
    public var lastVoiceFallback: Bool?
    /// `_loadedIsSynth` and everything the JS keeps beside it: the spoken
    /// line the loaded item IS, from the synthesiser accepting it until a
    /// deck item's load lands. Nil while the playhead is a deck item.
    public var narration: SpokenLine?
    /// The last utterance `seq` stamped (`_speakSeq`): every `speak` is a new
    /// one, and every answer names the one it is about.
    public var speakSeq = 0
    /// `_advancedSpeakSeq`: the utterance already advanced past, so a finish
    /// (or the deadline) advances each line at most once.
    public var advancedSpeakSeq: Int?
    /// The `.narrationTick` one-shot is armed.
    public var narrationTickArmed = false
    /// A speed tap that landed while narration was audible (corner case #18):
    /// `rate` already holds it; the deck gets it when the narration ends
    /// (`restoreRate`), never mid-word.
    public var pendingRate: Double?
    /// `_interludeEnabled`: the listener's `cp_interlude`.
    public var interludeEnabled = true
    /// `_interludeActive`: the jingle is sounding (a subset of `inSeamGap`).
    public var inInterlude = false
    /// `_beatUntil`: the BEAT's own deadline while the jingle stretches it,
    /// so the jingle's end falls back to what the beat still owes.
    public var beatUntilMono: Double?
    /// The silence node is running (flagged off; NE-34's).
    public var silenceActive = false
    /// `_disposed`: the engine was torn down; the core answers nothing more.
    public var tornDown = false

    /// `isNarrationPlayhead`: a spoken line is the playhead.
    public var isNarrationPlayhead: Bool { narration != nil }

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
    /// A SPOKEN line (NE-31s): the synthesiser was asked to speak utterance
    /// `spokenSeq`, and `NarratorEvent.started` / `.failed` for that seq is
    /// this load landing or failing. Nil for a deck load.
    public var spokenSeq: Int?
}

/// A spoken line the playhead is on (NE-31s): queue-manager.js
/// `_loadedIsSynth`, `_narrationStartedAtMs`, `_narrationPaused` and
/// `_narrationPausedAtMs`, as one value that exists exactly while they mean
/// something. Its clock is WALL time since the line started (no deck plays
/// it), frozen while it is paused and shifted forward by the pause on resume.
public struct SpokenLine: Equatable {
    public let seq: Int
    public let itemId: String
    public var startedAtMono: Double
    public var paused = false
    public var pausedAtMono: Double?
    /// When the pulse armed last was due, to tell a suspended process from a
    /// busy one (`_narrationTickDueAtMs`).
    public var tickDueAtMono: Double?
    /// The synthesiser said `didFinish` for it (nothing left to drop).
    public var finished = false

    public init(seq: Int, itemId: String, startedAtMono: Double) {
        self.seq = seq
        self.itemId = itemId
        self.startedAtMono = startedAtMono
    }

    /// `narrationElapsedSec` at `monoMs`.
    public func elapsedSec(atMono monoMs: Double) -> Double {
        let at = paused ? (pausedAtMono ?? monoMs) : monoMs
        return Swift.max(0, (at - startedAtMono) / 1000)
    }
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

import Foundation

// ── WHAT GOES INTO `EngineCore.handle` (card NE-14s; plan §4.2) ─────────────
//
// Every observation and every intent the engine acts on is one of these, and
// nothing else reaches the core: the host (NE-15h's `ForayEngine`) turns KVO,
// notifications, remote-command handlers, timers and the bridge into inputs,
// feeds them in on main, and interprets what comes back. That single door is
// what lets a parity scenario drive the same core the car drives.

/// One queue item as the page built it (plan §3 A-1: the page owns
/// `buildForayQueue` and "Jump back in"; the engine plays what it is handed).
/// The node is kept VERBATIM, because rows the page reads back are built from
/// it; the fields the rules read are lifted out once, the way the JS reads
/// them (`typeof n === "number"` for numbers, `kind === "tts"`).
public struct EngineItem: Equatable {
    public let id: String
    public let node: JSONNode
    public let kind: PlayerItemKind
    public let audioUrl: String?
    public let startSec: Double?
    public let endSec: Double?
    public let durationSec: Double?

    /// Nil for an item with no non-empty string `id`: the contract requires
    /// one, and every rule keys on it.
    public init?(node: JSONNode) {
        guard let id = node["id"]?.stringValue, !id.isEmpty else { return nil }
        self.id = id
        self.node = node
        kind = node["kind"]?.stringValue == EngineConstants.QueueState.tts ? .tts : .episode
        let url = node["audio_url"]?.stringValue
        audioUrl = (url?.isEmpty ?? true) ? nil : url
        startSec = node["start_sec"]?.numberValue
        endSec = node["end_sec"]?.numberValue
        durationSec = node["duration_sec"]?.numberValue
    }

    /// `boundsOf(item)`: the slice this item occupies, or nil for a whole
    /// episode. The ONE definition (`ItemBounds.make`, queue-state.js
    /// `itemBounds`), so the in-point, the out-point and position writes
    /// cannot disagree about a malformed item.
    public var bounds: ItemBounds? { ItemBounds.make(startSec: startSec, endSec: endSec) }

    /// `refOf(item)`: what the reducer knows of it.
    public var ref: QueueItemRef { QueueItemRef(id: id, kind: kind, bounds: bounds) }

    // MARK: what a built Foray item carries (NE-30s)

    /// The item as the seam rule reads it (seam-gap.js `isSegment`).
    public var seam: SeamItem { SeamItem(startSec: startSec, endSec: endSec) }

    /// ADR-0007's load-time ladder reads these off the BUILT item
    /// (foray-queue.js carries them "so the gate never has to go back to a
    /// catalogue it does not own"). `!item?.needs_drift_check` is truthiness.
    public var needsDriftCheck: Bool { node["needs_drift_check"]?.isTruthy ?? false }
    public var daiSuspected: Bool { node["dai_suspected"]?.isTruthy ?? false }
    public var referenceDurationSec: Double? { node["reference_duration_sec"]?.numberValue }
    /// `item.ad_pad_sec ?? undefined`: null is no pad.
    public var adPadSec: Double? { node["ad_pad_sec"]?.numberValue }

    /// `_isSynthNarration(item)`: a `tts` item with a non-empty `script` and
    /// no file. It is SPOKEN (NE-31s), never loaded on a deck; a narration item
    /// with a file (a rendered bridge) plays on the deck like any other audio.
    public var isSynthNarration: Bool {
        guard kind == .tts, audioUrl == nil, let script = node["script"]?.stringValue else { return false }
        return !script.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The item as the Foray clock and the structural check read it.
    public var forayItem: ForayItem { ForayItem(node: node) }

    /// The item as TransportPolicy's Foray-clock rules read it.
    public var transportItem: TransportPolicy.Item {
        TransportPolicy.Item(startSec: startSec, endSec: endSec, authoredEndSec: node["authored_end_sec"]?.numberValue,
                             durationSec: durationSec, kind: node["kind"]?.stringValue,
                             hasAudioUrl: node["audio_url"]?.isTruthy ?? false)
    }
}

/// Why a play-ish intent arrived; recorded before anything else (D-4).
public typealias EngineSource = Vocabulary.Source

/// The manager's own queue surface: a page-built queue and a play at an index.
/// The contract's `playEpisode` is this with a one-item queue; M2's
/// `playForay` hands its built items here too; and a parity scenario's
/// `loadQueue` / `play(index)` / `setRate(anything)` arrive through it, so the
/// fixtures exercise exactly the paths the contract commands take.
public enum QueueInput: Equatable {
    /// `loadQueue(items)`: replace the queue; nothing loads or plays.
    case load([EngineItem])
    /// `play(index, {startOffset})`.
    case playIndex(Int, startSec: Double?, source: EngineSource)
    /// `setRate(rate)` with whatever the caller had: nil stands for every
    /// value that is not a number, which `PlaybackRate.normalize` snaps to 1x.
    case setRate(Double?)
    /// `seek(seconds, {precise})` in the source's own seconds.
    case seek(sec: Double, precise: Bool)
    /// `setQueueFromForay(foray, {isLocalFile, allowAdPad})` with the PAGE's
    /// build (NE-30s): the queue is replaced and nothing loads, as `load`, and
    /// the two options the load-time ladder reads are kept for its loads.
    case loadForay([EngineItem], isLocalFile: Bool, allowAdPad: Bool)
}

/// A press from the lock screen, the car or a headset (`MPRemoteCommand`).
public struct RemotePress: Equatable {
    public var command: MediaMapping.RemoteCommand
    /// `changePlaybackPosition`'s target, or a skip command's interval.
    public var value: Double?
    /// The output route's port type when it arrived (`carAudio`, ...).
    public var routePort: String?
    /// False when the handler arrived off main (plan §4.2: written, then run
    /// through `DispatchQueue.main.sync`).
    public var onMain: Bool

    public init(_ command: MediaMapping.RemoteCommand, value: Double? = nil, routePort: String? = nil, onMain: Bool = true) {
        self.command = command
        self.value = value
        self.routePort = routePort
        self.onMain = onMain
    }
}

/// The answer to a `.sessionActivate` (plan §4.2: request and response in one
/// turn; the interpreter calls the seam synchronously and feeds this straight
/// back in before any other input).
public struct SessionResult: Equatable {
    public var requestId: Int
    public var ok: Bool
    /// The failure token (`cannot-interrupt-others`, `cannot-start-playing`,
    /// anything else reads as `other`).
    public var error: String?
    public var activateMs: Double?

    public init(requestId: Int, ok: Bool, error: String? = nil, activateMs: Double? = nil) {
        self.requestId = requestId
        self.ok = ok
        self.error = error
        self.activateMs = activateMs
    }
}

/// An `AVAudioSession.routeChangeNotification`, as far as the rules read it.
public struct RouteChange: Equatable {
    /// `.oldDeviceUnavailable`: headphones out, the car switched off.
    public var oldDeviceUnavailable: Bool
    /// The route's name: what "a known car" is remembered by (corner case #13).
    public var routeName: String?
    public var isCarRoute: Bool
    /// The port type, for the `session` row (never the name: plan §10).
    public var portType: String?

    public init(oldDeviceUnavailable: Bool, routeName: String? = nil, isCarRoute: Bool = false, portType: String? = nil) {
        self.oldDeviceUnavailable = oldDeviceUnavailable
        self.routeName = routeName
        self.isCarRoute = isCarRoute
        self.portType = portType
    }
}

/// The audio session's notifications (plan §4.4).
public enum SessionEvent: Equatable {
    /// `reason` is the raw `AVAudioSession.InterruptionReason` token; anything
    /// outside the closed vocabulary reads as `unknown`.
    case interruptionBegan(reason: String?)
    case interruptionEnded(shouldResume: Bool)
    case route(RouteChange)
    case mediaServicesReset
}

/// The process and the app around the engine.
public enum LifecycleEvent: Equatable {
    /// A launch that restored a queue and a position BEFORE any network call
    /// (corner case #15). `autoplay` is a car's play arriving for it (the
    /// cold path, plan §4.5).
    case coldLaunch(queue: [EngineItem], index: Int, autoplay: Bool)
    /// `didEnterBackground`. Also the moment the position is flushed
    /// (client.js `flushPositions` on `visibilitychange` hidden, #689).
    case background
    /// `willTerminate`: the last chance to write the position (client.js
    /// `flushPositions` on `pagehide`). It is delivered only when iOS ends an
    /// app that is still running, so it is a courtesy; the background flush
    /// is the one that matters on a phone that gets pocketed.
    case terminating
    /// The app came back: ask the deck what happened while nobody was
    /// listening (#263).
    case foreground
    /// The engine itself is being torn down (card NE-31s; the page's
    /// `dispose()` in the JS manager): whatever is speaking or sounding is
    /// silenced, the deck and the jingle player are released, every timer is
    /// cancelled, and the core answers nothing from then on. The reducer's
    /// state is left as it was: a teardown is not a transport action.
    case teardown
}

/// The timers the core arms through `.timerArm` and hears back from.
public enum EngineTimer: String, Equatable, Sendable, CaseIterable {
    /// The periodic position write while playing (corner case #17).
    case positionTick = "position-tick"
    /// BackgroundGrace's expiration handler fired.
    case graceExpired = "grace-expired"
    /// `pauseHoldPolicy = .until(m)` ran out while paused.
    case holdExpired = "hold-expired"
    /// The seam beat's remainder ran out (NE-30s): the wait parked on it
    /// goes on, and the next segment becomes audible.
    case seamBeat = "seam-beat"
    /// The narration pulse (NE-31s, queue-manager.js `_tickNarration`): every
    /// `NARRATION_TICK_MS` while a spoken line is audible, a one-shot the core
    /// re-arms. It repaints the surface (nothing else moves the clock of a
    /// line no deck is playing), watches for a suspension, and enforces the
    /// line's deadline.
    case narrationTick = "narration-tick"
    /// The silence node's hard cap (NE-31s; the node is NE-34's, flagged off):
    /// `INTERLUDE_CEILING_SEC` from the out-point, after which only grace covers.
    case silenceCap = "silence-cap"
}

// ── THE NARRATING OVERLAY (card NE-31s) ─────────────────────────────────────
//
// A spoken line is not a deck item: the synthesiser speaks it (NE-33's
// SpeechNarrator), so what the core needs from the world is what the JS
// manager gets from its narration bridge (player/tts-bridge.js), as inputs
// keyed by the utterance's `seq`, the identity the core stamped on `speak`.

/// How the synthesiser answered `resume(seq)` (queue-manager.js
/// `_resumeNarration` reads the bridge's answer, not just its arrival).
public enum NarrationResumeAnswer: Equatable {
    /// The line continues from the word it paused on.
    case continued
    /// The line restarted from its first word (Android's emulated pause,
    /// `fromStart: true`): the line's clock restarts with it.
    case fromStart
    /// The voice did not resume (an older shell, a synthesiser that refused):
    /// the line stays paused and its clock stays frozen.
    case refused(reason: String)
    /// Nobody answered (no transport at all): the voice never stopped, so the
    /// clock is not frozen either. The honest reading of no answer.
    case noAnswer
}

/// What the synthesiser tells the engine about the utterance `seq`.
public enum NarratorEvent: Equatable {
    /// `speak(seq)` was accepted and the line is audible. `voiceFallback`: it
    /// is being spoken in another voice than the one asked for (V-01).
    case started(seq: Int, voiceFallback: Bool)
    /// `speak(seq)` was refused (no synthesiser, nothing it could speak).
    case failed(seq: Int, reason: String)
    /// `didFinish`: the whole line was spoken. The only end that advances.
    case finished(seq: Int)
    /// `didCancel`: a stop, a replacement, or the session taken from under
    /// the line. NEVER an advance (L-05: stop never maps to finished).
    case cancelled(seq: Int)
    /// The answer to `resume(seq)`.
    case resumed(seq: Int, answer: NarrationResumeAnswer)
}

/// The jingle player's reports (InterludePlayer, NE-34).
public enum InterludeEvent: Equatable {
    /// The jingle ended on its own (`ended`), failed (`error`), or could not
    /// start at all (`refused`, reported the moment `start` is refused).
    case ended(reason: String)
}

/// Everything `EngineCore.handle` accepts.
public enum EngineInput: Equatable {
    /// A page command (engineSend), with where it came from.
    case command(EngineContract.Command, source: EngineSource)
    case queue(QueueInput)
    case remote(RemotePress)
    case deck(DeckEvent)
    case sessionResult(SessionResult)
    case session(SessionEvent)
    case lifecycle(LifecycleEvent)
    case timer(EngineTimer)
    /// The synthesiser speaking a line of the Foray's narration (NE-31s).
    case narrator(NarratorEvent)
    /// The interlude jingle (NE-31s).
    case interlude(InterludeEvent)
}

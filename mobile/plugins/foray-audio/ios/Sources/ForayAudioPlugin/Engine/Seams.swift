import Foundation
import ForayEngineCore

// ── THE ENGINE'S SEAMS (card NE-15h; docs/native-engine-plan.md §4.1-§4.2) ──
//
// `ForayEngine` (the host) never touches AVFoundation, AVAudioSession,
// MediaPlayer, UIKit or a DispatchSource. Everything it does to the world goes
// through one of the protocols below, and everything the world tells it comes
// back through a handler it registered on one of them. Each has a recording
// fake in the plugin's test target (`ForayAudioPluginTests/Engine/`), so the
// host runs headless on the Simulator with no audio, no session and no app.
//
// WHY THIS IS THE CARD THAT MAKES NE-16, NE-17 AND NE-18 TESTABLE. A package
// test has no host app: `UIApplication.shared` does not exist, the audio
// session cannot be interrupted on demand, and `MPRemoteCommandCenter` cannot
// be asked which targets it holds. Behind these seams, "a failed activation
// plays nothing", "a car's play activates and plays in one turn" and "a
// relinquish leaves no observer alive" are assertions on fakes, not hopes.
//
// THE RULE THE SHELL INVARIANTS PIN: only the real conformers (AVDeck here;
// AudioSessionOwner NE-16, BackgroundGrace NE-16g, RemoteSurface and
// NowPlayingPublisher NE-18, the speech narrator NE-33) import AVFoundation,
// MediaPlayer or UIKit. This file and `ForayEngine.swift` import Foundation
// and the core only.
//
// ONE THREAD. The engine is main-confined (plan §4.2). A conformer calls every
// handler it was given ON MAIN; the host asserts that (`MainActor
// .assumeIsolated`) rather than hopping, because a hop would reorder an input
// against the turn in progress. A conformer whose platform delivers off main
// hops first: RemoteSurface's `DispatchQueue.main.sync` (plan §4.2), AVDeck's
// `DispatchQueue.main.async` around every KVO and completion.

/// Something the host registered and must cancel at teardown: a session
/// observer, a remote-command target, a lifecycle observer, a timer. The host
/// keeps every one it is handed, and `ForayEngine.teardown()` cancels them
/// all; a fake counts the ones still live.
protocol EngineObservation: AnyObject {
    func cancel()
}

// MARK: - The audio session (AudioSessionOwner, NE-16)

/// What `activate()` answered. The host turns it into the core's
/// `.sessionResult` in the SAME turn (plan §4.2), before any other command.
struct SessionActivation: Equatable {
    var ok: Bool
    /// The failure token (`cannot-interrupt-others`, `cannot-start-playing`,
    /// anything else reads as `other` in the core).
    var error: String?
    /// How long `setActive(true)` took: every `session` row carries it, and a
    /// device p95 over 100 ms is what would add the reserved CommandGate.
    var activateMs: Double?

    init(ok: Bool, error: String? = nil, activateMs: Double? = nil) {
        self.ok = ok
        self.error = error
        self.activateMs = activateMs
    }
}

/// The one owner of `AVAudioSession` (plan §4.4). SYNCHRONOUS on purpose:
/// activation is a request and a response inside one turn, so the core never
/// emits an audible command before the answer, and a failure leaves nothing
/// to cancel.
protocol SessionControlling: AnyObject {
    func activate() -> SessionActivation
    func deactivate(notifyOthers: Bool)
    func reapplyCategory()
    func rebuild()
    /// Interruptions, route changes and media-services resets, on main.
    func observe(_ handler: @escaping (SessionEvent) -> Void) -> EngineObservation
}

// MARK: - Background time and the app's lifecycle (BackgroundGrace, NE-16g)

/// A live background task. The real conformer maps it to
/// `UIBackgroundTaskIdentifier`; nil from `beginTask` is `.invalid`.
typealias BackgroundTaskID = Int

protocol BackgroundTasking: AnyObject {
    /// Begin a task that keeps the app alive while the engine intends to play
    /// but nothing is audible yet. `expiration` runs ON MAIN when the system
    /// takes the time back, and the host ends the task inside it, before it
    /// returns (UIKit's rule). Nil: the system refused (`.invalid`).
    func beginTask(named name: String, expiration: @escaping () -> Void) -> BackgroundTaskID?
    func endTask(_ id: BackgroundTaskID)
    /// `UIApplication.backgroundTimeRemaining` in seconds, nil while in the
    /// foreground (UIKit reports `greatestFiniteMagnitude` there).
    var backgroundTimeRemainingSec: Double? { get }
    /// `didEnterBackground` / `willEnterForeground` / `willTerminate` as
    /// `.background` / `.foreground` / `.terminating`, on main.
    func observeLifecycle(_ handler: @escaping (LifecycleEvent) -> Void) -> EngineObservation
}

// MARK: - Remote commands (RemoteSurface, NE-18)

/// What a remote-command handler returns to the system. RemoteSurface maps it
/// onto `MPRemoteCommandHandlerStatus`.
enum RemoteVerdict: Equatable, Sendable {
    case success
    /// Nothing to act on (plan §4.5: a cold play with no restore record).
    case noActionableNowPlayingItem
    case commandFailed

    /// The core's refusals for one press. None is success; `not-loaded` is
    /// "nothing to play"; any other refusal failed the command.
    init(failures: [String]) {
        if failures.isEmpty {
            self = .success
        } else if failures.contains(EngineContract.Refusal.notLoaded.rawValue) {
            self = .noActionableNowPlayingItem
        } else {
            self = .commandFailed
        }
    }

    /// The status as the `remote` row records it (the `MPRemoteCommandHandlerStatus`
    /// case name RemoteSurface returns for it).
    var token: String {
        switch self {
        case .success: return "success"
        case .noActionableNowPlayingItem: return "noActionableNowPlayingItem"
        case .commandFailed: return "commandFailed"
        }
    }
}

/// `MPRemoteCommandCenter`, one target per command. In native mode the engine
/// is the only registrant (plan §4.5).
protocol RemoteCommandRegistering: AnyObject {
    /// The handler is called ON MAIN with the press as the conformer read it
    /// (route port, whether it arrived off main, the scrub target), and
    /// returns the core's verdict synchronously. A skip press carries NO
    /// value: the OS's interval is ignored, and the core steps by the
    /// founder's pair (`EngineConstants`).
    func addTarget(_ command: MediaMapping.RemoteCommand,
                   handler: @escaping (RemotePress) -> RemoteVerdict) -> EngineObservation
    func setEnabled(_ enabled: Bool, for command: MediaMapping.RemoteCommand)
}

// MARK: - Now Playing (NowPlayingPublisher, NE-18)

/// `MPNowPlayingInfoCenter`, fed from `MediaMapping`'s output. Nothing is
/// cleared on a pause, an unresumed interruption or a relinquish (plan §4.5):
/// `clear()` is for a finished Foray, a close or a data deletion only.
///
/// The host decides WHEN (every transition and every seek, and whenever the
/// playhead has moved away from where the OS would have extrapolated it); the
/// conformer decides nothing but the dictionary. The whole `SessionView` is
/// handed over because the rate the entry carries depends on the playback
/// state: the true rate while `PLAYING`, 0 otherwise, and `playbackState`
/// itself is never written (OQ-8: it is macOS-only).
protocol NowPlayingWriting: AnyObject {
    func write(_ view: MediaMapping.SessionView)
    func clear()
}

/// The `MPNowPlayingInfoPropertyPlaybackRate` an entry carries (plan §4.5):
/// the true rate while `PLAYING` (0 while stalled or loading, which
/// `MediaMapping.positionState` already says), and 0 while paused,
/// interrupted or ended. One definition, read by the host's drift check and
/// by NowPlayingPublisher, so the extrapolation the host expects is the one
/// the OS runs.
enum NowPlayingRate {
    static func of(_ view: MediaMapping.SessionView) -> Double {
        guard view.playbackState == MediaMapping.playing else { return 0 }
        return view.positionState?.playbackRate ?? 1
    }
}

// MARK: - A deck (AVDeck, NE-15; DeckPair, NE-32)

/// One player the core drives with `DeckCommand`s and hears from as
/// `DeckEvent`s (the core's vocabulary, `DeckVocabulary.swift`). NE-15 built
/// AVDeck against a stub of these types; NE-15h swapped it onto the core's
/// and moved the protocol here.
protocol DeckDriving: AnyObject {
    /// Every observation, ON MAIN. The host sets it at start and clears it at
    /// teardown.
    var onEvent: ((DeckEvent) -> Void)? { get set }
    /// What the deck says RIGHT NOW (playhead, duration, audible, ended),
    /// read by the host before every input: the core's `EngineNow.deck`.
    var reading: DeckReading { get }
    func send(_ command: DeckCommand)
    /// Stop observing for good: every KVO token, notification observer and
    /// pending callback is dropped, and no event is delivered after this.
    func invalidate()
}

// MARK: - Speech (the audition in M1; the narrator, NE-33)

/// How an utterance ended, as the synthesizer's delegate said it did.
enum SpeechEnd: String, Equatable, Sendable {
    /// `didFinish`: the whole line was spoken.
    case finished
    /// `didCancel`: stopped before the end (a `stopSpeaking`, a new line, an
    /// interruption that took the session).
    case cancelled
}

protocol Speaking: AnyObject {
    /// The end of the utterance in flight, ON MAIN, once per `speak`. The host
    /// sets it at start and clears it at teardown. NE-25c's session probe
    /// waits on it (DV-9 is "what happens to the session after `didFinish`");
    /// NE-33's narrator will turn it into a core input.
    var onFinish: ((SpeechEnd) -> Void)? { get set }
    /// Audible: the core emits it only after an activation (OQ-5).
    func speak(text: String, voiceId: String?)
    func stopSpeaking()
}

// MARK: - The interlude jingle (InterludePlayer, NE-34)

/// The seam's jingle: one short bundled asset at 1.0x (plan §14 NE-34). The
/// core decides WHEN (`EngineCommand.interlude`); the conformer only plays it
/// and says when it stopped sounding.
protocol InterludePlaying: AnyObject {
    /// The jingle stopped sounding by itself, ON MAIN, at most once per
    /// accepted `start()`: `ended` (the file ran out), `error` (it failed
    /// mid-play) or `ceiling` (neither came within `INTERLUDE_CEILING_SEC`,
    /// so the conformer stopped it). Never for a `stop()` or a `release()`.
    /// The host sets it at start and clears it at teardown.
    var onEnded: ((String) -> Void)? { get set }
    /// Start from the first frame. Audible, so it refuses (false, and a
    /// `fault` row) unless the engine's session is active; false too when
    /// the asset cannot play. A start while sounding restarts it.
    func start() -> Bool
    /// Silence it without an end report (a transport action cut the beat).
    func stop()
    /// Stop and drop the decoded asset (the engine's teardown).
    func release()
}

// MARK: - The silence node (SilenceNode, NE-34; behind `silenceNodeEnabled`, OFF)

/// Digital silence rendered through the engine's own session so the process
/// keeps rendering across a silent seam (timing only, L-3). OFF by default
/// (`EngineConfig.silenceNodeEnabled`): the boot builds no conformer at all
/// unless the flag is on.
protocol SilenceRendering: AnyObject {
    /// Start rendering, for at most `min(capMs, INTERLUDE_CEILING_SEC)` from
    /// now: the conformer stops ITSELF at that cap whatever the load does.
    /// Refuses (false) unless the session is active.
    func start(capMs: Double) -> Bool
    func stop()
    var isRunning: Bool { get }
}

// MARK: - Clocks and timers (MainQueueTiming)

/// Both clocks the core reads (wall for rows the page reads, monotonic for
/// every duration) and the timers it arms. The real conformer is
/// `MainQueueTiming`: `DispatchSourceTimer`s on the main queue.
protocol EngineTiming: AnyObject {
    var wallMs: Double { get }
    var monoMs: Double { get }
    /// `fire` runs on main after `afterMs`, then every `afterMs` if
    /// `repeating`, until the returned observation is cancelled.
    func schedule(afterMs: Double, repeating: Bool, fire: @escaping () -> Void) -> EngineObservation
}

// MARK: - Rows, events and diagnostics (EngineStore NE-19, the bridge NE-20)

/// Where the core's persistence and reporting commands land. NE-19's
/// EngineStore writes the shared rows, the private restore record and the
/// diagnostics ring; NE-20's bridge carries the events to the page.
protocol EngineOutput: AnyObject {
    func writePosition(_ write: PositionWrite)
    func writeRow(_ row: StoredRow)
    /// Nil removes the record (data deletion).
    func writeRestore(_ record: RestoreRecord?)
    func appendEvent(_ event: PendingEvent)
    func emit(_ event: EngineEvent)
    func diag(_ entry: DiagEntry)
    /// Make every write so far durable NOW: called by the host right after
    /// the core has handled `.background` or `.terminating` (whose position
    /// flush has just been written), before the notification handler returns.
    func flush()
}

// MARK: - The pause-hold policy's private key (HoldPolicyStore, NE-16)

/// Where `pauseHoldPolicy` lives between launches: the engine-private
/// `UserDefaults` key `ForayEngine.holdPolicy`, outside `CapacitorStorage.`
/// so DurableStore never sees it (plan §4.6). The host reads it once at
/// construction and writes it whenever a turn changed the core's policy
/// (`engineSend setHoldPolicy`, the Developer row).
protocol HoldPolicyStoring: AnyObject {
    /// Nil when nothing valid is stored: the core's default then stands.
    func load() -> SessionPolicy.HoldPolicy?
    func save(_ policy: SessionPolicy.HoldPolicy)
}

/// Every seam the host drives, in one value, so a test builds the whole world
/// out of fakes and the boot path (NE-17, NE-24) out of the real conformers.
struct EngineSeams {
    var session: SessionControlling
    var background: BackgroundTasking
    var remote: RemoteCommandRegistering
    var nowPlaying: NowPlayingWriting
    var deck: DeckDriving
    var speaker: Speaking
    var timing: EngineTiming
    var output: EngineOutput
    /// Optional so a world without persistence (most tests) needs no store.
    var holdPolicy: HoldPolicyStoring? = nil
    /// The seam's jingle (NE-34). Nil: every `interlude(.start)` is answered
    /// `ended(refused)` at once, and the boot leaves `interludeAvailable` off.
    var interlude: InterludePlaying? = nil
    /// The silence node (NE-34), built only when `silenceNodeEnabled` is on.
    var silence: SilenceRendering? = nil
    /// Ends the process: Developer "Simulate system termination" (NE-24,
    /// DV-7a) and nothing else. The boot supplies the real one; nil (every
    /// test world) records the decision in the row and exits nothing.
    var terminate: (() -> Void)? = nil
}

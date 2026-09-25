import Foundation
import ForayEngineCore
@testable import ForayAudioPlugin

// ── RECORDING FAKES FOR EVERY SEAM (card NE-15h) ───────────────────────────
//
// One fake per protocol in `Engine/Seams.swift`. Each one:
//   - appends what the host asked of it to ONE shared `SeamLog`, so a test can
//     assert the ORDER across seams ("activate, then load, then play");
//   - counts what is still live (observers, targets, tasks, timers), so
//     "teardown leaves nothing registered" is a number, not a hope;
//   - can be driven by the test (post a session event, press a remote
//     command, expire a background task, fire a timer, answer a load).
//
// They are what NE-16 (session), NE-16g (grace), NE-17 (ownership) and NE-18
// (remote, Now Playing) assert against headless: a package test has no app,
// no interruptible session, and no way to enumerate MPRemoteCommand targets.

/// The shared, ordered record of every seam call.
final class SeamLog {
    private(set) var entries: [String] = []

    func add(_ entry: String) { entries.append(entry) }
    func clear() { entries.removeAll() }

    /// Index of the first entry equal to `entry`, or starting with it when
    /// `prefix` is true.
    func index(of entry: String, prefix: Bool = false) -> Int? {
        entries.firstIndex { prefix ? $0.hasPrefix(entry) : $0 == entry }
    }

    func count(_ entry: String, prefix: Bool = false) -> Int {
        entries.filter { prefix ? $0.hasPrefix(entry) : $0 == entry }.count
    }
}

/// A registration a fake hands out; `cancel()` makes it dead.
final class FakeObservation: EngineObservation {
    private(set) var isLive = true
    private let onCancel: () -> Void

    init(onCancel: @escaping () -> Void = {}) {
        self.onCancel = onCancel
    }

    func cancel() {
        guard isLive else { return }
        isLive = false
        onCancel()
    }
}

// MARK: - SessionControlling

final class FakeSession: SessionControlling {
    let log: SeamLog
    /// What the next `activate()` answers.
    var answer = SessionActivation(ok: true, activateMs: 2)
    private(set) var activateCalls = 0
    private(set) var deactivations: [Bool] = []
    private var observers: [(FakeObservation, (SessionEvent) -> Void)] = []

    init(log: SeamLog) { self.log = log }

    var liveObservers: Int { observers.filter { $0.0.isLive }.count }

    func activate() -> SessionActivation {
        activateCalls += 1
        log.add(answer.ok ? "session.activate" : "session.activate failed")
        return answer
    }

    func deactivate(notifyOthers: Bool) {
        deactivations.append(notifyOthers)
        log.add("session.deactivate notify=\(notifyOthers)")
    }

    func reapplyCategory() { log.add("session.reapplyCategory") }
    func rebuild() { log.add("session.rebuild") }

    func observe(_ handler: @escaping (SessionEvent) -> Void) -> EngineObservation {
        let token = FakeObservation()
        observers.append((token, handler))
        return token
    }

    /// The system posts a notification: every live observer hears it.
    func post(_ event: SessionEvent) {
        for (token, handler) in observers where token.isLive { handler(event) }
    }
}

// MARK: - BackgroundTasking

final class FakeBackground: BackgroundTasking {
    let log: SeamLog
    /// Answer `beginTask` with nil (`.invalid`).
    var refuse = false
    var backgroundTimeRemainingSec: Double?
    private var nextId = 0
    private(set) var live: [BackgroundTaskID: () -> Void] = [:]
    private(set) var ended: [BackgroundTaskID] = []
    private var lifecycle: [(FakeObservation, (LifecycleEvent) -> Void)] = []

    init(log: SeamLog) { self.log = log }

    var liveTasks: Int { live.count }
    var liveLifecycleObservers: Int { lifecycle.filter { $0.0.isLive }.count }

    func beginTask(named name: String, expiration: @escaping () -> Void) -> BackgroundTaskID? {
        guard !refuse else {
            log.add("background.begin refused \(name)")
            return nil
        }
        nextId += 1
        live[nextId] = expiration
        log.add("background.begin \(name)")
        return nextId
    }

    func endTask(_ id: BackgroundTaskID) {
        ended.append(id)
        live[id] = nil
        log.add("background.end")
    }

    func observeLifecycle(_ handler: @escaping (LifecycleEvent) -> Void) -> EngineObservation {
        let token = FakeObservation()
        lifecycle.append((token, handler))
        return token
    }

    func post(_ event: LifecycleEvent) {
        for (token, handler) in lifecycle where token.isLive { handler(event) }
    }

    /// The system takes the time back: runs the expiration handler and
    /// answers whether the task was ended INSIDE it (UIKit's rule).
    @discardableResult
    func expire(_ id: BackgroundTaskID) -> Bool {
        guard let expiration = live[id] else { return false }
        log.add("background.expire")
        expiration()
        return live[id] == nil && ended.contains(id)
    }

    /// The one live task, if exactly one is.
    var onlyLiveTask: BackgroundTaskID? { live.count == 1 ? live.keys.first : nil }
}

// MARK: - RemoteCommandRegistering

final class FakeRemote: RemoteCommandRegistering {
    let log: SeamLog
    private var targets: [(MediaMapping.RemoteCommand, FakeObservation, (RemotePress) -> RemoteVerdict)] = []
    private(set) var enabled: [MediaMapping.RemoteCommand: Bool] = [:]

    init(log: SeamLog) { self.log = log }

    var liveTargets: Int { targets.filter { $0.1.isLive }.count }

    func liveTargets(for command: MediaMapping.RemoteCommand) -> Int {
        targets.filter { $0.0 == command && $0.1.isLive }.count
    }

    func addTarget(_ command: MediaMapping.RemoteCommand,
                   handler: @escaping (RemotePress) -> RemoteVerdict) -> EngineObservation {
        let token = FakeObservation()
        targets.append((command, token, handler))
        return token
    }

    func setEnabled(_ enabled: Bool, for command: MediaMapping.RemoteCommand) {
        self.enabled[command] = enabled
    }

    /// A press from the car: the live target's verdict, or nil when nothing
    /// is registered for it (the system would get no answer from the engine).
    func press(_ command: MediaMapping.RemoteCommand, value: Double? = nil) -> RemoteVerdict? {
        guard let target = targets.last(where: { $0.0 == command && $0.1.isLive }) else { return nil }
        log.add("remote.press \(command.rawValue)")
        return target.2(RemotePress(command, value: value, routePort: "carAudio", onMain: true))
    }
}

// MARK: - NowPlayingWriting

final class FakeNowPlaying: NowPlayingWriting {
    let log: SeamLog
    private(set) var writes = 0
    private(set) var clears = 0
    /// Every entry written, in order; `last` is what the lock screen shows
    /// (nil after a clear).
    private(set) var written: [MediaMapping.SessionView] = []
    private(set) var last: MediaMapping.SessionView?

    init(log: SeamLog) { self.log = log }

    func write(_ view: MediaMapping.SessionView) {
        writes += 1
        written.append(view)
        last = view
        log.add("nowPlaying.write")
    }

    func clear() {
        clears += 1
        last = nil
        log.add("nowPlaying.clear")
    }
}

// MARK: - DeckDriving

/// A deck that goes silent on a load, audible on a play and silent on a
/// pause, as the core's own test host models it. With `answersReady`, a load
/// answers `.ready` from INSIDE `send`, the way a warm deck re-entering the
/// source it holds can: that is the re-entrant path the host must queue.
final class FakeDeck: DeckDriving {
    let log: SeamLog
    var onEvent: ((DeckEvent) -> Void)?
    var reading = DeckReading(positionSec: nil, durationSec: 3600, audible: false, ended: false)
    var answersReady = false
    private(set) var sent: [DeckCommand] = []
    private(set) var lastToken: DeckToken?
    private(set) var invalidated = false

    init(log: SeamLog) { self.log = log }

    var isObserved: Bool { onEvent != nil && !invalidated }

    func send(_ command: DeckCommand) {
        sent.append(command)
        log.add("deck.\(command.logName)")
        switch command {
        case let .load(token, _, _, startSec, _):
            lastToken = token
            reading.positionSec = startSec
            reading.audible = false
            reading.ended = false
            if answersReady {
                onEvent?(.ready(token: token, landedSec: startSec, prerolled: true, elapsedMs: 1))
            }
        case .play: reading.audible = true
        case .pause: reading.audible = false
        case let .seek(toSec): reading.positionSec = toSec
        case .unload: reading = DeckReading(positionSec: nil, durationSec: nil, audible: false, ended: false)
        case .setRate, .setOutPoint, .prepare: break
        }
    }

    func invalidate() {
        invalidated = true
        onEvent = nil
        log.add("deck.invalidate")
    }

    /// The deck reports something (on main, as AVDeck does).
    func report(_ event: DeckEvent) {
        onEvent?(event)
    }

    func count(_ name: String) -> Int { sent.filter { $0.logName == name }.count }
}

extension DeckCommand {
    /// The Simulator deck tests (AVDeckTests, TwoDeckPrerollTests) load
    /// bundled files by URL. The core's `.load` carries the queue item's id
    /// and the page's `audio_url` string; this is that command for a file,
    /// with an id the deck never reads.
    static func loadURL(token: DeckToken, url: URL, startSec: Double, preciseTiming: Bool) -> DeckCommand {
        .load(token: token, itemId: "deck-test-\(token)", url: url.absoluteString,
              startSec: startSec, preciseTiming: preciseTiming)
    }

    /// The command's name without its payload: `load`, `play`, `setRate`...
    var logName: String {
        switch self {
        case .load: return "load"
        case .play: return "play"
        case .pause: return "pause"
        case .seek: return "seek"
        case .setRate: return "setRate"
        case .setOutPoint: return "setOutPoint"
        case .unload: return "unload"
        case .prepare: return "prepare"
        }
    }
}

// MARK: - Speaking

final class FakeSpeaker: Speaking {
    let log: SeamLog
    var onFinish: ((SpeechEnd) -> Void)?
    private(set) var spoken: [String] = []

    init(log: SeamLog) { self.log = log }

    func speak(text: String, voiceId: String?) {
        spoken.append(text)
        log.add("speaker.speak")
    }

    func stopSpeaking() { log.add("speaker.stop") }

    /// The synthesizer's delegate reports the line's end (on main, as
    /// PreviewSpeaker delivers it).
    func end(_ end: SpeechEnd = .finished) {
        log.add("speaker.\(end.rawValue)")
        onFinish?(end)
    }
}

// MARK: - EngineTiming

/// A manual clock and timers that fire only when the test says so.
final class FakeTiming: EngineTiming {
    final class Scheduled {
        let afterMs: Double
        let repeating: Bool
        let fire: () -> Void
        let token: FakeObservation

        init(afterMs: Double, repeating: Bool, fire: @escaping () -> Void, token: FakeObservation) {
            self.afterMs = afterMs
            self.repeating = repeating
            self.fire = fire
            self.token = token
        }
    }

    let log: SeamLog
    var wallMs: Double = 1_790_000_000_000
    var monoMs: Double = 1_000
    private(set) var scheduled: [Scheduled] = []

    init(log: SeamLog) { self.log = log }

    var live: [Scheduled] { scheduled.filter { $0.token.isLive } }

    func schedule(afterMs: Double, repeating: Bool, fire: @escaping () -> Void) -> EngineObservation {
        let token = FakeObservation()
        scheduled.append(Scheduled(afterMs: afterMs, repeating: repeating, fire: fire, token: token))
        log.add("timer.schedule \(Int(afterMs))\(repeating ? " repeating" : "")")
        return token
    }

    /// Fire the live timer scheduled for `afterMs`, as its deadline passing.
    func fire(afterMs: Double) {
        guard let timer = live.last(where: { $0.afterMs == afterMs }) else { return }
        monoMs += afterMs
        wallMs += afterMs
        timer.fire()
    }

    func advance(_ ms: Double) {
        monoMs += ms
        wallMs += ms
    }
}

// MARK: - EngineOutput

final class FakeOutput: EngineOutput {
    let log: SeamLog
    private(set) var positions: [PositionWrite] = []
    private(set) var rows: [StoredRow] = []
    private(set) var restores: [RestoreRecord?] = []
    private(set) var events: [PendingEvent] = []
    private(set) var emitted: [EngineEvent] = []
    private(set) var diags: [DiagEntry] = []
    /// Called on every diag row, inside the host's turn: a test uses it to
    /// send an input re-entrantly.
    var onDiag: ((DiagEntry) -> Void)?

    init(log: SeamLog) { self.log = log }

    func writePosition(_ write: PositionWrite) { positions.append(write); log.add("output.position") }
    func writeRow(_ row: StoredRow) { rows.append(row); log.add("output.row") }
    func writeRestore(_ record: RestoreRecord?) { restores.append(record); log.add("output.restore") }
    func appendEvent(_ event: PendingEvent) { events.append(event); log.add("output.event") }
    func emit(_ event: EngineEvent) { emitted.append(event); log.add("output.emit") }
    func flush() { log.add("output.flush") }

    func diag(_ entry: DiagEntry) {
        diags.append(entry)
        log.add("output.diag \(entry.kind)")
        onDiag?(entry)
    }
}

// MARK: - HoldPolicyStoring

/// The private `ForayEngine.holdPolicy` key, in memory (NE-16).
final class FakeHoldPolicyStore: HoldPolicyStoring {
    let log: SeamLog
    /// What `load()` answers: what a previous launch left.
    var stored: SessionPolicy.HoldPolicy?
    private(set) var saves: [SessionPolicy.HoldPolicy] = []

    init(log: SeamLog, stored: SessionPolicy.HoldPolicy? = nil) {
        self.log = log
        self.stored = stored
    }

    func load() -> SessionPolicy.HoldPolicy? { stored }

    func save(_ policy: SessionPolicy.HoldPolicy) {
        saves.append(policy)
        stored = policy
        log.add("holdPolicy.save \(policy.text)")
    }
}

// MARK: - The whole world

/// Every fake, sharing one log, and the `EngineSeams` built from them.
final class FakeWorld {
    let log = SeamLog()
    lazy var session = FakeSession(log: log)
    lazy var background = FakeBackground(log: log)
    lazy var remote = FakeRemote(log: log)
    lazy var nowPlaying = FakeNowPlaying(log: log)
    lazy var deck = FakeDeck(log: log)
    lazy var speaker = FakeSpeaker(log: log)
    lazy var timing = FakeTiming(log: log)
    lazy var output = FakeOutput(log: log)
    /// Nil unless a test gives the world one (NE-16): the host then runs
    /// without persistence, as most tests want.
    var holdPolicyStore: FakeHoldPolicyStore?

    var seams: EngineSeams {
        EngineSeams(session: session, background: background, remote: remote, nowPlaying: nowPlaying,
                    deck: deck, speaker: speaker, timing: timing, output: output, holdPolicy: holdPolicyStore)
    }
}

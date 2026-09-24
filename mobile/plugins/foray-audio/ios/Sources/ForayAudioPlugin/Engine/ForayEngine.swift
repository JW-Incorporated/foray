import Foundation
import ForayEngineCore

/// What one input came to, for whoever sent it: the bridge's `engineSend`
/// answer (NE-20) and a remote handler's status (`RemoteVerdict`).
struct EngineVerdict: Equatable {
    /// The core's `.commandFailed` reasons (contract `Refusal` tokens), in
    /// order, from this input's turn and the activation answer it asked for.
    var failures: [String]
    /// The input arrived while a turn was being interpreted, so it was queued
    /// and ran right after that turn; its own failures are not known here.
    var deferred: Bool

    var ok: Bool { failures.isEmpty }

    static let queued = EngineVerdict(failures: [], deferred: true)
}

/// THE ENGINE'S IMPERATIVE SHELL (card NE-15h; docs/native-engine-plan.md
/// §4.2): one per process, on main, hosting the pure `EngineCore`.
///
/// It does four things and decides nothing:
///   1. turns every observation (deck events, session notifications, the
///      app's lifecycle, remote presses, timers) into an `EngineInput`;
///   2. reads the clocks and the deck, and calls `core.handle(input, now:)`;
///   3. interprets each `EngineCommand` that comes back through its seam
///      (`Seams.swift`), in order;
///   4. tears every registration down, once, when the core relinquishes.
///
/// ── ACTIVATION IS A REQUEST AND A RESPONSE INSIDE ONE TURN ────────────────
///
/// The core emits `.sessionActivate` and parks the intent. The host calls the
/// session seam SYNCHRONOUSLY and feeds `.sessionResult` straight back in,
/// interpreting what that answer produced BEFORE any command that followed
/// the request. So a failed activation yields `.commandFailed` and no deck
/// command at all, and a car's play runs activate → load → play inside the
/// one remote handler call that asked for it (plan §4.4's audible-start
/// invariant, end to end).
///
/// ── ONE TURN AT A TIME ─────────────────────────────────────────────────────
///
/// A seam may call back while a command is being interpreted (a warm deck
/// answers `.ready` from inside `send(.load)`; a diagnostics writer might
/// log). Handling that input on the spot would interleave a second turn with
/// the rest of the first one's commands. Instead it is queued, and runs the
/// moment the current turn's last command has been interpreted, still inside
/// the same main-thread call. Only `.sessionResult` jumps the queue, because
/// the core is waiting on it.
///
/// ── TERMINAL ───────────────────────────────────────────────────────────────
///
/// When a turn leaves the core `.relinquished` (plan §4.6), the host tears
/// down every observer, remote target, timer and grace task, and answers
/// every later input with `relinquished` without touching a seam. There is
/// no way back inside the process: the legacy lane owns the rest of it.
@MainActor
final class ForayEngine {

    /// The process's engine (A-4). Set by `boot` exactly once and kept after
    /// a relinquish, so a later boot call cannot build a second engine that
    /// re-registers remote targets over the legacy lane's.
    private(set) static var shared: ForayEngine?

    /// Whichever of the AppDelegate cold path (NE-24) and the plugin's
    /// `load()` (NE-17) runs first builds the engine; the other gets it.
    @discardableResult
    static func boot(seams: EngineSeams, config: EngineConfig,
                     positions: [String: ResumeRules.StoredPosition] = [:]) -> ForayEngine {
        if let shared { return shared }
        let engine = ForayEngine(seams: seams, config: config, positions: positions)
        shared = engine
        engine.start()
        return engine
    }

    let seams: EngineSeams
    private var core: EngineCore

    /// Inputs that arrived while a turn was being interpreted.
    private var inbox: [EngineInput] = []
    /// How many turns are being interpreted (an activation answer nests one).
    private var depth = 0
    private(set) var isStarted = false
    private(set) var isTornDown = false

    /// Everything registered at start: session, lifecycle, remote targets.
    private var observations: [EngineObservation] = []
    /// One live timer per kind; re-arming replaces it.
    private var timers: [EngineTimer: EngineObservation] = [:]
    /// The live BackgroundGrace task, if any. The core keeps at most one span
    /// open (`EngineState.grace`), so the host holds at most one task.
    private var graceTask: BackgroundTaskID?

    /// The pause-hold policy the store last heard (NE-16): a turn that leaves
    /// the core with a different one is persisted, once.
    private var storedHoldPolicy: SessionPolicy.HoldPolicy

    /// A stored `pauseHoldPolicy` (the Developer row, `engineSend
    /// setHoldPolicy`) outranks the config's: the config carries the build's
    /// default, the key carries what the founder chose on this phone.
    init(seams: EngineSeams, config: EngineConfig, positions: [String: ResumeRules.StoredPosition] = [:]) {
        self.seams = seams
        var config = config
        if let stored = seams.holdPolicy?.load() { config.holdPolicy = stored }
        storedHoldPolicy = config.holdPolicy
        core = EngineCore(config: config, positions: positions)
    }

    /// The core's state, for the bridge's snapshot (NE-20) and the tests.
    var state: EngineState { core.state }

    /// Timers still armed, by kind (diagnostics and tests).
    var liveTimers: Set<EngineTimer> { Set(timers.keys) }

    var hasGraceTask: Bool { graceTask != nil }

    // MARK: - Start and teardown

    /// Register every observer the engine lives on. Idempotent; a torn-down
    /// engine never starts again.
    func start() {
        guard !isStarted, !isTornDown else { return }
        isStarted = true
        // Every handler asserts main rather than hopping to it (Seams.swift:
        // a hop would reorder the input against the turn in progress).
        seams.deck.onEvent = { [weak self] event in
            MainActor.assumeIsolated { self?.receive(.deck(event)) }
        }
        observations.append(seams.session.observe { [weak self] event in
            MainActor.assumeIsolated { self?.receive(.session(event)) }
        })
        observations.append(seams.background.observeLifecycle { [weak self] event in
            MainActor.assumeIsolated { self?.lifecycle(event) }
        })
        for command in MediaMapping.RemoteCommand.allCases {
            observations.append(seams.remote.addTarget(command) { [weak self] press in
                MainActor.assumeIsolated { self?.remote(press) ?? .commandFailed }
            })
            // Plan §4.5 (T-7): `stop` is registered AND disabled; a remote
            // stop is a pause, and a car's stop must never tear the player
            // down. Which of the others are enabled at a given moment is
            // NowPlayingPublisher's `MediaMapping.commandAvailability` (NE-18).
            seams.remote.setEnabled(command != .stop, for: command)
        }
    }

    /// Remove every observer, remote target, KVO token (through the deck),
    /// timer and grace task, and refuse every later input. Runs by itself when
    /// the core relinquishes; callable directly by the owner (NE-17).
    ///
    /// It deliberately does NOT deactivate the session or clear Now Playing:
    /// a relinquish keeps the session active with no notify (no app 4a
    /// interrupted is invited back) and leaves the entry for the legacy lane
    /// to overwrite (plan §4.6).
    func teardown() {
        guard !isTornDown else { return }
        isTornDown = true
        observations.forEach { $0.cancel() }
        observations = []
        timers.values.forEach { $0.cancel() }
        timers = [:]
        if let task = graceTask {
            graceTask = nil
            seams.background.endTask(task)
        }
        seams.deck.onEvent = nil
        seams.deck.invalidate()
        inbox = []
    }

    // MARK: - Inputs

    /// Run one input through the core and interpret what it returns. Called on
    /// main by the bridge (NE-20) and by every seam handler.
    @discardableResult
    func handle(_ input: EngineInput) -> EngineVerdict {
        if isTornDown {
            return EngineVerdict(failures: [EngineContract.Refusal.relinquished.rawValue], deferred: false)
        }
        if depth > 0 {
            inbox.append(input)
            return .queued
        }
        let failures = runTurn(input)
        drain()
        return EngineVerdict(failures: failures, deferred: false)
    }

    /// For a result computed off main (an asset's duration, an artwork fetch,
    /// NE-18): it comes back as an input on a LATER main turn, never inside
    /// the one in progress, and never on the thread that computed it.
    nonisolated func post(fromAnyThread input: EngineInput) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { _ = self.handle(input) }
        }
    }

    private func receive(_ input: EngineInput) {
        handle(input)
    }

    /// The app leaving the foreground or being terminated. The core writes the
    /// playhead (its position flush) and the store has it in `UserDefaults`
    /// synchronously; `flush()` then makes it durable BEFORE this handler
    /// returns, because after `didEnterBackground` returns iOS may suspend
    /// the process at any moment, and after `willTerminate` it will (NE-19).
    private func lifecycle(_ event: LifecycleEvent) {
        handle(.lifecycle(event))
        if event == .background || event == .terminating { seams.output.flush() }
    }

    /// A remote press: the `remote` row, the core's ruling, and its verdict
    /// back to the system, all before the handler returns.
    private func remote(_ press: RemotePress) -> RemoteVerdict {
        let verdict = handle(.remote(press))
        return RemoteVerdict(failures: verdict.failures)
    }

    // MARK: - Turns

    private func drain() {
        while !inbox.isEmpty, !isTornDown {
            let next = inbox.removeFirst()
            _ = runTurn(next)
        }
    }

    /// One `core.handle` and the interpretation of everything it returned.
    /// Returns the turn's refusals, including the nested activation answer's.
    private func runTurn(_ input: EngineInput) -> [String] {
        depth += 1
        defer { depth -= 1 }
        let commands = core.handle(input, now: now())
        var failures: [String] = []
        for command in commands {
            if isTornDown { break }
            failures += interpret(command)
        }
        persistHoldPolicyIfChanged()
        if core.state.session == .relinquished { teardown() }
        return failures
    }

    /// `setHoldPolicy` is the core's to apply (`state.holdPolicy`) and the
    /// host's to keep: written to the private key the moment a turn changed
    /// it, with a row, so a Copy after the H-1b drive says which arm ran.
    private func persistHoldPolicyIfChanged() {
        let policy = core.state.holdPolicy
        guard policy != storedHoldPolicy else { return }
        storedHoldPolicy = policy
        seams.holdPolicy?.save(policy)
        seams.output.diag(DiagEntry(kind: "session", fields: [
            JSONMember("kind", .string("hold-policy")),
            JSONMember("policy", .string(policy.text))
        ]))
    }

    /// Both clocks and the deck's reading at the moment the input is handled
    /// (`DeckReading`: the core asks the deck at the moment it decides, as the
    /// JS asks its element).
    private func now() -> EngineNow {
        EngineNow(wallMs: seams.timing.wallMs, monoMs: seams.timing.monoMs, deck: seams.deck.reading)
    }

    /// Every command has a case: a command the host drops is a stuck player.
    private func interpret(_ command: EngineCommand) -> [String] {
        switch command {
        case let .deck(deckCommand):
            seams.deck.send(deckCommand)
        case let .sessionActivate(requestId):
            // Synchronous, and answered before the next command in this list.
            let answer = seams.session.activate()
            return runTurn(.sessionResult(SessionResult(
                requestId: requestId, ok: answer.ok, error: answer.error, activateMs: answer.activateMs)))
        case let .sessionDeactivate(notifyOthers):
            seams.session.deactivate(notifyOthers: notifyOthers)
        case .sessionReapplyCategory:
            seams.session.reapplyCategory()
        case .sessionRebuild:
            seams.session.rebuild()
        case let .graceBegin(reason):
            beginGrace(reason)
        case .graceEnd:
            endGrace()
        case let .timerArm(timer, afterMs, repeating):
            arm(timer, afterMs: afterMs, repeating: repeating)
        case let .timerCancel(timer):
            timers.removeValue(forKey: timer)?.cancel()
        case let .writePosition(write):
            seams.output.writePosition(write)
        case let .writeRow(row):
            seams.output.writeRow(row)
        case let .appendEvent(event):
            seams.output.appendEvent(event)
        case let .writeRestore(record):
            seams.output.writeRestore(record)
        case let .speak(text, voiceId):
            seams.speaker.speak(text: text, voiceId: voiceId)
        case let .emit(event):
            seams.output.emit(event)
        case let .diag(entry):
            seams.output.diag(entry)
        case let .commandFailed(reason):
            return [reason]
        }
        return []
    }

    // MARK: - BackgroundGrace

    /// Plan §4.4: every begin has an expiration handler, and a refused begin
    /// or a nearly spent budget is written to the row, because that is the
    /// span the car will go silent in.
    private func beginGrace(_ reason: GraceReason) {
        if let stale = graceTask {
            // The core never opens a second span; if it ever did, the first
            // task must not outlive it unowned.
            graceTask = nil
            seams.background.endTask(stale)
        }
        let task = seams.background.beginTask(named: "ForayEngine.grace.\(reason.rawValue)") { [weak self] in
            MainActor.assumeIsolated { self?.graceExpired() }
        }
        graceTask = task
        // Nil (foreground) or non-finite is JSON null, never a number the
        // row cannot carry.
        let remainingMs: JSONNode = seams.background.backgroundTimeRemainingSec
            .flatMap { $0.isFinite ? JSONNode.number(($0 * 1000).rounded()) : nil } ?? .null
        seams.output.diag(DiagEntry(kind: "grace", fields: [
            JSONMember("kind", .string("begin")),
            JSONMember("reason", .string(reason.rawValue)),
            JSONMember("task", .string(task == nil ? "invalid" : "ok")),
            JSONMember("bgRemainingMs", remainingMs)
        ]))
    }

    private func endGrace() {
        guard let task = graceTask else { return }
        graceTask = nil
        seams.background.endTask(task)
    }

    /// The system took the time back. UIKit requires the task to end INSIDE
    /// this handler, so it ends here, first; then the core hears it and applies
    /// the deterministic outcome (a pause with `stop cause=grace-expired`).
    /// Its own `.graceEnd(.expired)` then finds no task to end.
    private func graceExpired() {
        endGrace()
        handle(.timer(.graceExpired))
    }

    // MARK: - Timers

    private func arm(_ timer: EngineTimer, afterMs: Double, repeating: Bool) {
        timers.removeValue(forKey: timer)?.cancel()
        timers[timer] = seams.timing.schedule(afterMs: afterMs, repeating: repeating) { [weak self] in
            MainActor.assumeIsolated { self?.timerFired(timer, repeating: repeating) }
        }
    }

    /// A one-shot is spent once it fires: cancel it so nothing stays
    /// registered for a timer the core no longer thinks is armed.
    private func timerFired(_ timer: EngineTimer, repeating: Bool) {
        if !repeating { timers.removeValue(forKey: timer)?.cancel() }
        handle(.timer(timer))
    }
}

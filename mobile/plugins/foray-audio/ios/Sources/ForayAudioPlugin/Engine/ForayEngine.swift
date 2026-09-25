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
    /// Whether any input has been handled: a cold boot may replace the core
    /// only before the first one (NE-24).
    private var handledAny = false
    /// `simulateTermination` (Developer only, NE-24, DV-7a) was accepted:
    /// the next background entry while paused exits the process.
    private(set) var terminationArmed = false

    /// Everything registered at start: session, lifecycle, remote targets.
    private var observations: [EngineObservation] = []
    /// One live timer per kind; re-arming replaces it.
    private var timers: [EngineTimer: EngineObservation] = [:]
    /// The live BackgroundGrace task, if any. The core keeps at most one span
    /// open (`EngineState.grace`), so the host holds at most one task.
    private var graceTask: BackgroundTaskID?
    /// The open span's reason and when it began (monotonic), for the `grace`
    /// rows' `heldMs`: from a car's press to its first audible frame is the
    /// resume latency the M1 drive is judged on (NE-26r). Kept for a refused
    /// begin too, because the span is real even when the task is not.
    private var graceSpan: (reason: GraceReason, sinceMs: Double)?

    /// Below this much background time at a begin, the `grace` row says
    /// `low=y` (plan §4.4: "if backgroundTimeRemaining is already small ...
    /// that is written to the row"). // MEASURE: NE-38 sets it from the H-1
    /// rows; 5 s is about one CDN load that goes wrong.
    static let lowBackgroundRemainingMs: Double = 5_000

    /// The Developer session probe (NE-25c), built by the first
    /// `probeSession`. Nil on every launch nobody probed.
    private(set) var probe: SessionProbe?

    /// How many times the host has called `SessionControlling.activate()`,
    /// and what the last call answered: the probe reads both to say whether
    /// its play needed an activation and what that cost (`activateMs`).
    private(set) var activations = 0
    private(set) var lastActivation: SessionActivation?

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

    /// The core itself, as a value: the snapshot reads `canNext` and
    /// `canPrevious` from it (NE-20). A copy, so nothing outside the host can
    /// move the engine's state.
    var coreValue: EngineCore { core }

    /// Timers still armed, by kind (diagnostics and tests).
    var liveTimers: Set<EngineTimer> { Set(timers.keys) }

    var hasGraceTask: Bool { graceTask != nil }

    /// EngineOwnership's two hooks (NE-17). `onTurnCompleted` runs after every
    /// input the host handled to the end, on main: the first one is the
    /// healthy marker that clears the crash-loop sentinel. `onTornDown` runs
    /// once, at the end of `teardown()`: whatever took the engine down, the
    /// legacy lane must take the process over, or a JS page would run with no
    /// remote surface at all.
    var onTurnCompleted: (() -> Void)?
    var onTornDown: (() -> Void)?

    /// The bridge's two hooks (NE-20). `onTransition` runs after every input
    /// the host handled to the end, and once more when the host tears down:
    /// the bridge re-reads the snapshot there and decides (coalesced, visible
    /// only) whether the page hears of it. `onEmit` hands on each of the
    /// core's own events (`advanced`, `error`) after the output has them.
    /// Unlike `onTurnCompleted`, neither is cleared by teardown: the page must
    /// still hear that the engine gave the process back.
    var onTransition: (() -> Void)?
    var onEmit: ((EngineEvent) -> Void)?

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
        // The end of a spoken line. M1's core has no input for it (narration
        // is M2's); the only listener is the Developer probe (NE-25c).
        seams.speaker.onFinish = { [weak self] end in
            MainActor.assumeIsolated { self?.probe?.speechEnded(end) }
        }
        // The jingle stopped sounding by itself (`ended`, `error`) or at its
        // ceiling (NE-34): the core shrinks the seam back to the beat.
        seams.interlude?.onEnded = { [weak self] reason in
            MainActor.assumeIsolated { self?.receive(.interlude(.ended(reason: reason))) }
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
        }
        // Every command is registered; which are ENABLED is
        // `MediaMapping.commandAvailability` of the core's snapshot, applied
        // now and after every turn (NE-18). `stop` is never in it (plan §4.5,
        // T-7: a remote stop is a pause, and a car's stop must never tear the
        // player down), so it is registered AND disabled from the first moment.
        publishSurface()
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
        graceSpan = nil
        seams.deck.onEvent = nil
        seams.deck.invalidate()
        seams.speaker.onFinish = nil
        // Nothing sounds past a teardown: the jingle and the silence node are
        // stopped here too, whatever the core's own teardown already asked.
        seams.interlude?.onEnded = nil
        seams.interlude?.release()
        seams.silence?.stop()
        probe?.cancel()
        inbox = []
        onTurnCompleted = nil
        let tornDown = onTornDown
        onTornDown = nil
        tornDown?()
        onTransition?()
    }

    // MARK: - Inputs

    /// Run one input through the core and interpret what it returns. Called on
    /// main by the bridge (NE-20) and by every seam handler.
    @discardableResult
    func handle(_ input: EngineInput) -> EngineVerdict {
        if isTornDown {
            return EngineVerdict(failures: [EngineContract.Refusal.relinquished.rawValue], deferred: false)
        }
        if case .command(.probeSession, _) = input {
            // Developer only (NE-25c). The core leaves it to the host: the
            // probe is a sequence of ordinary inputs (an audition, a play, a
            // pause) spread over timers and the synthesizer's didFinish, so it
            // never needs a rule of its own, and every step it takes goes
            // through the same audible-start invariant a listener's would.
            let probe = self.probe ?? SessionProbe(engine: self)
            self.probe = probe
            return probe.arm()
        }
        if depth > 0 {
            inbox.append(input)
            return .queued
        }
        let failures = runTurn(input)
        if case .command(.simulateTermination, _) = input, failures.isEmpty { terminationArmed = true }
        drain()
        publishSurface()
        onTurnCompleted?()
        onTransition?()
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

    /// A seam's observation. The probe hears it after the core has: it is
    /// waiting for the deck's own `.playing` (`timeToPlayingMs`).
    private func receive(_ input: EngineInput) {
        handle(input)
        probe?.observe(input)
    }

    /// The app leaving the foreground or being terminated. The core writes the
    /// playhead (its position flush) and the store has it in `UserDefaults`
    /// synchronously; `flush()` then makes it durable BEFORE this handler
    /// returns, because after `didEnterBackground` returns iOS may suspend
    /// the process at any moment, and after `willTerminate` it will (NE-19).
    private func lifecycle(_ event: LifecycleEvent) {
        handle(.lifecycle(event))
        if event == .background || event == .terminating { seams.output.flush() }
        if event == .background, terminationArmed { simulateTermination() }
    }

    /// DV-7a's "system termination" (Developer only; plan §10): the core
    /// wrote the restore record when the command was accepted, and the
    /// background flush that just ran wrote the playhead into it again. A
    /// process that exits HERE, paused in the background, is what iOS does to
    /// a suspended app it needs the memory of; the car's next play then
    /// launches 4a in the background (`build launch=background`) and the cold
    /// path must answer it. Never a user force-quit, which is DV-7b's negative
    /// control. While playing it disarms instead: iOS does not end an app
    /// that is playing, and a Developer tap must never cut a listener off.
    private func simulateTermination() {
        terminationArmed = false
        let running = core.state.isRunning
        seams.output.diag(DiagEntry(kind: "restore", fields: [
            JSONMember("kind", .string(running ? "sim-termination-disarmed" : "sim-termination-exit")),
            JSONMember("state", .string(core.state.stateType))
        ]))
        guard !running else { return }
        seams.output.flush()
        seams.terminate?()
    }

    // MARK: - The cold path (NE-24)

    /// What a cold boot found in the restore record.
    enum ColdBootOutcome: String {
        /// A record with a queue: Now Playing is painted at rate 0, nothing
        /// activated, and a car's play loads, begins grace, activates and plays.
        case painted
        /// No record (or one this build cannot trust): a play answers
        /// `.noActionableNowPlayingItem`.
        case noRecord = "none"
        /// `{mode: "relinquished"}` (plan §4.6 step 6): the legacy lane owns
        /// playback; a play answers `.noActionableNowPlayingItem`.
        case relinquished
        /// A Foray record, or a queue whose items this build cannot read.
        case unplayable
        /// An input was already handled, or the engine is torn down: the core
        /// the page is driving is never replaced.
        case late
    }

    /// Plan §4.5, the cold path: rebuild the core from the private restore
    /// record, BEFORE any input, and hand it the queue as
    /// `.lifecycle(.coldLaunch(autoplay: false))` so the enabled commands and
    /// the Now Playing entry (rate 0, the recorded position) are published
    /// with no activation at all (S-3). Called by the boot, right after
    /// `start()`, whichever entry point booted (NE-24).
    @discardableResult
    func coldBoot(from record: RestoreRecord?) -> ColdBootOutcome {
        let outcome: ColdBootOutcome
        var restored: EngineCore.ColdRestore?
        if !isStarted || isTornDown || handledAny || depth > 0 {
            outcome = .late
        } else if let record {
            switch record.mode {
            case .relinquished:
                outcome = .relinquished
            case .episode, .foray:
                restored = EngineCore.restoring(record, config: core.config)
                outcome = restored == nil ? .unplayable : .painted
            }
        } else {
            outcome = .noRecord
        }
        var fields = [JSONMember("kind", .string("cold-boot")), JSONMember("record", .string(outcome.rawValue))]
        if let restored {
            fields.append(JSONMember("index", .number(Double(restored.index))))
            fields.append(JSONMember("items", .number(Double(restored.queue.count))))
        }
        if outcome != .late { seams.output.diag(DiagEntry(kind: "restore", fields: fields)) }
        if let restored {
            core = restored.core
            handle(.lifecycle(.coldLaunch(queue: restored.queue, index: restored.index, autoplay: false)))
        }
        return outcome
    }

    /// A remote press: the `remote` row, the core's ruling, and its verdict
    /// back to the system, all before the handler returns.
    ///
    /// The core's `remote` row is written FIRST, inside the turn (D-4: before
    /// any no-op return), carrying the command, route, dupCandidate, grace and
    /// thread. The status the system gets back is known only once the turn is
    /// over, so it follows as `remote event=status`: a companion row, not an
    /// amended one, because a row held back until the verdict would be stamped
    /// after the activation and the load it caused (NE-18).
    private func remote(_ press: RemotePress) -> RemoteVerdict {
        let result = handle(.remote(press))
        let verdict = RemoteVerdict(failures: result.failures)
        if !isTornDown {
            var fields = [JSONMember("kind", .string("status")),
                          JSONMember("cmd", .string(press.command.rawValue)),
                          JSONMember("status", .string(verdict.token))]
            if let reason = result.failures.first { fields.append(JSONMember("reason", .string(reason))) }
            seams.output.diag(DiagEntry(kind: "remote", fields: fields))
        }
        return verdict
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
        handledAny = true
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
    ///
    /// The background budget rides along (NE-16g) so the core can put it into
    /// the `remote`, `resume` and `cold-play` rows it writes for this input.
    private func now() -> EngineNow {
        EngineNow(wallMs: seams.timing.wallMs, monoMs: seams.timing.monoMs, deck: seams.deck.reading,
                  bgRemainingMs: backgroundRemainingMs())
    }

    /// `backgroundTimeRemaining` in whole milliseconds; nil in the foreground
    /// or when it is not a number a row can carry.
    private func backgroundRemainingMs() -> Double? {
        seams.background.backgroundTimeRemainingSec.flatMap { $0.isFinite ? ($0 * 1000).rounded() : nil }
    }

    /// Every command has a case: a command the host drops is a stuck player.
    private func interpret(_ command: EngineCommand) -> [String] {
        switch command {
        case let .deck(deckCommand):
            switch deckCommand {
            // The playhead jumps: Now Playing is rewritten after this turn
            // whatever the drift check would say (plan §4.5: every seek).
            case .seek, .load, .unload: surfaceMoved = true
            case .play, .pause, .setRate, .setOutPoint, .prepare: break
            }
            seams.deck.send(deckCommand)
        case let .sessionActivate(requestId):
            // Synchronous, and answered before the next command in this list.
            let answer = seams.session.activate()
            activations += 1
            lastActivation = answer
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
        case let .graceEnd(outcome):
            endGrace(outcome: outcome)
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
        case let .narration(command):
            // The narrating overlay's synthesiser is NE-33's SpeechNarrator.
            // Until it lands this host has none: a line it is asked to speak is
            // REFUSED, after this turn (the inbox), which the core steps over
            // for a bridge and reports for a line the listener asked for, so
            // nothing is ever left waiting on a voice that is not there. The
            // core asks only with the Foray tape on (off until NE-37).
            if case let .speak(seq, _, _, _) = command {
                handle(.narrator(.failed(seq: seq, reason: "no-narrator")))
            }
        case let .interlude(command):
            interpretInterlude(command)
        case let .silenceStart(capMs):
            startSilence(capMs: capMs)
        case .silenceStop:
            seams.silence?.stop()
        case .narrationPulse:
            // A spoken line's clock moved with no deck event to say so.
            surfaceMoved = true
        case let .emit(event):
            seams.output.emit(event)
            onEmit?(event)
        case let .diag(entry):
            seams.output.diag(entry)
        case let .commandFailed(reason):
            return [reason]
        }
        return []
    }

    // MARK: - The surface: Now Playing and remote enablement (NE-18)

    /// A published Now Playing entry, and when (monotonic) it was written:
    /// the OS extrapolates the playhead from it at its rate.
    private struct PublishedEntry {
        let view: MediaMapping.SessionView
        let atMono: Double
    }

    /// What NowPlayingPublisher last wrote; nil before the first write and
    /// after a clear. `clear()` runs only on the way from an entry to none.
    private var published: PublishedEntry?
    /// The enabled set last applied; nil until `start()` applied one.
    private var enabledCommands: Set<MediaMapping.RemoteCommand>?
    /// The turn loaded, unloaded or seeked the deck.
    private var surfaceMoved = false

    /// How far the deck's playhead may sit from where the lock screen's
    /// extrapolation has it before the entry is rewritten. The OS counts on
    /// by itself between writes; a rewrite per position tick would be a write
    /// every few seconds for nothing (the JS write floor is one second too).
    static let nowPlayingDriftSec: Double = 1

    /// Whether Now Playing is showing an entry the engine wrote.
    var isPublishingNowPlaying: Bool { published != nil }

    /// After every input handled to the end (and once at start): the enabled
    /// set, then the entry. Never after a teardown: a relinquish leaves both
    /// for the legacy lane to overwrite (plan §4.6).
    private func publishSurface() {
        guard !isTornDown else { return }
        let availability = MediaMapping.commandAvailability(core.commandSnapshot)
        applyEnablement(availability.enabled)
        let moved = surfaceMoved
        surfaceMoved = false

        guard !availability.clearsNowPlaying, let view = core.mediaView(deck: seams.deck.reading) else {
            // Nil ONLY for a finished Foray, a close or a data deletion, and
            // only if the engine had written something (a fresh engine does
            // not wipe an entry it never owned).
            guard published != nil else { return }
            published = nil
            seams.nowPlaying.clear()
            seams.output.diag(DiagEntry(kind: DiagGate.nowPlayingKind, fields: [JSONMember("via", .string("clear"))]))
            return
        }
        let entry = MediaMapping.sessionView(view)
        let mono = seams.timing.monoMs
        let previous = published
        if let previous, !moved, !Self.needsWrite(entry, since: previous.view, elapsedMs: mono - previous.atMono) {
            return
        }
        published = PublishedEntry(view: entry, atMono: mono)
        seams.nowPlaying.write(entry)

        // DV-10 / H6: what the lock screen and the car were told, whenever
        // the words or the state change (not on a drift rewrite).
        let via: String?
        if previous?.view.metadata != entry.metadata {
            via = "metadata"
        } else if previous?.view.playbackState != entry.playbackState {
            via = "state"
        } else {
            via = nil
        }
        if let via {
            seams.output.diag(DiagEntry(kind: DiagGate.nowPlayingKind, fields: [
                JSONMember("via", .string(via)),
                JSONMember("title", .string(entry.metadata.title)),
                JSONMember("artist", .string(entry.metadata.artist)),
                JSONMember("album", .string(entry.metadata.album)),
                JSONMember("artwork", .string(entry.metadata.artwork.isEmpty ? "n" : "y")),
                JSONMember("state", .string(entry.playbackState)),
                JSONMember("rate", .number(NowPlayingRate.of(entry)))
            ]))
        }
    }

    /// A transition (words, state, duration or rate changed), or a playhead
    /// that has drifted from the OS's extrapolation of the last entry.
    static func needsWrite(_ next: MediaMapping.SessionView, since last: MediaMapping.SessionView,
                           elapsedMs: Double) -> Bool {
        if next.metadata != last.metadata || next.playbackState != last.playbackState { return true }
        guard let now = next.positionState, let then = last.positionState else {
            return next.positionState != last.positionState
        }
        if now.duration != then.duration || NowPlayingRate.of(next) != NowPlayingRate.of(last) { return true }
        let expected = then.position + Swift.max(0, elapsedMs) / 1000 * NowPlayingRate.of(last)
        let clamped = Swift.min(Swift.max(0, expected), then.duration)
        return abs(now.position - clamped) > nowPlayingDriftSec
    }

    /// Set only what changed: MediaPlayer re-lays the car's buttons on every
    /// enablement write.
    private func applyEnablement(_ enabled: Set<MediaMapping.RemoteCommand>) {
        guard enabled != enabledCommands else { return }
        let previous = enabledCommands
        enabledCommands = enabled
        for command in MediaMapping.RemoteCommand.allCases {
            let on = enabled.contains(command)
            if let previous, previous.contains(command) == on { continue }
            seams.remote.setEnabled(on, for: command)
        }
    }

    // MARK: - The interlude jingle and the silence node (NE-34)

    /// The core asks only when `interludeAvailable` is on and its session is
    /// active; InterludePlayer checks the real session again. A start that is
    /// not honoured (no player, or the player refused) is answered the way
    /// the JS answers a refused `start()`: an immediate `ended(refused)`,
    /// after this turn (the inbox), so the seam shrinks back to the beat.
    private func interpretInterlude(_ command: InterludeCommand) {
        switch command {
        case .start:
            if seams.interlude?.start() != true { handle(.interlude(.ended(reason: "refused"))) }
        case .stop:
            seams.interlude?.stop()
        case .release:
            seams.interlude?.release()
        }
    }

    /// The silence node (flagged off: the boot builds none unless
    /// `silenceNodeEnabled`). It never runs for a transport that is not
    /// running or without the session, whatever the command says; its own
    /// cap is `min(capMs, INTERLUDE_CEILING_SEC)` from now, the out-point.
    private func startSilence(capMs: Double) {
        guard let silence = seams.silence else { return }
        guard core.state.isRunning, core.state.session == .active else {
            seams.output.diag(DiagEntry(kind: "silence", fields: [
                JSONMember("kind", .string("node-refused")),
                JSONMember("why", .string(core.state.isRunning ? "no-session" : "not-running"))
            ]))
            return
        }
        _ = silence.start(capMs: capMs)
    }

    // MARK: - BackgroundGrace

    /// Plan §4.4: every begin has an expiration handler, and a refused begin
    /// or a nearly spent budget is written to the row, because that is the
    /// span the car will go silent in.
    private func beginGrace(_ reason: GraceReason) {
        if graceTask != nil || graceSpan != nil {
            // The core never opens a second span; if it ever did, the first
            // task must not outlive it unowned.
            endGrace(outcome: nil)
        }
        let task = seams.background.beginTask(named: "ForayEngine.grace.\(reason.rawValue)") { [weak self] in
            MainActor.assumeIsolated { self?.graceExpired() }
        }
        graceTask = task
        graceSpan = (reason, seams.timing.monoMs)
        // Nil (foreground) or non-finite is JSON null, never a number the
        // row cannot carry.
        let remainingMs = backgroundRemainingMs()
        seams.output.diag(DiagEntry(kind: "grace", fields: [
            JSONMember("kind", .string("begin")),
            JSONMember("reason", .string(reason.rawValue)),
            JSONMember("task", .string(task == nil ? "invalid" : "ok")),
            JSONMember("bgRemainingMs", remainingMs.map { JSONNode.number($0) } ?? .null),
            JSONMember("low", remainingMs.map { JSONNode.string($0 < Self.lowBackgroundRemainingMs ? "y" : "n") } ?? .null)
        ]))
    }

    /// The span is over: end its task (if the system gave one) and write how
    /// it ended and how long it was held: `grace kind=end outcome=<how>`, or
    /// `grace kind=expired` when the system took the time back. `outcome` nil
    /// is the host's own cleanup (a stale span replaced), which writes no row.
    private func endGrace(outcome: GraceOutcome?) {
        let span = graceSpan
        graceSpan = nil
        if let task = graceTask {
            graceTask = nil
            seams.background.endTask(task)
        }
        guard let outcome, let span else { return }
        seams.output.diag(DiagEntry(kind: "grace", fields: [
            JSONMember("kind", .string(outcome == .expired ? "expired" : "end")),
            JSONMember("outcome", .string(outcome.rawValue)),
            JSONMember("reason", .string(span.reason.rawValue)),
            JSONMember("heldMs", .number((seams.timing.monoMs - span.sinceMs).rounded()))
        ]))
    }

    /// The system took the time back. UIKit requires the task to end INSIDE
    /// this handler, so it ends here, first, with its `grace kind=expired`
    /// row; then the core hears it and applies the deterministic outcome (a
    /// pause with `stop cause=grace-expired`). Its own `.graceEnd(.expired)`
    /// then finds no task to end and no span to write twice.
    private func graceExpired() {
        endGrace(outcome: .expired)
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

import Foundation
import ForayEngineCore

/// THE DEVELOPER SESSION PROBE (card NE-25c; docs/native-engine-plan.md §2,
/// §8 R3, §10 DV-9): the one question a Simulator cannot answer, asked on the
/// founder's phone in M1 so NE-33 knows which path SpeechNarrator takes before
/// M2 starts.
///
/// THE QUESTION (DV-9). `AVSpeechSynthesizer` with `usesApplicationAudioSession
/// = true` speaks through the app's own session. Does the session it leaves
/// behind after `didFinish` still let a deck play, locked, in the background,
/// with no fresh activation? If it does, M2's narration can hand straight back
/// to the tape on the one session the engine owns. If it does not (the
/// synthesizer deactivated it, or another app took the route while it spoke),
/// SpeechNarrator must re-activate after every line, or render speech to a
/// buffer and play it through a deck. iOS has no public "is my session
/// active" getter, so the only honest reading is to try the play and time it.
///
/// WHAT IT DOES, driven by `engineSend probeSession` from the Developer drawer:
///
///   1. ARM: only while an episode is loaded and paused (the reducer's
///      `interrupted`). It records whether the session is held (`held=`,
///      `session=`, `hold=`) and arms a 10 s timer, long enough to lock the
///      phone.
///   2. SPEAK: a short line through the core's own audition path, so the
///      speech obeys the audible-start invariant (under `pauseHoldPolicy =
///      none` the core activates first; under the default `forever` it is
///      already active) and reaches the synthesizer configuration
///      SpeechNarrator will use (`PreviewSpeaker`).
///   3. PLAY, the moment the synthesizer reports `didFinish`: an ordinary
///      `play` of the paused episode through the core, which activates only
///      if its session is not active ("activate if needed") and opens
///      BackgroundGrace when backgrounded, exactly as a listener's play does.
///   4. WAIT for the deck's own `.playing` (`timeControlStatus`), at most 5 s.
///   5. RECORD `probe speech-then-play result=ok|failed token activateMs
///      timeToPlayingMs grace`, then PAUSE again, but only a play the probe
///      itself started: a listener who pressed play during the 10 s keeps it.
///
/// IT DECIDES NOTHING ABOUT PLAYBACK and touches no platform API: every step
/// is an `EngineInput` into the same host a car's press goes through, timed
/// on `EngineTiming`. So the whole sequence runs headless over the recording
/// fakes (`SessionProbeTests`), and the phone run differs only in which seams
/// are real. `shell-invariants.test.mjs` pins the imports.
///
/// Developer only: nothing in the engine builds a probe until the host hears
/// `probeSession`, and the page sends that from the Developer drawer alone.
@MainActor
final class SessionProbe {

    /// Long enough to lock the phone after the tap (the card's 10 s).
    static let armDelayMs: Double = 10_000
    /// A line this short speaks in about a second; a synthesizer that has not
    /// reported the end in 30 s never will, and the row says so.
    static let speechTimeoutMs: Double = 30_000
    /// The card's smoke asks for `.playing` within 1 s on the Simulator. On a
    /// locked phone the deck may have to rebuffer, so the probe waits five
    /// times that and reports the real number either way.
    static let playingTimeoutMs: Double = 5_000
    /// Short, and unmistakably not content if the founder hears it in the car.
    static let line = "Session probe."

    /// Where the probe is. One run at a time.
    enum Phase: String, Equatable {
        case idle
        case armed
        case speaking
        case awaitingPlaying = "awaiting-playing"
    }

    /// Why a run ended without `.playing`, beyond the core's own refusals
    /// (`session-failed:<token>`, `engine-busy`, ...), which pass through.
    enum Failure: String {
        /// The listener played (or the item went away) during the 10 s.
        case preempted
        /// The synthesizer said `didCancel`: the line never finished.
        case speechCancelled = "speech-cancelled"
        case speechTimeout = "speech-timeout"
        /// The play was accepted but the deck never confirmed `.playing`.
        case noPlaying = "no-playing"
    }

    private(set) var phase: Phase = .idle

    private weak var engine: ForayEngine?
    private var timer: EngineObservation?

    // One run's facts, for its row.
    private var held = false
    private var speakStartedMono: Double?
    private var speechMs: Double?
    private var sessionAtFinish: SessionPolicy.Phase?
    private var activationsBeforePlay: Int?
    private var playRequestedMono: Double?
    private var grace: GraceReason?

    init(engine: ForayEngine) {
        self.engine = engine
    }

    /// A timer is armed (arm delay, speech timeout or playing timeout).
    var hasLiveTimer: Bool { timer != nil }

    // MARK: - The steps

    /// Step 1. Refused, with the contract's own tokens, while a run is in
    /// flight or the engine is running (`engine-busy`), or with nothing
    /// loaded (`not-loaded`): there is no paused episode to play.
    func arm() -> EngineVerdict {
        guard let engine else { return Self.refusal(.relinquished) }
        guard phase == .idle else { return refuse(.engineBusy, why: "in-flight") }
        let state = engine.state
        guard let item = state.currentItem, state.loadedId == item.id else { return refuse(.notLoaded, why: "no-paused-item") }
        guard !state.isRunning, state.stateType == "interrupted" else { return refuse(.engineBusy, why: "not-paused") }
        resetRun()
        held = state.session == .active
        phase = .armed
        schedule(Self.armDelayMs) { [weak self] in self?.speak() }
        row("armed", [
            JSONMember("held", .bool(held)),
            JSONMember("session", .string(state.session.rawValue)),
            JSONMember("hold", .string(state.holdPolicy.text)),
            JSONMember("delayMs", .number(Self.armDelayMs))
        ])
        return EngineVerdict(failures: [], deferred: false)
    }

    /// Step 2, when the arm delay runs out.
    private func speak() {
        cancelTimer()
        guard let engine, phase == .armed else { return }
        let state = engine.state
        guard !state.isRunning, state.currentItem != nil else { return finish(failure: Failure.preempted.rawValue) }
        phase = .speaking
        speakStartedMono = engine.seams.timing.monoMs
        schedule(Self.speechTimeoutMs) { [weak self] in self?.speechTimedOut() }
        let verdict = engine.handle(.command(.audition(text: Self.line, voiceId: nil), source: .audition))
        if let failure = verdict.failures.first { finish(failure: failure) }
    }

    /// Step 3: the synthesizer's end, on main (the host forwards
    /// `Speaking.onFinish`). The play goes out in THIS call, the same main
    /// turn as `didFinish`, which is the moment DV-9 asks about.
    func speechEnded(_ end: SpeechEnd) {
        guard let engine, phase == .speaking else { return }
        cancelTimer()
        let now = engine.seams.timing.monoMs
        speechMs = speakStartedMono.map { now - $0 }
        guard end == .finished else { return finish(failure: Failure.speechCancelled.rawValue) }
        sessionAtFinish = engine.state.session
        activationsBeforePlay = engine.activations
        playRequestedMono = now
        phase = .awaitingPlaying
        schedule(Self.playingTimeoutMs) { [weak self] in self?.finish(failure: Failure.noPlaying.rawValue) }
        let verdict = engine.handle(.command(.play, source: .tap))
        // Read after the play's turn: a background play opens grace here, and
        // the deck's `.playing` ends it.
        grace = engine.state.grace
        if let failure = verdict.failures.first { finish(failure: failure) }
    }

    /// Step 4: every seam observation, after the core handled it.
    func observe(_ input: EngineInput) {
        guard phase == .awaitingPlaying, let engine,
              case let .deck(.timeControl(token, status, _)) = input, status == .playing,
              token == engine.state.loadedToken,
              let requested = playRequestedMono else { return }
        finish(failure: nil, timeToPlayingMs: engine.seams.timing.monoMs - requested)
    }

    /// The synthesizer never reported the end: stop it, and say so.
    private func speechTimedOut() {
        guard let engine, phase == .speaking else { return }
        finish(failure: Failure.speechTimeout.rawValue)
        engine.seams.speaker.stopSpeaking()
    }

    /// Relinquish or teardown: drop the run without a row or another input.
    func cancel() {
        cancelTimer()
        phase = .idle
        resetRun()
    }

    // MARK: - Step 5: the row, then the pause

    private func finish(failure: String?, timeToPlayingMs: Double? = nil) {
        cancelTimer()
        let probeStartedPlay = phase == .awaitingPlaying
        phase = .idle
        guard let engine else { return resetRun() }
        // Whether the play needed an activation: the host counts every
        // `activate()` it made, so anything past the count taken just before
        // the play was this play's.
        let activated = activationsBeforePlay.map { engine.activations > $0 } ?? false
        let activation = activated ? engine.lastActivation : nil
        row("speech-then-play", [
            JSONMember("result", .string(failure == nil ? "ok" : "failed")),
            JSONMember("token", failure.map { JSONNode.string($0) } ?? .null),
            JSONMember("activated", .bool(activated)),
            JSONMember("activateMs", Self.number(activation?.activateMs)),
            JSONMember("timeToPlayingMs", Self.number(timeToPlayingMs)),
            JSONMember("speechMs", Self.number(speechMs)),
            JSONMember("grace", .string(grace?.rawValue ?? "none")),
            JSONMember("held", .bool(held)),
            JSONMember("session", sessionAtFinish.map { JSONNode.string($0.rawValue) } ?? .null)
        ])
        resetRun()
        // "...and pauses again": only a play this probe started. A listener's
        // own play during the arm delay is theirs to keep.
        if probeStartedPlay, engine.state.isRunning {
            engine.handle(.command(.pause, source: .tap))
        }
    }

    // MARK: - Private

    private func refuse(_ refusal: EngineContract.Refusal, why: String) -> EngineVerdict {
        row("refused", [JSONMember("reason", .string(refusal.rawValue)), JSONMember("why", .string(why))])
        return Self.refusal(refusal)
    }

    private static func refusal(_ refusal: EngineContract.Refusal) -> EngineVerdict {
        EngineVerdict(failures: [refusal.rawValue], deferred: false)
    }

    private func schedule(_ afterMs: Double, _ fire: @escaping @MainActor () -> Void) {
        cancelTimer()
        guard let engine else { return }
        timer = engine.seams.timing.schedule(afterMs: afterMs, repeating: false) {
            MainActor.assumeIsolated { fire() }
        }
    }

    private func cancelTimer() {
        timer?.cancel()
        timer = nil
    }

    private func resetRun() {
        held = false
        speakStartedMono = nil
        speechMs = nil
        sessionAtFinish = nil
        activationsBeforePlay = nil
        playRequestedMono = nil
        grace = nil
    }

    /// `probe kind=<step>`: every probe row, through the engine's diagnostics.
    private func row(_ kind: String, _ fields: [JSONMember]) {
        engine?.seams.output.diag(DiagEntry(kind: "probe", fields: [JSONMember("kind", .string(kind))] + fields))
    }

    /// Milliseconds, one decimal; null when not measured.
    private static func number(_ ms: Double?) -> JSONNode {
        guard let ms, ms.isFinite else { return .null }
        return .number((ms * 10).rounded() / 10)
    }
}

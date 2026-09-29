import XCTest
import AVFoundation
import ForayEngineCore
@testable import ForayAudioPlugin

/// NE-25c part (1): the speech-then-play SIMULATOR SMOKE
/// (docs/native-engine-plan.md §2 "Assumed", §8 R3, card NE-25c).
///
/// EXPLICITLY NOT EVIDENCE. DV-9 asks whether the session an
/// `AVSpeechSynthesizer` (`usesApplicationAudioSession = true`) leaves behind
/// after `didFinish` still lets a deck play on a LOCKED PHONE, in the
/// background, in a car. A Simulator has no lock, no background, no car and no
/// other app; its "session" is the Mac's audio. So this only shows the obvious
/// failure is absent on the rig: with the production pieces (AudioSessionOwner's
/// category and activation, SpeechNarrator's synthesizer configuration (the direct path), the
/// real AVDeck), a deck started in the same main turn as `didFinish` reaches
/// `.playing` within 1 s, and no interruption notification arrives. The answer
/// that decides NE-33's path comes from the Developer probe on the phone
/// (`SessionProbe`, the desk pre-flight of NE-27).
///
/// iOS has no public "is the session active" getter, so the observable proxy
/// is the deck's own `timeControlStatus`, plus `isOtherAudioPlaying` and
/// `secondaryAudioShouldBeSilencedHint` logged before the line, at
/// `didFinish` and at `.playing`. Every number goes to the job summary
/// (`MeasurementReport`, tag `NE-25c`) and one `NE-25c-json` log line, and from
/// there into docs/ios-native-engine-measurements.md §11, labelled "Simulator
/// smoke".
///
/// RUN ON CI ONLY (ios-kit, `xcodebuild test -scheme ForayAudio`).
final class SpeechSessionSmokeTests: XCTestCase {
    static let tag = "NE-25c"
    /// The card's bound: `.playing` within 1 s of the play.
    static let playingWithinMs: Double = 1_000
    /// Generous: a Simulator's first utterance loads a voice.
    static let speechTimeoutSec: TimeInterval = 45
    /// `SessionProbe.line`, spelled out: the probe's constants belong to the
    /// main actor and these Simulator tests run outside it.
    static let line = "Session probe."

    override class func setUp() {
        super.setUp()
        DeckMeasurements.warmUpOnce()
        SpeechWarmUp.once()
    }

    /// Every speech test needs a synthesizer that has spoken once in this
    /// process (see `SpeechWarmUp`). One that never did is this runner's
    /// limit, recorded in the job summary, not a finding about the engine.
    private func requireSpeech() throws {
        try XCTSkipIf(AVSpeechSynthesisVoice.speechVoices().isEmpty, "this Simulator has no speech voice installed")
        try XCTSkipIf(SpeechWarmUp.coldMs == nil,
                      "the Simulator's synthesizer never finished a warm-up line in \(SpeechWarmUp.timeoutSec) s")
    }

    private func fixture(_ name: String, _ ext: String) throws -> URL {
        try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "ClickTracks"),
            "missing bundled fixture ClickTracks/\(name).\(ext)"
        )
    }

    /// Spin the main run loop (where every deck and speaker callback lands)
    /// until `done` holds or the time runs out.
    @discardableResult
    private func spin(until timeout: TimeInterval, _ done: () -> Bool) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until {
            if done() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.005))
        }
        return done()
    }

    private struct Reading: Encodable {
        var otherAudioPlaying: Bool
        var silenceHint: Bool

        init(_ session: AVAudioSession) {
            otherAudioPlaying = session.isOtherAudioPlaying
            silenceHint = session.secondaryAudioShouldBeSilencedHint
        }

        var cell: String { "other=\(otherAudioPlaying ? "y" : "n") hint=\(silenceHint ? "y" : "n")" }
    }

    private struct Trial: Encodable {
        var card = "NE-25c"
        var activationOk: Bool
        var activateMs: Double?
        var voices: Int
        var speechMs: Double
        var delegateOnMain: Bool
        var playToPlayingMs: Double?
        var interruptions: Int
        var faults: [String]
        var beforeLine: Reading
        var atDidFinish: Reading?
        var atPlaying: Reading?
    }

    /// The smoke. TO SEE IT FAIL: deactivate the session in
    /// `SpeechNarrator`'s `onFinish` path before the play (the deck's play
    /// then trips the implicit-activation fault); or send the play before the
    /// line ends (a second audible producer while the synthesizer speaks is
    /// what `speechMs` and the ordering assertion catch).
    func testADeckStartedInTheSameTurnAsDidFinishPlaysWithinOneSecond() throws {
        try requireSpeech()
        let voices = AVSpeechSynthesisVoice.speechVoices().count

        var sessionRows: [DiagEntry] = []
        let owner = AudioSessionOwner(config: AudioSessionOwner.Config(diag: { sessionRows.append($0) }))
        let activation = owner.activate()
        XCTAssertTrue(activation.ok, "the Simulator refused .playback/.spokenAudio: \(sessionRows)")
        defer { owner.deactivate(notifyOthers: false) }
        let session = AVAudioSession.sharedInstance()

        var interruptions: [String] = []
        let observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { note in
            interruptions.append(String(describing: note.userInfo ?? [:]))
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        var faults: [String] = []
        var rows: [String] = []
        var events: [(at: Date, event: DeckEvent)] = []
        let deck = AVDeck(config: AVDeck.Config(
            loadDeadlineSec: 40,
            sessionIsActive: { owner.phase == .active },
            writeRow: { rows.append($0) },
            debugFault: { faults.append($0) }
        ))
        deck.onEvent = { events.append((at: Date(), event: $0)) }
        defer { deck.send(.unload) }

        // The episode is loaded and paused before the line, as the probe's is.
        deck.send(.loadURL(token: 1, url: try fixture("click-cbr", "mp3"), startSec: 5, preciseTiming: true))
        let ready = spin(until: 45) {
            events.contains { if case .ready(1, _, _, _) = $0.event { return true }; return false }
        }
        XCTAssertTrue(ready, "the deck never became ready: \(events.map { $0.event })")
        guard ready else { return }

        var speakerRows: [DiagEntry] = []
        let speaker = SpeechNarrator(config: SpeechNarrator.Config(
            path: .direct,
            sessionIsActive: { owner.phase == .active },
            diag: { speakerRows.append($0) },
            debugFault: { faults.append($0) }
        ))
        XCTAssertTrue(speaker.synthesizer?.usesApplicationAudioSession ?? false, "the smoke must run the configuration SpeechNarrator ships")

        let beforeLine = Reading(session)
        var ends: [SpeechEnd] = []
        var atDidFinish: Reading?
        var playSentAt: Date?
        var audibleDuringLine = false
        speaker.onFinish = { end in
            ends.append(end)
            atDidFinish = Reading(session)
            guard end == .finished else { return }
            // The SAME main turn as didFinish (when the delegate is on main):
            // nothing runs between the synthesizer's end and the deck's play.
            playSentAt = Date()
            deck.send(.play)
        }
        let spokeAt = Date()
        speaker.speak(text: Self.line, voiceId: nil)
        let ended = spin(until: Self.speechTimeoutSec) {
            if deck.player.rate != 0 && playSentAt == nil { audibleDuringLine = true }
            return !ends.isEmpty
        }
        XCTAssertTrue(ended, "the synthesizer never reported the line's end in \(Self.speechTimeoutSec) s")
        XCTAssertEqual(ends, [.finished], "the line was cancelled, so nothing was played after it")
        XCTAssertFalse(audibleDuringLine, "the deck sounded while the line was being spoken")
        let speechMs = (playSentAt ?? Date()).timeIntervalSince(spokeAt) * 1000

        // `.playing` from the deck's own KVO, after the play; wait past the
        // bound so a slow start is MEASURED rather than only failed.
        var playingAt: Date?
        if let sent = playSentAt {
            spin(until: 5) {
                playingAt = events.first(where: {
                    guard $0.at >= sent, case .timeControl(1, .playing, _) = $0.event else { return false }
                    return true
                })?.at
                return playingAt != nil
            }
        }
        let atPlaying = playingAt.map { _ in Reading(session) }
        var playToPlayingMs: Double?
        if let sent = playSentAt, let playing = playingAt { playToPlayingMs = playing.timeIntervalSince(sent) * 1000 }
        spin(until: 0.5) { false } // a late interruption would land here
        let delegateOnMain = !speakerRows.contains { $0[field: "thread"] == .string("bg") }

        let trial = Trial(
            activationOk: activation.ok, activateMs: activation.activateMs, voices: voices,
            speechMs: speechMs, delegateOnMain: delegateOnMain, playToPlayingMs: playToPlayingMs,
            interruptions: interruptions.count, faults: faults,
            beforeLine: beforeLine, atDidFinish: atDidFinish, atPlaying: atPlaying
        )
        MeasurementReport.table(
            title: "NE-25c: speech, then a deck in the same turn (Simulator smoke, not evidence)",
            columns: ["activateMs", "line start to didFinish, ms", "didFinish on main", "play to .playing, ms",
                      "interruptions", "before the line", "at didFinish", "at .playing"],
            rows: [[
                activation.activateMs.map { msValue($0) } ?? "-",
                msValue(speechMs),
                delegateOnMain ? "yes (same turn)" : "no (hopped)",
                playToPlayingMs.map { msValue($0) } ?? "never",
                "\(interruptions.count)",
                beforeLine.cell,
                atDidFinish?.cell ?? "-",
                atPlaying?.cell ?? "-"
            ]],
            notes: [
                "AudioSessionOwner (.playback/.spokenAudio) activated; SpeechNarrator on the direct path (usesApplicationAudioSession = true, 1x); the production AVDeck on click-cbr.mp3, loaded and paused before the line.",
                "SIMULATOR SMOKE, NOT EVIDENCE: no lock, no background, no car. DV-9 is answered by the Developer session probe on the phone (NE-27 desk pre-flight).",
                "Voices installed: \(voices). Implicit-activation faults: \(faults.isEmpty ? "none" : faults.joined(separator: "; ")).",
                "The line is WARM: this process's first line (SpeechWarmUp) finished after \(SpeechWarmUp.coldMs.map { msValue($0) } ?? "-") ms."
            ],
            tag: Self.tag
        )
        MeasurementReport.json(trial, tag: Self.tag)

        let playToPlaying = try XCTUnwrap(playToPlayingMs, "the deck never reached .playing after didFinish; events: \(events.map { $0.event })")
        XCTAssertLessThan(playToPlaying, Self.playingWithinMs, ".playing came \(playToPlaying) ms after the play")
        XCTAssertEqual(deck.player.timeControlStatus, .playing)
        XCTAssertEqual(interruptions, [], "an interruption arrived around the speech-then-play")
        XCTAssertEqual(faults, [], "the deck or the speaker found the session inactive (implicit activation)")
    }

    /// A line replaced by a newer one ends SILENTLY: `onFinish` fires once,
    /// for the new line. A probe or a narrator waiting on the old line's end
    /// would otherwise take its cancel for the new line's.
    /// TO SEE IT FAIL: drop the `utterance === self.current` check in
    /// `DirectOutput.deliver` (and SpeechNarrator's current-line check), or make the new line current AFTER stopping
    /// the old one.
    func testAReplacedLineEndsSilentlyAndTheNewOneReportsOnce() throws {
        try requireSpeech()
        var sessionRows: [DiagEntry] = []
        let owner = AudioSessionOwner(config: AudioSessionOwner.Config(diag: { sessionRows.append($0) }))
        XCTAssertTrue(owner.activate().ok, "\(sessionRows)")
        defer { owner.deactivate(notifyOthers: false) }

        var faults: [String] = []
        let speaker = SpeechNarrator(config: SpeechNarrator.Config(
            path: .direct,
            sessionIsActive: { owner.phase == .active }, diag: { _ in }, debugFault: { faults.append($0) }))
        var ends: [SpeechEnd] = []
        speaker.onFinish = { ends.append($0) }

        speaker.speak(text: "This first line is long enough to still be speaking when it is replaced.", voiceId: nil)
        // Replaced MID-SPEECH. In mutation run 36064544632 this test passed
        // with the identity check gone; the likely reason is that the first
        // line was still queued behind a loading voice, and a line cancelled
        // before it starts gets no delegate call. So it must have started.
        XCTAssertTrue(spin(until: 15) { speaker.linesStarted == 1 }, "the first line never started")
        spin(until: 0.5) { false }
        XCTAssertTrue(speaker.synthesizer?.isSpeaking ?? false, "the first line ended before it could be replaced")
        speaker.speak(text: Self.line, voiceId: nil)
        XCTAssertTrue(spin(until: Self.speechTimeoutSec) { !ends.isEmpty }, "the replacing line never ended")
        spin(until: 1) { false }
        XCTAssertEqual(ends, [.finished], "one end, the new line's; the replaced line's cancel is not reported")
        XCTAssertEqual(faults, [])
    }

    /// The implicit-activation guard (plan §4.3): a line spoken while the
    /// owner's session is not active writes the fault row and trips the
    /// DEBUG stop, and still speaks (silence would hide the core's bug).
    /// TO SEE IT FAIL: drop the `sessionIsActive()` check in `speak`.
    func testSpeakingWithoutAnActiveSessionIsAFault() {
        var rows: [DiagEntry] = []
        var faults: [String] = []
        let speaker = SpeechNarrator(config: SpeechNarrator.Config(
            path: .direct,
            sessionIsActive: { false }, diag: { rows.append($0) }, debugFault: { faults.append($0) }))
        speaker.speak(text: Self.line, voiceId: nil)
        speaker.stopSpeaking()
        XCTAssertEqual(faults, ["fault implicit-activation speaker"])
        XCTAssertEqual(rows.map { $0.kind }, ["fault"])
        XCTAssertEqual(rows.first?[field: "kind"], .string("implicit-activation"))
        XCTAssertEqual(rows.first?[field: "at"], .string("speaker"))
    }

    /// The configuration SpeechNarrator ships (OQ-3: 1x is Apple's default
    /// rate; the synthesizer speaks through the app's session). A voice this
    /// device does not have falls back to the system's, never to nothing.
    /// TO SEE IT FAIL: set another rate in `utterance(text:voiceId:)`.
    func testTheEnginesUtteranceIsOneXOnTheApplicationSession() {
        XCTAssertTrue(SpeechNarrator.makeSynthesizer().usesApplicationAudioSession)
        let utterance = SpeechNarrator.utterance(text: "x", voiceId: "com.example.no-such-voice")
        XCTAssertEqual(utterance.rate, AVSpeechUtteranceDefaultSpeechRate)
        XCTAssertNil(utterance.voice, "an unknown identifier leaves the system's voice")
    }
}

/// The Simulator's first line in a process loads a voice, and on the CI
/// runners that has taken 2.3 s (run 36062420799), 11.0 s (run 36064494379)
/// and more than 45 s (run 36064544632). The smoke is about the moment AFTER
/// a line, so it speaks one line first, through the same owner and the same
/// synthesizer configuration, waits for it, and records the cold time as a
/// measurement. On the phone the probe's own `speechMs` carries it.
enum SpeechWarmUp {
    static let timeoutSec: TimeInterval = 120
    /// The warm-up line's time to `didFinish`, or nil when it never ended.
    private(set) static var coldMs: Double?
    private static var done = false

    static func once() {
        guard !done else { return }
        done = true
        guard !AVSpeechSynthesisVoice.speechVoices().isEmpty else { return }
        let owner = AudioSessionOwner(config: AudioSessionOwner.Config(diag: { _ in }))
        _ = owner.activate()
        defer { owner.deactivate(notifyOthers: false) }
        let speaker = SpeechNarrator(config: SpeechNarrator.Config(
            path: .direct,
            sessionIsActive: { owner.phase == .active }, diag: { _ in }, debugFault: { _ in }))
        var ended = false
        speaker.onFinish = { _ in ended = true }
        let started = Date()
        speaker.speak(text: "Warm up.", voiceId: nil)
        let until = started.addingTimeInterval(timeoutSec)
        while !ended && Date() < until {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        if ended { coldMs = Date().timeIntervalSince(started) * 1000 }
        MeasurementReport.table(
            title: "NE-25c: the synthesizer's cold first line (Simulator)",
            columns: ["first line to didFinish, ms", "waited up to, s"],
            rows: [[coldMs.map { msValue($0) } ?? "never", "\(Int(timeoutSec))"]],
            notes: ["A warm-up, not a finding: the smoke that follows measures a warm line."],
            tag: SpeechSessionSmokeTests.tag
        )
    }
}

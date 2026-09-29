import XCTest
import AVFoundation
import ForayEngineCore
@testable import ForayAudioPlugin

/// SpeechNarrator (card NE-33): the engine's one synthesizer, for the
/// audition and for a Foray's narration.
///
/// The bookkeeping (which line is current, what is reported for each of the
/// core's commands, which voice a line is spoken in) runs against a recording
/// `SpeechOutput`, so every assertion is exact and nothing waits on the
/// Simulator's synthesizer. The PCM output itself (path B, the default while
/// DV-9 has no row) has one Simulator smoke at the end, labelled as one.
final class SpeechNarratorTests: XCTestCase {

    // MARK: - A recording output

    final class RecordingOutput: SpeechOutput {
        var onEnd: ((Int, SpeechEnd) -> Void)?
        var synthesizer: AVSpeechSynthesizer? { nil }
        var linesStarted: Int { started.count }
        private(set) var started: [(id: Int, line: SpeechLine)] = []
        private(set) var calls: [String] = []
        var resumeAnswer = true

        func start(_ line: SpeechLine, id: Int) {
            started.append((id, line))
            calls.append("start:\(id)")
        }
        func pause() -> Bool { calls.append("pause"); return true }
        func resume() -> Bool { calls.append("resume"); return resumeAnswer }
        func stop() { calls.append("stop") }

        /// The line `id` was heard to its end (or cut off).
        func end(_ id: Int, _ end: SpeechEnd = .finished) { onEnd?(id, end) }
        var lastId: Int { started.last?.id ?? 0 }
    }

    private static let ava = SpeechRules.VoiceOption(identifier: "com.apple.voice.premium.en-US.Ava", name: "Ava",
                                                     language: "en-US", qualityRank: 3)
    private static let samanthaCompact = SpeechRules.VoiceOption(identifier: "com.apple.ttsbundle.Samantha-compact",
                                                                 name: "Samantha", language: "en-US", qualityRank: 1)
    private static let samanthaEnhanced = SpeechRules.VoiceOption(identifier: "com.apple.voice.enhanced.en-US.Samantha",
                                                                  name: "Samantha", language: "en-US", qualityRank: 2)
    private static let albert = SpeechRules.VoiceOption(identifier: "com.apple.speech.synthesis.voice.Albert", name: "Albert",
                                                        language: "en-US", qualityRank: 1)

    private var output: RecordingOutput!
    private var events: [NarratorEvent] = []
    private var ends: [SpeechEnd] = []
    private var rows: [DiagEntry] = []
    private var faults: [String] = []

    private func makeNarrator(voices: [SpeechRules.VoiceOption] = [SpeechNarratorTests.ava, SpeechNarratorTests.samanthaCompact, SpeechNarratorTests.albert],
                          sessionActive: Bool = true,
                          lexicon: [SpeechRules.LexiconEntry] = []) -> SpeechNarrator {
        output = RecordingOutput()
        events = []
        ends = []
        rows = []
        faults = []
        let narrator = SpeechNarrator(config: SpeechNarrator.Config(
            sessionIsActive: { sessionActive },
            diag: { [unowned self] in self.rows.append($0) },
            debugFault: { [unowned self] in self.faults.append($0) },
            installedVoices: { voices },
            language: { "en-US" },
            systemVoiceName: { _ in "Albert" },
            lexicon: lexicon,
            output: output))
        narrator.onNarratorEvent = { [unowned self] in self.events.append($0) }
        narrator.onFinish = { [unowned self] in self.ends.append($0) }
        return narrator
    }

    // MARK: - The card's four

    /// Pause and resume mid-utterance CONTINUES the same line: the output is
    /// asked to resume, never to speak it again, and the line's natural end is
    /// its one `finished`.
    /// TO SEE IT FAIL: have `resume` call `begin` (a re-speak), or answer it
    /// `.fromStart`.
    func testPauseAndResumeMidUtteranceContinuesTheSameLine() {
        let narrator = makeNarrator()
        narrator.narrate(.speak(seq: 7, text: "A line long enough to pause.", voiceId: nil, utteranceRate: 1))
        narrator.narrate(.pause(seq: 7))
        narrator.narrate(.resume(seq: 7))
        XCTAssertEqual(output.calls, ["start:1", "pause", "resume"], "one start, then the same line held and continued")
        output.end(output.lastId)
        XCTAssertEqual(events, [.started(seq: 7, voiceFallback: false), .resumed(seq: 7, answer: .continued), .finished(seq: 7)])
    }

    /// Stop does not advance: a stopped line reports `cancelled`, and an end
    /// the output reports for it afterwards is not a `finished`.
    /// TO SEE IT FAIL: map `.stop` to `.finished`, or keep the line current
    /// after a stop.
    func testStopNeverAdvances() {
        let narrator = makeNarrator()
        narrator.narrate(.speak(seq: 3, text: "Stopped halfway.", voiceId: nil, utteranceRate: 1))
        let id = output.lastId
        narrator.narrate(.stop(seq: 3))
        output.end(id, .finished)
        XCTAssertEqual(events, [.started(seq: 3, voiceFallback: false), .cancelled(seq: 3)])
        XCTAssertFalse(events.contains(.finished(seq: 3)), "a stop is never a finish (L-05)")
        XCTAssertEqual(output.calls.last, "stop")
    }

    /// A voice that is not installed is spoken in the fallback and REPORTED
    /// (V-01), with a `speaker kind=voice-fallback` row.
    /// TO SEE IT FAIL: report `voiceFallback: false` unconditionally.
    func testAVoiceThatIsNotInstalledFallsBackAndSaysSo() {
        let narrator = makeNarrator()
        narrator.narrate(.speak(seq: 1, text: "line", voiceId: "com.example.not-installed", utteranceRate: 1))
        XCTAssertEqual(events, [.started(seq: 1, voiceFallback: true)])
        XCTAssertEqual(output.started.first?.line.voiceIdentifier, Self.ava.identifier,
                       "resolveVoice's fallback: the best installed tier")
        XCTAssertEqual(rows.map(\.kind), ["speaker"])
        XCTAssertEqual(rows.first?[field: "kind"], .string("voice-fallback"))
    }

    /// With no voiceId (a cold start whose restore record holds none, or a
    /// listener who never chose), the line is spoken in pickDefaultVoice's
    /// answer (Samantha's best installed tier), NEVER bestVoice's (Ava
    /// premium here, the highest tier on the device).
    /// TO SEE IT FAIL: resolve a nil voiceId through `resolveVoice` alone.
    func testWithNoVoiceIdTheColdPathSpeaksTheDefaultVoiceNotTheBestTier() {
        let narrator = makeNarrator(voices: [Self.ava, Self.samanthaCompact, Self.samanthaEnhanced, Self.albert])
        narrator.narrate(.speak(seq: 1, text: "cold start", voiceId: nil, utteranceRate: 1))
        XCTAssertEqual(output.started.first?.line.voiceIdentifier, Self.samanthaEnhanced.identifier)
        XCTAssertNotEqual(output.started.first?.line.voiceIdentifier,
                          SpeechRules.bestVoice(among: [Self.ava, Self.samanthaCompact, Self.samanthaEnhanced, Self.albert],
                                                language: "en-US", preferringName: "Albert")?.identifier)
        XCTAssertEqual(events, [.started(seq: 1, voiceFallback: false)], "the default is not a fallback")
        // The restore record's voiceId (the core passes it on `speak`) wins.
        narrator.narrate(.speak(seq: 2, text: "chosen", voiceId: Self.albert.identifier, utteranceRate: 1))
        XCTAssertEqual(output.started.last?.line.voiceIdentifier, Self.albert.identifier)
        // No Samantha at all: the synthesizer's own pick (#491's heuristic).
        let bare = makeNarrator(voices: [Self.ava, Self.albert])
        bare.narrate(.speak(seq: 1, text: "no samantha", voiceId: nil, utteranceRate: 1))
        XCTAssertEqual(output.started.first?.line.voiceIdentifier, Self.ava.identifier)
    }

    // MARK: - The rest of the contract

    /// A line replaced by a newer one ends SILENTLY; only the line in flight
    /// reports. A discarded line reports nothing at all.
    func testAReplacedOrDiscardedLineReportsNothing() {
        let narrator = makeNarrator()
        narrator.narrate(.speak(seq: 1, text: "first", voiceId: nil, utteranceRate: 1))
        let first = output.lastId
        narrator.narrate(.speak(seq: 2, text: "second", voiceId: nil, utteranceRate: 1))
        output.end(first, .cancelled)
        output.end(output.lastId)
        XCTAssertEqual(events, [.started(seq: 1, voiceFallback: false), .started(seq: 2, voiceFallback: false), .finished(seq: 2)])
        events = []
        narrator.narrate(.speak(seq: 3, text: "third", voiceId: nil, utteranceRate: 1))
        let third = output.lastId
        narrator.narrate(.pause(seq: 3))
        narrator.narrate(.discard(seq: 3))
        output.end(third)
        XCTAssertEqual(events, [.started(seq: 3, voiceFallback: false)], "a discard is silent, and its line never finishes")
    }

    /// A resume for a line that is not held is refused, not faked; a resume
    /// the output cannot honour is refused with the output's reason.
    func testAResumeThatCannotContinueIsRefused() {
        let narrator = makeNarrator()
        narrator.narrate(.resume(seq: 9))
        XCTAssertEqual(events, [.resumed(seq: 9, answer: .refused(reason: "not-held"))])
        events = []
        narrator.narrate(.speak(seq: 10, text: "held", voiceId: nil, utteranceRate: 1))
        narrator.narrate(.pause(seq: 10))
        output.resumeAnswer = false
        narrator.narrate(.resume(seq: 10))
        XCTAssertEqual(events, [.started(seq: 10, voiceFallback: false), .resumed(seq: 10, answer: .refused(reason: "output-refused"))])
    }

    /// Narration is 1x, Apple's default rate (founder 2026-09-24), and the
    /// bundled lexicon marks each hard term with its IPA.
    func testALineIsOneXAndCarriesTheBundledLexicon() {
        let narrator = makeNarrator(lexicon: SpeechLexicon.entries)
        narrator.narrate(.speak(seq: 1, text: "A cup of sake, warm.", voiceId: nil, utteranceRate: 1))
        let line = output.started.first?.line
        XCTAssertEqual(line?.rate, AVSpeechUtteranceDefaultSpeechRate)
        XCTAssertEqual(line?.overrides, [SpeechRules.IpaOverride(term: "sake", ipa: "ˈsɑːkeɪ", start: 9, end: 13)])
        XCTAssertFalse(SpeechLexicon.entries.isEmpty, "the bundled lexicon parses")
        let utterance = SpeechNarrator.utterance(text: "A cup of sake, warm.", voiceId: nil, rate: line?.rate ?? 0,
                                                 overrides: line?.overrides ?? [])
        let ipa = utterance.attributedSpeechString.attribute(NSAttributedString.Key(AVSpeechSynthesisIPANotationAttribute),
                                                             at: 10, effectiveRange: nil) as? String
        XCTAssertEqual(ipa, "ˈsɑːkeɪ")
    }

    /// The audition and a narration line share the synthesizer; the audition
    /// reports through `onFinish`, and every audible start checks the session
    /// first (the implicit-activation fault, as AVDeck's play).
    func testTheAuditionReportsThroughOnFinishAndAnInactiveSessionIsAFault() {
        let narrator = makeNarrator(sessionActive: false)
        narrator.speak(text: "audition", voiceId: nil)
        output.end(output.lastId)
        XCTAssertEqual(ends, [.finished])
        XCTAssertEqual(events, [])
        XCTAssertEqual(faults, ["fault implicit-activation speaker"])
        XCTAssertEqual(rows.first?[field: "kind"], .string("implicit-activation"))
        XCTAssertEqual(rows.first?[field: "at"], .string("speaker"))
    }

    /// The default path is PCM while DV-9 has no row; the direct path is
    /// behind `EngineConfig.speechDirect`, off.
    func testThePcmPathIsTheDefault() {
        XCTAssertFalse(EngineConfig().speechDirect)
        XCTAssertEqual(SpeechNarrator.Config(sessionIsActive: { true }, diag: { _ in }).path, .pcm)
        let narrator = SpeechNarrator(config: SpeechNarrator.Config(sessionIsActive: { true }, diag: { _ in }))
        XCTAssertTrue(narrator.output is PcmOutput)
        XCTAssertTrue(narrator.synthesizer?.usesApplicationAudioSession ?? false)
    }

    // MARK: - The PCM output on the Simulator (smoke, not evidence)

    /// Path B end to end on the rig: a line rendered by the synthesizer,
    /// played by the engine's own player, paused mid-line, resumed, and heard
    /// to its end. A Simulator has no lock and no car: this shows only that
    /// the plumbing works; NE-37's H5/DV-9 re-check is the evidence.
    func testThePcmOutputPausesResumesAndFinishesOnTheSimulator() throws {
        try XCTSkipIf(AVSpeechSynthesisVoice.speechVoices().isEmpty, "this Simulator has no speech voice installed")
        var sessionRows: [DiagEntry] = []
        let owner = AudioSessionOwner(config: AudioSessionOwner.Config(diag: { sessionRows.append($0) }))
        XCTAssertTrue(owner.activate().ok, "\(sessionRows)")
        defer { owner.deactivate(notifyOthers: false) }

        var outputRows: [DiagEntry] = []
        let pcm = PcmOutput(diag: { outputRows.append($0) })
        var ends: [SpeechEnd] = []
        pcm.onEnd = { _, end in ends.append(end) }
        pcm.start(SpeechLine(text: "This line is rendered to buffers and played by the engine's own player.",
                             voiceIdentifier: nil, rate: AVSpeechUtteranceDefaultSpeechRate, overrides: []), id: 1)
        guard spin(until: 60, { pcm.linesStarted == 1 || !ends.isEmpty }) else {
            throw XCTSkip("the Simulator's synthesizer rendered nothing in 60 s")
        }
        try XCTSkipIf(outputRows.contains { $0[field: "kind"] == .string("engine-start-failed") },
                      "this runner's AVAudioEngine would not start: \(outputRows)")
        XCTAssertTrue(pcm.pause())
        spin(until: 0.5, { false })
        XCTAssertEqual(ends, [], "a held line does not end")
        XCTAssertTrue(pcm.resume())
        XCTAssertTrue(spin(until: 60, { !ends.isEmpty }), "the resumed line never ended: \(outputRows)")
        XCTAssertEqual(ends, [.finished])
    }

    @discardableResult
    private func spin(until timeout: TimeInterval, _ done: () -> Bool) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until {
            if done() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.005))
        }
        return done()
    }
}

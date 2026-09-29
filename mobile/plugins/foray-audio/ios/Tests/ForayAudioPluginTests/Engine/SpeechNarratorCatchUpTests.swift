import XCTest
import AVFoundation
import ForayEngineCore
@testable import ForayAudioPlugin

/// A recording `SpeechOutput` for the catch-up tests below (file scope, so
/// the parity guard reads every test method here as the test class's own).
final class CatchUpRecordingOutput: SpeechOutput {
    var onEnd: ((Int, SpeechEnd) -> Void)?
    var synthesizer: AVSpeechSynthesizer? { nil }
    var linesStarted: Int { started.count }
    private(set) var started: [Int] = []
    private(set) var calls: [String] = []

    func start(_ line: SpeechLine, id: Int) {
        started.append(id)
        calls.append("start:\(id)")
    }
    func pause() -> Bool { calls.append("pause"); return true }
    func resume() -> Bool { calls.append("resume"); return true }
    func stop() { calls.append("stop") }

    /// The line `id` ended.
    func end(_ id: Int, _ end: SpeechEnd = .finished) { onEnd?(id, end) }
    var lastId: Int { started.last ?? 0 }
}

/// Card NE-37c: the narrator's half of the rules `main` added to the JS
/// player while `engine/m2` was held (audit round 3), and the audition's
/// end, which is never narration's.
final class SpeechNarratorCatchUpTests: XCTestCase {
    private var output: CatchUpRecordingOutput!
    private var events: [NarratorEvent] = []
    private var ends: [SpeechEnd] = []
    private var rows: [DiagEntry] = []

    private func makeNarrator() -> SpeechNarrator {
        output = CatchUpRecordingOutput()
        events = []
        ends = []
        rows = []
        let voice = SpeechRules.VoiceOption(identifier: "com.apple.speech.synthesis.voice.Albert", name: "Albert",
                                            language: "en-US", qualityRank: 1)
        let narrator = SpeechNarrator(config: SpeechNarrator.Config(
            sessionIsActive: { true },
            diag: { [unowned self] in self.rows.append($0) },
            debugFault: { _ in },
            installedVoices: { [voice] },
            language: { "en-US" },
            systemVoiceName: { _ in "Albert" },
            lexicon: [],
            output: output))
        narrator.onNarratorEvent = { [unowned self] in self.events.append($0) }
        narrator.onFinish = { [unowned self] in self.ends.append($0) }
        return narrator
    }

    /// A line the OUTPUT could not play (its first buffer would not convert,
    /// connect or start: `pcm-refused`) is OVER and says so as a finish, so the
    /// core advances at once instead of running the line's clock over silence
    /// to its deadline: queue-manager.js "an engine error reported on
    /// `finished` moves on at once (mobile-native-3)". A cancel still never
    /// advances (L-05).
    /// TO SEE IT FAIL: report `.failed` as `.cancelled`.
    func testALineTheOutputCouldNotPlayIsOverAndAdvances() {
        let narrator = makeNarrator()
        narrator.narrate(.speak(seq: 4, text: "A line the output refuses.", voiceId: nil, utteranceRate: 1))
        output.end(output.lastId, .failed)
        XCTAssertEqual(events, [.started(seq: 4, voiceFallback: false), .finished(seq: 4)])
        XCTAssertTrue(rows.contains { $0.kind == "speaker" && $0[field: "kind"] == .string("line-failed") }, "\(rows)")
        events = []
        narrator.narrate(.speak(seq: 5, text: "A line cut off.", voiceId: nil, utteranceRate: 1))
        output.end(output.lastId, .cancelled)
        XCTAssertEqual(events, [.started(seq: 5, voiceFallback: false), .cancelled(seq: 5)])
    }

    /// A new line after a PAUSED one is spoken, never queued silently behind
    /// the pause: the output starts it (silencing the held one), and the
    /// narrator does not believe the new line is paused. transport-reconcile
    /// "a skip from a PAUSED narration line to the next line is heard, not
    /// queued behind the pause (audit round 3, mobile-native-1)".
    /// TO SEE IT FAIL: keep `paused` across `begin`.
    func testANewLineAfterAPausedOneIsSpokenNotQueuedBehindThePause() {
        let narrator = makeNarrator()
        narrator.narrate(.speak(seq: 1, text: "The first line.", voiceId: nil, utteranceRate: 1))
        narrator.narrate(.pause(seq: 1))
        narrator.narrate(.speak(seq: 2, text: "The second line.", voiceId: nil, utteranceRate: 1))
        XCTAssertEqual(output.calls, ["start:1", "pause", "start:2"], "the second line is started, not held")
        narrator.narrate(.pause(seq: 2))
        XCTAssertEqual(output.calls.last, "pause", "the new line is live: a pause reaches the output")
        narrator.narrate(.resume(seq: 2))
        output.end(output.lastId)
        XCTAssertEqual(events.last, .finished(seq: 2))
    }

    /// The audition (a voice preview) shares the synthesizer with narration,
    /// and its end goes to `onFinish` ONLY: it is never a `NarratorEvent`, so
    /// no preview can advance a Foray past its narration. queue-manager.js
    /// "a preview's `finished` never advances past narration (mobile-native-2)".
    /// TO SEE IT FAIL: report the audition's end as `.finished(seq:)`.
    func testAPreviewsEndIsNeverANarrationEvent() {
        let narrator = makeNarrator()
        narrator.speak(text: "a preview", voiceId: nil)
        output.end(output.lastId)
        XCTAssertEqual(ends, [.finished])
        XCTAssertEqual(events, [], "a preview never reaches the core")
    }
}

import XCTest
import AVFAudio
import ForayEngineCore

/// The numbers the engine core copies from Apple's frameworks, checked against
/// the frameworks themselves (native engine plan, card NE-09).
///
/// The core is Foundation-only so it can host-test on macOS and Linux, which
/// means it cannot READ `AVSpeechUtteranceDefaultSpeechRate`: it holds 0.5 as
/// a generated constant (`UTTERANCE_DEFAULT_RATE` in player/playback-rate.js).
/// If Apple ever moved the scale, the core's `PlaybackRate.utteranceRate`
/// would silently keep narrating on the old one while ForayTtsPlugin (which
/// reads the framework) moved. This target links both the core and AVFAudio,
/// so it is where that assumption is pinned.
///
/// TO SEE IT FAIL: change UTTERANCE_DEFAULT_RATE in playback-rate.js to 0.6
/// and regenerate EngineConstants.swift.
final class EnginePolicyFrameworkTests: XCTestCase {
    func testTheCoresSpeechRateScaleIsAVFoundations() {
        XCTAssertEqual(PlaybackRate.utteranceMinRate, Double(AVSpeechUtteranceMinimumSpeechRate))
        XCTAssertEqual(PlaybackRate.utteranceDefaultRate, Double(AVSpeechUtteranceDefaultSpeechRate))
        XCTAssertEqual(PlaybackRate.utteranceMaxRate, Double(AVSpeechUtteranceMaximumSpeechRate))
    }

    /// 1x is ordinary speech on the device's own scale: the one point of the
    /// curve that is definitional rather than measured.
    func testNormalSpeedNarratesAtTheFrameworkDefault() {
        XCTAssertEqual(PlaybackRate.utteranceRate(playbackMultiplier: 1),
                       Double(AVSpeechUtteranceDefaultSpeechRate), accuracy: 1e-9)
    }
}

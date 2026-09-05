import XCTest
import AVFAudio
@testable import ForayTtsPlugin

/// Test target for the plugin, same shape @capacitor/app@8.1.1's own
/// AppPluginTests.swift ships (a `testTarget` Package.swift declares).
///
/// **NOTHING RUNS THIS.** No workflow in this repo invokes `swift test` on this
/// package — `.github/workflows/ios-build.yml`'s `ios-shell` job COMPILES this
/// plugin (transitively, via `cap add ios` folding `Package.swift` into the
/// generated project) and `ci.yml`'s `ios-kit` job tests a different package
/// entirely (`ios/ForayKit`). So treat the assertions below as executable
/// documentation that a founder or a future CI job can run, not as coverage
/// this repo has collected. `mobile/plugins/foray-tts/README.md` says the same
/// thing about this file, and it stays true.
final class ForayTtsPluginTests: XCTestCase {
    func testPluginTypeExists() {
        XCTAssertNotNil(ForayTtsPlugin.self)
    }

    /// The whole point of `utteranceRate(playbackMultiplier:)`: the player's
    /// DEFAULT speed of 1.0 must become ordinary speech, not the fastest rate
    /// the synthesiser has. Before the mapping existed, `utterance.rate` was
    /// assigned the multiplier directly and 1.0 meant
    /// `AVSpeechUtteranceMaximumSpeechRate`.
    ///
    /// TO SEE IT FAIL: change the body of `utteranceRate` to
    /// `return Float(multiplier)` — the old behaviour — and this assertion goes
    /// from 0.5 to 1.0.
    func testDefaultPlaybackSpeedIsOrdinarySpeech() {
        XCTAssertEqual(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: 1.0),
            AVSpeechUtteranceDefaultSpeechRate,
            accuracy: 0.0001
        )
    }

    /// The ladder in `player/playback-rate.js` tops out at 2.0 and bottoms at
    /// 0.75, so both ends must land inside the framework's range rather than
    /// relying on the framework to clamp them.
    func testLadderEndsStayInRange() {
        let fastest = ForayTtsPlugin.utteranceRate(playbackMultiplier: 2.0)
        let slowest = ForayTtsPlugin.utteranceRate(playbackMultiplier: 0.75)
        XCTAssertLessThanOrEqual(fastest, AVSpeechUtteranceMaximumSpeechRate)
        XCTAssertGreaterThanOrEqual(slowest, AVSpeechUtteranceMinimumSpeechRate)
        XCTAssertLessThan(slowest, AVSpeechUtteranceDefaultSpeechRate)
        XCTAssertGreaterThan(fastest, AVSpeechUtteranceDefaultSpeechRate)
    }

    /// A nonsense multiplier must not escape the range. `getDouble("rate")`
    /// takes whatever JSON the page sent.
    func testAbsurdMultipliersAreClamped() {
        XCTAssertEqual(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: 1000),
            AVSpeechUtteranceMaximumSpeechRate,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: -5),
            AVSpeechUtteranceMinimumSpeechRate,
            accuracy: 0.0001
        )
    }
}

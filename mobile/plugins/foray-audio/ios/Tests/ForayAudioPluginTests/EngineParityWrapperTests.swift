import XCTest
import ForayEngineCore
import ForayEngineParity

/// The Simulator-side THIN wrapper over `ForayEngineParity`
/// (docs/native-engine-plan.md §4.1 and §6.4): the same library
/// `foray-engine-core/Tests/ForayEngineCoreTests/ParityFamilyTests.swift` runs
/// on the host, run here inside `ci.yml`'s existing `xcodebuild test -scheme
/// ForayAudio` step. That is the zero-`.github` fallback: parity cases execute
/// in CI on every PR even before G-1a's `engine-parity` job exists, and they
/// execute against the core AS THE APP LINKS IT (iOS, through the plugin
/// package's nested path dependency), not only as a host build of it.
///
/// HOW IT FINDS THE FIXTURES WITH NO WORKFLOW CHANGE (NE-05). The runner
/// walks up from this file's `#filePath` to `player/parity/`: a Simulator test
/// process reads the host Mac's filesystem, so it reads the checkout the step
/// built from, in place. `TEST_RUNNER_FORAY_PARITY_DIR` (xcodebuild strips the
/// prefix) overrides the walk once a workflow wants to say where.
///
/// One method per family, one `XCTFail` per case; like its twin, it asserts
/// that nothing failed AND that something ran. Each family's line
/// (`parity family=seam-gap cases=30 ...`) is printed into the step's log.
final class EngineParityWrapperTests: XCTestCase {
    func testParitySmokeCasesPassOnTheSimulator() throws {
        let report = ParityRunner.run(try ParityRunner.smokeCases())
        XCTAssertEqual(report.failures, [], report.failures.map(\.detail).joined(separator: "\n"))
        XCTAssertEqual(report.executed, 2)
    }

    /// The stub `engineHello` answers from the core; the plugin copies this
    /// dictionary into its `JSObject` unchanged (`ForayAudioPlugin.engineHello`).
    func testTheStubHelloTheBridgeReturnsIsLegacyNotBuilt() {
        XCTAssertEqual(EngineHandshake.notBuiltHello(), ["mode": "legacy", "reason": "not-built"])
    }

    func testCompareFamily() { assertParityFamily("compare", requireRunner: true) }
    func testSeamGapFamily() { assertParityFamily("seam-gap", requireRunner: true) }
    /// NE-07s: the reducer runs at parity here too, as the app links it.
    func testQueueStateFamily() { assertParityFamily("queue-state", requireRunner: true) }
    /// NE-09's ports run here too, against the core as the app links it.
    func testRateFamily() { assertParityFamily("rate", requireRunner: true) }
    func testResumeRulesFamily() { assertParityFamily("resume-rules", requireRunner: true) }
    func testTransportFamily() { assertParityFamily("transport", requireRunner: true) }
    /// NE-10s: the shared rows as the app links them, byte for byte.
    func testRowsFamily() { assertParityFamily("rows", requireRunner: true) }
    func testNumberFormatFamily() { assertParityFamily("number-format", requireRunner: true) }
    func testDiagTokensFamily() { assertParityFamily("diag-tokens", requireRunner: true) }
    /// NE-12s: the lock screen and car rules as the app links them.
    func testMediaEpisodeFamily() { assertParityFamily("media-episode", requireRunner: true) }

    /// Recorded by NE-11j, ported by NE-11s: the audio session's policy and
    /// its audible-start invariant (`SessionPolicy`), the lane decision and
    /// its strike rules (`EngineMode`), and the web <-> native contract
    /// (`EngineContract`: the names, the decoding of every schema example,
    /// the page's handshake and extrapolation). Each must RUN here.
    func testSessionFamily() { assertParityFamily("session", requireRunner: true) }
    func testSessionInvariantFamily() { assertParityFamily("session-invariant", requireRunner: true) }
    func testEngineModeFamily() { assertParityFamily("engine-mode", requireRunner: true) }
    func testContractFamily() { assertParityFamily("contract", requireRunner: true) }
    func testSnapshotFamily() { assertParityFamily("snapshot", requireRunner: true) }
    func testHandshakeFamily() { assertParityFamily("handshake", requireRunner: true) }

    /// Recorded by NE-14j, ported by NE-14s: the deck's decisions
    /// (`DeckPolicy`) and the episode paths of the manager, driven through
    /// `EngineCore` by the scenario driver (which also checks the
    /// audible-start invariant on every turn). Each must RUN here.
    func testDeckEpisodeFamily() { assertParityFamily("deck-episode", requireRunner: true) }
    func testManagerEpisodeFamily() { assertParityFamily("manager-episode", requireRunner: true) }

    /// NE-28s: the Foray seam policies as the app links them.
    func testInterludeFamily() { assertParityFamily("interlude", requireRunner: true) }
    func testSeekPolicyFamily() { assertParityFamily("seek-policy", requireRunner: true) }
    func testOutpointFamily() { assertParityFamily("outpoint", requireRunner: true) }

    /// NE-29s: the Foray clock, resume rules, structural check and lock screen as the app links them.
    func testForayClockFamily() { assertParityFamily("foray-clock", requireRunner: true) }
    func testForayProgressFamily() { assertParityFamily("foray-progress", requireRunner: true) }
    func testForayStructureFamily() { assertParityFamily("foray-structure", requireRunner: true) }
    func testMediaFamily() { assertParityFamily("media", requireRunner: true) }

    /// NE-30s: the deck's guards, the Foray tape and the prepare seams as the app links them.
    func testDeckFamily() { assertParityFamily("deck", requireRunner: true) }
    func testManagerForayFamily() { assertParityFamily("manager-foray", requireRunner: true) }
    func testPrepareFamily() { assertParityFamily("prepare", requireRunner: true) }

    /// NE-33: the default voice, the lexicon and the speech rate as the app links them.
    func testDefaultVoiceFamily() { assertParityFamily("default-voice", requireRunner: true) }
    func testLexiconFamily() { assertParityFamily("lexicon", requireRunner: true) }
    func testSpeechRateFamily() { assertParityFamily("speech-rate", requireRunner: true) }

    /// Every family in manifest.json, including any recorded after this file
    /// was written: executed or owed, nothing stale, nothing dropped.
    func testEveryManifestFamilyIsExecutedOrPending() throws {
        let report = try SharedParityRun.report()
        for failure in report.failures {
            XCTFail("\(failure.id) [\(failure.outcome.rawValue)]: \(failure.detail)")
        }
        for problem in report.problems { XCTFail("parity: \(problem)") }
        XCTAssertGreaterThan(report.executed, 0, "the parity run executed no case at all")
        XCTAssertTrue(report.summary(for: "seam-gap")?.hasRunner ?? false)
    }
}

/// The per-family assertion, a copy of the one beside the host wrapper
/// (SwiftPM test targets cannot share sources across packages; everything
/// with logic in it is in the library, so this is only reporting).
func assertParityFamily(_ family: String, requireRunner: Bool = false,
                        file: StaticString = #filePath, line: UInt = #line) {
    let report: SuiteReport
    do {
        report = try SharedParityRun.report()
    } catch {
        XCTFail("the parity run could not start: \(error)", file: file, line: line)
        return
    }
    guard let summary = report.summary(for: family) else {
        XCTFail("family \(family) is not in player/parity/manifest.json", file: file, line: line)
        return
    }
    if requireRunner {
        XCTAssertTrue(summary.hasRunner, "family \(family) has no Swift runner registered", file: file, line: line)
        XCTAssertGreaterThan(summary.executed, 0, "family \(family) executed nothing", file: file, line: line)
    }
    for result in report.results(for: family) where result.outcome.isFailure {
        XCTFail("\(result.id) [\(result.outcome.rawValue)]: \(result.detail)", file: file, line: line)
    }
    for problem in report.problems(for: family) {
        XCTFail("parity: \(problem)", file: file, line: line)
    }
}

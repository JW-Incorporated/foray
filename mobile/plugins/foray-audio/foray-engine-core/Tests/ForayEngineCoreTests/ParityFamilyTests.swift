import XCTest
import ForayEngineCore
import ForayEngineParity

/// The host-side THIN wrapper over the parity runner (docs/native-engine-plan.md
/// §6.4, card NE-05): one method per fixture family, one `XCTFail` per case.
/// `swift test --package-path mobile/plugins/foray-audio/foray-engine-core`
/// runs it on macOS in `ci.yml`'s ios-kit today, and on Linux in G-1a's
/// `engine-parity` job once that exists (which also sets FORAY_PARITY_DIR and
/// PARITY_REPORT). Its twin, `ForayAudioPluginTests/EngineParityWrapperTests.swift`,
/// is the same wrapper inside `xcodebuild test -scheme ForayAudio`.
///
/// Nothing here decides anything: `ParitySuite` keeps the books and these
/// methods only report them. A family recorded by a JS card after this file
/// was written has no method yet, and is still checked, case by case, by
/// `testEveryManifestFamilyIsExecutedOrPending`.
final class ParityFamilyTests: XCTestCase {
    /// The comparator itself: if this family is red, no other family's
    /// verdict means anything, so it is listed first.
    func testCompareFamily() { assertParityFamily("compare", requireRunner: true) }

    /// NE-05's proof family: `SeamGap` against player/seam-gap.js.
    func testSeamGapFamily() { assertParityFamily("seam-gap", requireRunner: true) }

    /// Recorded by NE-07j, burned down by NE-07s: the reducer at parity with
    /// player/queue-state.js, so the family must now have a runner that ran.
    func testQueueStateFamily() { assertParityFamily("queue-state", requireRunner: true) }

    /// NE-09's ports, which must RUN (a runner registered, cases executed):
    /// `PlaybackRate` (the ladder and ForayTts's utteranceRate curve),
    /// `ResumeRules` (three JS modules, one runner) and `TransportPolicy`.
    func testRateFamily() { assertParityFamily("rate", requireRunner: true) }
    func testResumeRulesFamily() { assertParityFamily("resume-rules", requireRunner: true) }
    func testTransportFamily() { assertParityFamily("transport", requireRunner: true) }

    /// Recorded by NE-10j and NE-04, ported by NE-10s: the shared rows byte
    /// for byte (`Rows`, `JSWriter`) and exact token admission (`Vocabulary`).
    /// A runner is REQUIRED, so unregistering one is red here, not "owed".
    func testRowsFamily() { assertParityFamily("rows", requireRunner: true) }
    func testNumberFormatFamily() { assertParityFamily("number-format", requireRunner: true) }
    func testDiagTokensFamily() { assertParityFamily("diag-tokens", requireRunner: true) }

    /// NE-12s's port, which must RUN: `MediaMapping` against
    /// player/media-session.js and the media-actions adapter (NE-12j).
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

    /// Recorded by NE-28j, ported by NE-28s: the Foray seam policies. The
    /// jingle's rule and the silence node's cap (`Interlude`), ADR-0007's
    /// ladder, ADR-0008's pad and the ladder at load (`SeekPolicy`), and the
    /// native three-layer out-point with its windowed watchdog (`DeckPolicy`'s
    /// `outPointStep`, driven over a driven clock). Each must RUN here.
    func testInterludeFamily() { assertParityFamily("interlude", requireRunner: true) }
    func testSeekPolicyFamily() { assertParityFamily("seek-policy", requireRunner: true) }
    func testOutpointFamily() { assertParityFamily("outpoint", requireRunner: true) }

    /// Recorded by NE-29j, ported by NE-29s: the Foray clock (`ForayClock`),
    /// the Foray's resume rules and throttled row writer (ResumeRules' Foray
    /// half, `Rows`), J-4's structural check (`StructuralCheck`) and the
    /// Foray half of the lock screen (`MediaMapping`, and remote presses into
    /// `EngineCore`), over every committed Foray too. Each must RUN here.
    func testForayClockFamily() { assertParityFamily("foray-clock", requireRunner: true) }
    func testForayProgressFamily() { assertParityFamily("foray-progress", requireRunner: true) }
    func testForayStructureFamily() { assertParityFamily("foray-structure", requireRunner: true) }
    func testMediaFamily() { assertParityFamily("media", requireRunner: true) }

    /// Recorded by NE-30j, ported by NE-30s: the deck's guards and its
    /// single-deck slices (`DeckPolicy`; the pair's decisions stay NE-32's),
    /// the manager's Foray tape through `EngineCore` with the tape on, and
    /// the prepare family's audible seams through the contract. Each must RUN.
    func testDeckFamily() { assertParityFamily("deck", requireRunner: true) }
    func testManagerForayFamily() { assertParityFamily("manager-foray", requireRunner: true) }
    func testPrepareFamily() { assertParityFamily("prepare", requireRunner: true) }

    /// Ported by NE-33: the default voice (the Samantha ruling) and the
    /// pronunciation lexicon's matcher (`SpeechRules`), and what reaches the
    /// synthesiser (1x, the chosen voice) through `EngineCore`. Each must RUN.
    func testDefaultVoiceFamily() { assertParityFamily("default-voice", requireRunner: true) }
    func testLexiconFamily() { assertParityFamily("lexicon", requireRunner: true) }
    func testSpeechRateFamily() { assertParityFamily("speech-rate", requireRunner: true) }

    /// Every family in manifest.json, including ones no method above names:
    /// every id executed or owed, no stale pending entry, no whole-tree
    /// problem. And something must have RUN: zero failures from a runner that
    /// decoded nothing is not a pass.
    func testEveryManifestFamilyIsExecutedOrPending() throws {
        let report = try SharedParityRun.report()
        for failure in report.failures {
            XCTFail("\(failure.id) [\(failure.outcome.rawValue)]: \(failure.detail)")
        }
        for problem in report.problems { XCTFail("parity: \(problem)") }
        XCTAssertGreaterThan(report.executed, 0, "the parity run executed no case at all")
    }
}

/// The per-family assertion both wrappers share. Duplicated in the plugin's
/// test target on purpose: SwiftPM test targets cannot share sources across
/// packages, which is why everything with logic in it lives in the library.
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

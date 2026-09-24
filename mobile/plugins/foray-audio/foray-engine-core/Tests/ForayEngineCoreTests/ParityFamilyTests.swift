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

    /// Recorded by NE-07j, owed by NE-07s: every id must be pending until then.
    func testQueueStateFamily() { assertParityFamily("queue-state") }

    /// NE-09's ports, which must RUN (a runner registered, cases executed):
    /// `PlaybackRate` (the ladder and ForayTts's utteranceRate curve),
    /// `ResumeRules` (three JS modules, one runner) and `TransportPolicy`.
    func testRateFamily() { assertParityFamily("rate", requireRunner: true) }
    func testResumeRulesFamily() { assertParityFamily("resume-rules", requireRunner: true) }
    func testTransportFamily() { assertParityFamily("transport", requireRunner: true) }

    /// Recorded by NE-10j, owed by NE-10s.
    func testRowsFamily() { assertParityFamily("rows") }
    func testNumberFormatFamily() { assertParityFamily("number-format") }

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

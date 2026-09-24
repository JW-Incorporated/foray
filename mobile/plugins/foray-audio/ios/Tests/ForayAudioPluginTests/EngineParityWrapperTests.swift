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
    func testRateFamily() { assertParityFamily("rate") }
    func testRowsFamily() { assertParityFamily("rows") }
    func testNumberFormatFamily() { assertParityFamily("number-format") }

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

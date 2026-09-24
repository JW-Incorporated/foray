import XCTest
import ForayEngineCore
import ForayEngineParity

/// The Simulator-side THIN wrapper over `ForayEngineParity`
/// (docs/native-engine-plan.md §4.1 and §6.4): the same library
/// `foray-engine-core/Tests/ForayEngineCoreTests/ParityStubTests.swift` runs
/// on the host, run here inside `ci.yml`'s existing `xcodebuild test -scheme
/// ForayAudio` step. That is the zero-`.github` fallback: parity cases execute
/// in CI on every PR even before G-1a's `engine-parity` job exists, and they
/// execute against the core AS THE APP LINKS IT (iOS, through the plugin
/// package's nested path dependency), not only as a host build of it.
///
/// Like its twin, it asserts that nothing failed AND that something ran.
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
}

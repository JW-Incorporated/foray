import XCTest
@testable import ForayTtsPlugin

/// Placeholder test target, same shape @capacitor/app@8.1.1's own
/// AppPluginTests.swift ships (an empty XCTestCase satisfying the
/// `testTarget` Package.swift declares). This repo's CI has no macOS runner
/// today (`docs/ios-ci.md` covers what does run, `swift test` is not part of
/// it) -- see this plugin's README.md "What was NOT verified" section. This
/// file exists so `swift build`/`swift test` are at least SYNTACTICALLY valid
/// if a founder or a future CI job runs them, not because this suite has run
/// anywhere.
final class ForayTtsPluginTests: XCTestCase {
    func testPluginTypeExists() {
        XCTAssertNotNil(ForayTtsPlugin.self)
    }
}

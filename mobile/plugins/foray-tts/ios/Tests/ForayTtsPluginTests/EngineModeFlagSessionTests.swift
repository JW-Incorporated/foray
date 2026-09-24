import XCTest
import AVFAudio
@testable import ForayTtsPlugin

/// Card NE-16 (docs/native-engine-plan.md §4.4): foray-tts reads the native
/// engine's `sessionOwnedByEngine` through its byte-identical copy of
/// `EngineModeFlag.swift` (shell-invariants compares the two files), and its
/// one session site, `claimSession()`, is skipped while the engine owns the
/// session and runs again the moment the flag flips back to false.
///
/// The flag is written below EXACTLY as foray-audio's copy writes it (the
/// volatile domain `ai.jwlabs.foura.engine`, key `sessionOwnedByEngine`),
/// because this test target does not link foray-audio: the two plugins share
/// the process, not a module, and the domain is the whole contract.
///
/// Runs in ci.yml's ios-kit (`xcodebuild test -scheme ForayTts`) against the
/// Simulator's REAL shared AVAudioSession.
final class EngineModeFlagSessionTests: XCTestCase {
    private let domain = "ai.jwlabs.foura.engine"

    override func tearDown() {
        UserDefaults.standard.removeVolatileDomain(forName: domain)
        try? AVAudioSession.sharedInstance().setActive(false)
        super.tearDown()
    }

    /// What foray-audio's `decideOnce()` writes in native mode, this plugin
    /// reads. TO SEE IT FAIL: change the domain or the key in this copy only
    /// (the byte-identity pin in shell-invariants goes red too).
    func testTheTtsCopyReadsTheFlagForayAudioWrites() {
        UserDefaults.standard.removeVolatileDomain(forName: domain)
        XCTAssertFalse(EngineModeFlag.sessionOwnedByEngine, "absent is the legacy answer")
        UserDefaults.standard.setVolatileDomain(["sessionOwnedByEngine": true], forName: domain)
        XCTAssertTrue(EngineModeFlag.sessionOwnedByEngine)
        UserDefaults.standard.setVolatileDomain(["sessionOwnedByEngine": false], forName: domain)
        XCTAssertFalse(EngineModeFlag.sessionOwnedByEngine)
    }

    /// While the engine owns the session, speak()/resume()'s claim touches
    /// nothing (the category stays what it was); after the flag flips to
    /// false (a relinquish), the claim's `setCategory` runs: `.playback`,
    /// `.spokenAudio`, as in build 2026092327.
    /// TO SEE IT FAIL: drop the `guard` in `claimSession()` (the category
    /// changes while the engine owns it), or invert it.
    func testTheClaimIsSkippedWhileTheEngineOwnsTheSessionAndRunsAfterTheFlagFlips() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.ambient, mode: .default, options: [])

        UserDefaults.standard.setVolatileDomain(["sessionOwnedByEngine": true], forName: domain)
        XCTAssertFalse(ForayTtsPlugin.claimSession(session))
        XCTAssertEqual(session.category, .ambient, "foray-tts wrote the category while the engine owned the session")

        UserDefaults.standard.setVolatileDomain(["sessionOwnedByEngine": false], forName: domain)
        XCTAssertTrue(ForayTtsPlugin.claimSession(session))
        XCTAssertEqual(session.category, .playback)
        XCTAssertEqual(session.mode, .spokenAudio)
    }
}

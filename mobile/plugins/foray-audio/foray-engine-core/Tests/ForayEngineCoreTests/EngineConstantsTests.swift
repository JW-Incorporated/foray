import XCTest
import ForayEngineCore

/// The Swift half of NE-04's claim (docs/native-engine-plan.md §6.7). The
/// generated files' CONTENT is pinned on Windows by
/// `tools/parity/gen-constants.test.mjs` (stale file, duplicate names, both
/// drift tolerances); what only a Swift compiler can say is that the generated
/// text is valid Swift and means what the generator thinks it means. So these
/// read the generated values through the compiler, and never retype a JS
/// number: a rule change is JS, regenerate, and these stay green unedited.
final class EngineConstantsTests: XCTestCase {
    /// The acceptance's "both DRIFT_TOLERANCE_SEC values appear under distinct
    /// namespaces", on the compiled side: two different rules that share a JS
    /// name are two different Swift values.
    ///
    /// TO SEE IT FAIL: generate a flat file, or map foray-progress.js onto the
    /// SeekPolicy namespace (the generator refuses; hand-edit it past that).
    func testBothDriftTolerancesAreDistinctConstants() {
        XCTAssertNotEqual(EngineConstants.SeekPolicy.driftToleranceSec,
                          EngineConstants.ForayProgress.driftToleranceSec)
        XCTAssertNotEqual(EngineConstants.PositionStore.minResumeSec,
                          EngineConstants.ForayProgress.minResumeSec)
    }

    /// Every JS number is a Double, whatever its literal looked like:
    /// `SEAM_GAP_SEC = 2.0` must not become an Int that truncates a later 2.5.
    func testNumbersAreDoublesAndLaddersKeepTheirOrder() {
        let gap: Double = EngineConstants.SeamGap.seamGapSec
        XCTAssertGreaterThan(gap, 0)
        let rates = EngineConstants.PlaybackRate.rates
        XCTAssertEqual(rates.first, EngineConstants.PlaybackRate.minRate)
        XCTAssertEqual(rates.last, EngineConstants.PlaybackRate.maxRate)
        XCTAssertEqual(rates, rates.sorted())
        XCTAssertTrue(rates.contains(EngineConstants.PlaybackRate.defaultRate))
    }

    /// The engine's shared rows and the Swift store must name the same keys:
    /// `cp_last_episode` is both an owned prefix and episode-progress's KEY,
    /// and every Foray row starts with foray-progress's KEY_PREFIX.
    func testOwnedPrefixesAgreeWithTheModulesThatWriteThoseRows() {
        let owned = EngineConstants.EngineContract.ownedPrefixes
        XCTAssertTrue(owned.contains(EngineConstants.EpisodeProgress.key))
        XCTAssertTrue(owned.contains(EngineConstants.ForayProgress.keyPrefix))
    }

    /// Keyword-named cases compile and keep their token: `default` is Apple's
    /// interruption reason and a Swift keyword, `override` a mode reason and a
    /// contextual one.
    func testKeywordNamedTokensKeepTheirSpelling() {
        XCTAssertEqual(Vocabulary.InterruptionReason.default.rawValue, "default")
        XCTAssertEqual(Vocabulary.ModeReason.override.rawValue, "override")
        XCTAssertEqual(Vocabulary.StopCause(rawValue: "grace-expired"), .graceExpired)
        XCTAssertNil(Vocabulary.StopCause(rawValue: "graceExpired"), "the case name is not the token")
    }

    /// `sets` is keyed by `setNames`, and each entry is its enum's cases in
    /// declaration order, which is what the diag-tokens family's reads record.
    func testSetsAreTheEnumsInOrder() {
        XCTAssertEqual(Set(Vocabulary.sets.keys), Set(Vocabulary.setNames))
        XCTAssertEqual(Vocabulary.setNames.count, 7)
        XCTAssertEqual(Vocabulary.sets["interruptionReason"],
                       ["default", "appWasSuspended", "builtInMicMuted", "unknown"])
        XCTAssertEqual(Vocabulary.sets["faultKind"], Vocabulary.FaultKind.allCases.map(\.rawValue))
    }

    /// The stub hello's reason (NE-01) is a token a mode row may carry.
    func testTheStubHelloReasonIsAModeReason() {
        XCTAssertEqual(Vocabulary.ModeReason(rawValue: EngineHandshake.notBuiltReason), .notBuilt)
    }
}

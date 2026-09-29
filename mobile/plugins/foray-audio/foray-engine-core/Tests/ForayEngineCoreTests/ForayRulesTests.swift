import XCTest
import ForayEngineCore

/// NE-29s's pins beside the parity families (which are the contract): the
/// values these ports read from the generated constants, and the few
/// invariants a reader of the Swift should be able to see without a fixture.
final class ForayRulesTests: XCTestCase {
    /// OQ-6 (plan §9a): a jingle counts the asset's measured length on the
    /// Foray clock, the same number the interlude plays for.
    func testJingleCountsItsMeasuredLength() {
        XCTAssertEqual(ForayClock.jingleDurationSec, Interlude.durationSec)
        let jingle = ForayItem(id: "j", kind: ForayClock.jingle, durationSec: ForayClock.jingleDurationSec)
        XCTAssertEqual(ForayClock.itemRuntimeSec(jingle), Interlude.durationSec)
    }

    /// Narration is never free: no duration and no script is the fallback, not 0.
    func testNarrationIsNeverFree() {
        let silent = ForayItem(id: "n", kind: "tts")
        XCTAssertEqual(ForayClock.narrationDuration(silent).sec, ForayClock.narrationFallbackSec)
        XCTAssertEqual(ForayClock.narrationDuration(silent).source, ForayClock.durationFallback)
        XCTAssertGreaterThan(ForayClock.narrationFallbackSec, 0)
    }

    /// The drift verdicts are the generated tokens, in the JS module's order.
    func testDriftTokensAreTheGeneratedOnes() {
        XCTAssertEqual(ResumeRules.ForayDrift.allCases.map(\.rawValue), ResumeRules.ForayDrift.tokens)
    }

    /// A clock landing exactly on a boundary is the NEXT item; past the end is
    /// the last one, never nothing.
    func testSegmentAtElapsedClampsAtBothEnds() {
        let items: [ForayItem?] = [ForayItem(id: "a", kind: "episode", startSec: 100, endSec: 210),
                                   ForayItem(id: "n", kind: "tts", durationSec: 8)]
        XCTAssertEqual(ForayClock.segmentAtElapsed(items, elapsed: 110)?.index, 1)
        XCTAssertEqual(ForayClock.segmentAtElapsed(items, elapsed: 10_000)?.index, 1)
        XCTAssertEqual(ForayClock.segmentAtElapsed(items, elapsed: -5)?.index, 0)
        XCTAssertNil(ForayClock.segmentAtElapsed([], elapsed: 1))
    }

    /// J-4: nothing is an empty refusal; a segment with no out-point is refused.
    func testStructuralCheckRefusesWithEveryProblemNamed() {
        let empty = StructuralCheck.check([])
        XCTAssertFalse(empty.ok)
        XCTAssertEqual(empty.reason, StructuralCheck.refusedStructure)
        XCTAssertEqual(empty.problems, [StructuralCheck.Problem(index: -1, code: "empty")])
        let open = StructuralCheck.check([ForayItem(id: "s", kind: "episode", audioUrl: "https://a.test/a.mp3", startSec: 100)])
        XCTAssertEqual(open.problems.map(\.code), ["bad-bounds"])
        for problem in open.problems { XCTAssertTrue(StructuralCheck.problemCodes.contains(problem.code)) }
    }

    /// The throttle is on the CLOCK and per Foray; a refused write is counted
    /// and does not move it.
    func testWriteThrottleCountsRefusals() {
        var throttle = ResumeRules.ForayWriteThrottle()
        let p = Rows.ForayProgressInput(forayId: "f", elapsedSec: 30, totalSec: 600)
        XCTAssertNotNil(throttle.due(p, force: false, updatedAt: "2026-08-16T10:00:00.000Z"))
        throttle.recorded(forayId: "f", elapsedSec: 30, ok: false)
        XCTAssertEqual(throttle.refusedWrites, 1)
        XCTAssertNotNil(throttle.due(p, force: false, updatedAt: "2026-08-16T10:00:00.000Z"), "a refused write leaves the next one due")
        throttle.recorded(forayId: "f", elapsedSec: 30, ok: true)
        let tick = Rows.ForayProgressInput(forayId: "f", elapsedSec: 31, totalSec: 600)
        XCTAssertNil(throttle.due(tick, force: false, updatedAt: "2026-08-16T10:00:00.000Z"))
        XCTAssertNotNil(throttle.due(tick, force: true, updatedAt: "2026-08-16T10:00:00.000Z"))
    }

    /// A Foray whose anchor segment moved resumes at the same audio, not the
    /// same clock reading.
    func testMovedAnchorResumesAtTheSameAudio() {
        let row = ResumeRules.ForayRow(forayId: "f", elapsedSec: 220, totalSec: 540, index: 2, segmentId: "s3", intoSec: 40)
        let live: [ResumeRules.LiveSegment?] = [ResumeRules.LiveSegment(id: "s1", startSec: 0, durationSec: 90),
                                                ResumeRules.LiveSegment(id: "s3", startSec: 90, durationSec: 90)]
        let point = ResumeRules.forayResumePoint(row, totalSec: 540, segments: live)
        XCTAssertEqual(point?.drift, .moved)
        XCTAssertEqual(point?.elapsedSec, 130)
        XCTAssertEqual(point?.index, 1)
    }
}

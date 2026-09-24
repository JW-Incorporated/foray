import XCTest

/// Pins the pure rules NE-25a's numbers are computed with (`ClickRuler.swift`),
/// against synthetic buffers whose truth is known exactly. The measurement
/// test only reports; these are what make its reports mean something.
final class ClickRulerTests: XCTestCase {
    private let rate = 8000.0

    /// A buffer of silence with one-cycle 1 kHz clicks (peak 0.8, like the
    /// generator's) at the given sample offsets.
    private func buffer(count: Int, clicksAt offsets: [Int]) -> [Float] {
        var out = [Float](repeating: 0, count: count)
        for start in offsets {
            for k in 0..<8 where start + k < count {
                out[start + k] = 0.8 * Float(sin(2 * Double.pi * 1000 * Double(k) / rate))
            }
        }
        return out
    }

    /// TO SEE IT FAIL: make the detector report the sample where the level
    /// PEAKS rather than where it first crosses the threshold, or drop the
    /// `startSec` from the time; either moves the onset.
    func testAnOnsetIsTheFirstSampleOverThresholdOnTheBelievedTimeline() {
        var detector = ClickDetector()
        detector.consume(buffer(count: 800, clicksAt: [400]), sampleRate: rate, startSec: 12.0)
        XCTAssertEqual(detector.events.count, 1)
        /* One cycle of 1 kHz at 8 kHz: sample 1 is 0.8 * sin(pi/4) = 0.57, the
           first over 0.25. So the onset is ONE sample (0.125 ms) after the
           authored click: the detector's whole bias, stated. */
        XCTAssertEqual(detector.events[0].believedSec, 12.0 + 401 / rate, accuracy: 1e-9)
        XCTAssertEqual(detector.events[0].peak, 0.8, accuracy: 0.01)
    }

    /// A click that straddles two buffers is one onset, at the right time.
    /// TO SEE IT FAIL: reset `lastOnsetSec` at every `consume`.
    func testAClickSplitAcrossTwoBuffersIsOneOnset() {
        var detector = ClickDetector()
        let whole = buffer(count: 1600, clicksAt: [797])
        detector.consume(Array(whole[0..<800]), sampleRate: rate, startSec: 3.0)
        detector.consume(Array(whole[800..<1600]), sampleRate: rate, startSec: 3.1)
        XCTAssertEqual(detector.events.map(\.believedSec), [3.0 + 798 / rate])
        XCTAssertEqual(detector.discontinuities, 0)
    }

    /// The double click's second onset is 50 ms later: outside the refractory
    /// window, so it is its own event; the click's own negative half-cycle is
    /// inside it, so it is not.
    /// TO SEE IT FAIL: set `refractorySec` to 0 (four onsets) or to 0.06 (one).
    func testTheRefractoryWindowSplitsADoubleButNotAClicksOwnCycle() {
        var detector = ClickDetector()
        detector.consume(buffer(count: 2000, clicksAt: [100, 500]), sampleRate: rate, startSec: 0)
        XCTAssertEqual(detector.events.count, 2)
        XCTAssertEqual(detector.events[1].believedSec - detector.events[0].believedSec, 0.05, accuracy: 1e-9)
    }

    /// A seek moves the buffer timeline backwards. Without a reset, the
    /// refractory test (`t - lastOnset >= window`) is negative and the first
    /// click after the seek vanishes, which would read as a late landing.
    /// TO SEE IT FAIL: delete the `lastOnsetSec = -Double.infinity` on a
    /// discontinuity.
    func testAJumpInTheTimelineIsCountedAndCannotHideTheNextClick() {
        var detector = ClickDetector()
        detector.consume(buffer(count: 800, clicksAt: [700]), sampleRate: rate, startSec: 40.0)
        detector.consume(buffer(count: 800, clicksAt: [4]), sampleRate: rate, startSec: 20.0)
        XCTAssertEqual(detector.discontinuities, 1)
        XCTAssertEqual(detector.events.count, 2)
        XCTAssertEqual(detector.events[1].believedSec, 20.0 + 5 / rate, accuracy: 1e-9)
    }

    /// TO SEE IT FAIL: pair onsets at any gap under the tolerance, or never pair.
    func testGroupingPairsOnlyOnsetsTheDoubleGapApart() {
        let events = [9.0, 10.0, 10.05, 11.0, 11.2].map { ClickEvent(believedSec: $0, peak: 0.8) }
        XCTAssertEqual(
            ClickRuler.group(events, doubleGapSec: 0.05),
            [
                RulerClick(believedSec: 9.0, isDouble: false),
                RulerClick(believedSec: 10.0, isDouble: true),
                RulerClick(believedSec: 11.0, isDouble: false),
                RulerClick(believedSec: 11.2, isDouble: false),
            ]
        )
    }

    /// The core of the landing measurement. An approximate seek that believes
    /// it is at 29.65 s but is really 1.3 s further on sees the double click
    /// that is TRULY at 30 s when it believes it is at 28.7 s.
    /// TO SEE IT FAIL: return `truth - believed` (the sign), or forget the
    /// content offset d0.
    func testTheBeliefErrorIsReadFromTheDoubleClickAndCarriesItsSign() throws {
        let d0 = 0.069
        let clicks = [
            RulerClick(believedSec: 27.7 + d0, isDouble: false),
            RulerClick(believedSec: 28.7 + d0, isDouble: true),
            RulerClick(believedSec: 29.7 + d0, isDouble: false),
        ]
        let early = try XCTUnwrap(ClickRuler.beliefError(clicks, fromBelievedSec: 27.0, contentOffsetSec: d0, doubleEverySec: 10))
        XCTAssertEqual(early.errorSec, -1.3, accuracy: 1e-9)
        XCTAssertFalse(early.ambiguous)

        let exact = try XCTUnwrap(ClickRuler.beliefError(
            [RulerClick(believedSec: 50 + d0, isDouble: true)],
            fromBelievedSec: 49.65, contentOffsetSec: d0, doubleEverySec: 10))
        XCTAssertEqual(exact.errorSec, 0, accuracy: 1e-9)
    }

    /// Past 4 s of error the nearest ten-second mark may be the wrong one; the
    /// number is still reported, flagged, never silently trusted.
    /// TO SEE IT FAIL: drop the `ambiguous` test.
    func testAnErrorNearHalfADoublePeriodIsFlaggedAmbiguous() throws {
        let result = try XCTUnwrap(ClickRuler.beliefError(
            [RulerClick(believedSec: 34.5, isDouble: true)],
            fromBelievedSec: 30, contentOffsetSec: 0, doubleEverySec: 10))
        XCTAssertEqual(result.errorSec, -5.5 + 10, accuracy: 1e-9)
        XCTAssertTrue(result.ambiguous)
        XCTAssertNil(ClickRuler.beliefError(
            [RulerClick(believedSec: 20, isDouble: true)],
            fromBelievedSec: 21, contentOffsetSec: 0, doubleEverySec: 10),
            "a double click before the landing is not evidence about the landing")
    }

    /// TO SEE IT FAIL: take `errorSec` out with the wrong sign.
    func testTheResidualIsTheWorstClickDistanceFromItsWholeSecond() {
        let clicks = [
            RulerClick(believedSec: 31.3, isDouble: true),
            RulerClick(believedSec: 32.302, isDouble: false),
            RulerClick(believedSec: 33.299, isDouble: false),
        ]
        XCTAssertEqual(
            ClickRuler.residualSec(clicks, fromBelievedSec: 31, errorSec: 1.3, contentOffsetSec: 0),
            0.002, accuracy: 1e-9)
    }
}

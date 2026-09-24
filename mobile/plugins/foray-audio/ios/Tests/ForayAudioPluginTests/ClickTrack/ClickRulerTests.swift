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
    func testAnOnsetIsTheFirstSampleOverThresholdAndCarriesItsRun() {
        var detector = ClickDetector()
        detector.consume(buffer(count: 800, clicksAt: [400]), sampleRate: rate, startSec: 12.0, run: 3)
        XCTAssertEqual(detector.events.count, 1)
        /* One cycle of 1 kHz at 8 kHz: sample 1 is 0.8 * sin(pi/4) = 0.57, the
           first over 0.25. So the onset is ONE sample (0.125 ms) after the
           authored click: the detector's whole bias, stated. */
        XCTAssertEqual(detector.events[0].countedSec, 12.0 + 401 / rate, accuracy: 1e-9)
        XCTAssertEqual(detector.events[0].peak, 0.8, accuracy: 0.01)
        XCTAssertEqual(detector.events[0].run, 3)
    }

    /// A click that straddles two buffers is one onset, at the right time.
    /// TO SEE IT FAIL: reset `lastOnsetSec` at every `consume`.
    func testAClickSplitAcrossTwoBuffersIsOneOnset() {
        var detector = ClickDetector()
        let whole = buffer(count: 1600, clicksAt: [797])
        detector.consume(Array(whole[0..<800]), sampleRate: rate, startSec: 3.0)
        detector.consume(Array(whole[800..<1600]), sampleRate: rate, startSec: 3.1)
        XCTAssertEqual(detector.events.map(\.countedSec), [3.0 + 798 / rate])
        XCTAssertEqual(detector.discontinuities, 0)
    }

    /// The double click's second onset is 50 ms later: outside the refractory
    /// window, so it is its own event; the click's own negative half-cycle is
    /// inside it, so it is not.
    /// TO SEE IT FAIL: set `refractorySec` to 0 (many onsets) or to 0.06 (one).
    func testTheRefractoryWindowSplitsADoubleButNotAClicksOwnCycle() {
        var detector = ClickDetector()
        detector.consume(buffer(count: 2000, clicksAt: [100, 500]), sampleRate: rate, startSec: 0)
        XCTAssertEqual(detector.events.count, 2)
        XCTAssertEqual(detector.events[1].countedSec - detector.events[0].countedSec, 0.05, accuracy: 1e-9)
    }

    /// A seek moves the timeline backwards. Without a reset, the refractory test
    /// (`t - lastOnset >= window`) is negative and the first click after the
    /// seek vanishes, which would read as a late landing.
    /// TO SEE IT FAIL: delete the `lastOnsetSec = -Double.infinity` on a
    /// discontinuity.
    func testAJumpInTheTimelineIsCountedAndCannotHideTheNextClick() {
        var detector = ClickDetector()
        detector.consume(buffer(count: 800, clicksAt: [700]), sampleRate: rate, startSec: 40.0)
        detector.consume(buffer(count: 800, clicksAt: [4]), sampleRate: rate, startSec: 20.0)
        XCTAssertEqual(detector.discontinuities, 1)
        XCTAssertEqual(detector.events.count, 2)
        XCTAssertEqual(detector.events[1].countedSec, 20.0 + 5 / rate, accuracy: 1e-9)
    }

    /// TO SEE IT FAIL: pair onsets at any gap under the tolerance, never pair,
    /// or pair across runs (two runs that both start at an in-point can put
    /// onsets 50 ms apart that are not one double click).
    func testGroupingPairsOnlyOnsetsTheDoubleGapApartInOneRun() {
        let events = [(9.0, 0), (10.0, 0), (10.05, 0), (11.0, 0), (11.2, 0), (12.0, 0), (12.05, 1)]
            .map { ClickEvent(countedSec: $0.0, peak: 0.8, run: $0.1) }
        XCTAssertEqual(
            ClickRuler.group(events, doubleGapSec: 0.05),
            [
                RulerClick(countedSec: 9.0, isDouble: false),
                RulerClick(countedSec: 10.0, isDouble: true),
                RulerClick(countedSec: 11.0, isDouble: false),
                RulerClick(countedSec: 11.2, isDouble: false),
                RulerClick(countedSec: 12.0, isDouble: false),
                RulerClick(countedSec: 12.05, isDouble: false, run: 1),
            ]
        )
    }

    /// THE CORE OF THE LANDING MEASUREMENT. An approximate seek to 49.65 s whose
    /// run label says 49.65 but which really began 0.4 s earlier: the double
    /// click authored at 50 s arrives 0.75 s (of counted frames) into the run.
    /// The label only picks the mark; the frame count places the run.
    /// TO SEE IT FAIL: use the label as the start (`runAnchorSec`), drop the
    /// delay, or subtract the offset with the wrong sign.
    func testARunIsPlacedByFramesCountedToTheDoubleClickNotByItsLabel() {
        let delay = 0.0428
        /* Counted time is anchor + frames: 49.65 + 0.75 = 50.4 (+ delay). */
        let start = ClickRuler.runStart(
            doubleCountedSec: 49.65 + 0.75 + delay, runAnchorSec: 49.65, delaySec: delay, doubleEverySec: 10)
        XCTAssertEqual(start.markSec, 50)
        XCTAssertEqual(start.offsetInRunSec, 0.75 + delay, accuracy: 1e-9)
        XCTAssertEqual(start.startSec, 49.25, accuracy: 1e-9, "the listener starts 0.4 s EARLY")
        XCTAssertFalse(start.ambiguous)
    }

    /// Past 4 s from any mark, the nearest ten-second mark may be the wrong one;
    /// the number is still reported, flagged, never silently trusted.
    /// TO SEE IT FAIL: drop the `ambiguous` test.
    func testAReadingNearHalfADoublePeriodIsFlaggedAmbiguous() {
        let start = ClickRuler.runStart(doubleCountedSec: 34.6, runAnchorSec: 34.0, delaySec: 0, doubleEverySec: 10)
        XCTAssertEqual(start.markSec, 30)
        XCTAssertTrue(start.ambiguous)
        XCTAssertFalse(ClickRuler.runStart(doubleCountedSec: 30.4, runAnchorSec: 30.0, delaySec: 0, doubleEverySec: 10).ambiguous)
    }

    /// TO SEE IT FAIL: measure the delay from the label (`firstClickCountedSec`
    /// alone) or forget the authored first click.
    func testTheDelayIsCountedFromTheStreamsFirstSample() {
        XCTAssertEqual(
            ClickRuler.delay(firstClickCountedSec: 0.003 + 1.0428, runAnchorSec: 0.003, firstClickSec: 1),
            0.0428, accuracy: 1e-9)
    }

    /// TO SEE IT FAIL: use another run's clicks, or place clicks by label.
    func testTheResidualIsTheWorstClickDistanceFromItsWholeSecondInTheRun() {
        let start = ClickRuler.RunStart(startSec: 49.25, markSec: 50, offsetInRunSec: 0.75, ambiguous: false)
        let clicks = [
            RulerClick(countedSec: 49.65 + 0.75, isDouble: true, run: 1),
            RulerClick(countedSec: 49.65 + 1.752, isDouble: false, run: 1),
            RulerClick(countedSec: 49.65 + 2.749, isDouble: false, run: 1),
            RulerClick(countedSec: 3.5, isDouble: false, run: 0),
        ]
        XCTAssertEqual(
            ClickRuler.residualSec(clicks, run: 1, runAnchorSec: 49.65, start: start, delaySec: 0),
            0.002, accuracy: 1e-9)
    }
}

/// Pins `BufferTimeline`: counted time, not labelled time, inside a run.
final class BufferTimelineTests: XCTestCase {
    /// TO SEE IT FAIL: return `labelSec` as the start (the first run's method):
    /// the jittered labels come straight through.
    func testJitteredLabelsAreCountedThroughAndTheirDriftIsKept() {
        var timeline = BufferTimeline()
        let rate = 16000.0
        let labels = [10.0, 10.0645, 10.1270, 10.1935]  // 1024-frame buffers are 64 ms; labels jitter
        let starts = labels.compactMap { timeline.place(labelSec: $0, frames: 1024, sampleRate: rate) }
        XCTAssertEqual(starts.count, 4)
        for (got, want) in zip(starts, [10.0, 10.064, 10.128, 10.192]) {
            XCTAssertEqual(got, want, accuracy: 1e-9)
        }
        XCTAssertEqual(timeline.runs, 1)
        XCTAssertEqual(timeline.maxAbsDriftSec, 0.0015, accuracy: 1e-9)
    }

    /// A seek is a jump no jitter explains: a new run, anchored at its label.
    /// TO SEE IT FAIL: never start a second run (the count carries on from the
    /// old position), or start one on every drift.
    func testASeekStartsANewRunAtItsLabel() {
        var timeline = BufferTimeline()
        _ = timeline.place(labelSec: 0.0, frames: 1600, sampleRate: 16000)
        XCTAssertEqual(timeline.place(labelSec: 49.65, frames: 1600, sampleRate: 16000) ?? -1, 49.65, accuracy: 1e-9)
        XCTAssertEqual(timeline.place(labelSec: 49.7505, frames: 1600, sampleRate: 16000) ?? -1, 49.75, accuracy: 1e-9)
        XCTAssertEqual(timeline.runAnchors, [0.0, 49.65])
        XCTAssertEqual(timeline.currentRun, 1)
    }

    /// A buffer with no valid label is still counted, once a run exists.
    /// TO SEE IT FAIL: return nil whenever the label is nil.
    func testAMissingLabelIsCountedFromTheRun() {
        var timeline = BufferTimeline()
        XCTAssertNil(timeline.place(labelSec: nil, frames: 800, sampleRate: 8000))
        _ = timeline.place(labelSec: 5.0, frames: 800, sampleRate: 8000)
        XCTAssertEqual(timeline.place(labelSec: nil, frames: 800, sampleRate: 8000) ?? -1, 5.1, accuracy: 1e-9)
    }
}

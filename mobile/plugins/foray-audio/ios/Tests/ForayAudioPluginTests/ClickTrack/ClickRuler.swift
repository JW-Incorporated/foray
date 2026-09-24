import Foundation

/// The pure half of NE-25a's measurement (docs/native-engine-plan.md, card
/// NE-25a): placing tap buffers on a timeline, finding clicks in them, and
/// reading the click track's ruler. Nothing here touches AVFoundation, so
/// `ClickRulerTests` pins every rule against synthetic buffers, and a wrong rule
/// shows up there rather than as a plausible-looking number in the doc.
///
/// HOW A LANDING IS READ, WITHOUT TRUSTING ANY LABEL.
/// Each tap buffer carries a `timeRange` label saying where AVFoundation thinks
/// it is. Runs 35962279894 and 35963652605 showed those labels jitter by up to
/// ~11 ms against the samples they carry, so no measured number depends on one:
///   1. A seek starts a new RUN of contiguous buffers (`BufferTimeline`).
///      Inside a run, time is counted in frames from the run's first sample.
///   2. The first double click after the landing is at a whole ten seconds of
///      CONTENT. Frames counted from the run's first sample to that click say
///      exactly how far before it the run began.
///   3. So the run's first sample, the first sample the listener hears, sits
///      at `mark + delay - offsetInRun` of the file's decoded timeline, where
///      `delay` is where the decoder puts content (an MP3's encoder delay;
///      ~0 for the WAV), counted the same way from the stream's very first
///      sample when played from zero.
/// Labels are used only to tell runs apart and to pick WHICH ten-second mark
/// (nearest), which tolerates any error under 5 s.

/// One onset: where it was counted to (`countedSec`, on its run's timeline),
/// how loud it came out (a codec that smears the click shows up as a lower
/// peak), and which run it was in.
struct ClickEvent: Equatable {
    var countedSec: Double
    var peak: Float
    var run = 0
}

/// Finds click onsets in a stream of buffers, carrying state across buffer
/// boundaries (a click can straddle two).
struct ClickDetector {
    /// Well above an 8-bit WAV's quantisation and an MP3's pre-echo, well below
    /// the 0.8 peak the generator writes. A codec that lost more than
    /// two-thirds of a click's peak would show as missing clicks, not as an
    /// early one.
    var threshold: Float = 0.25
    /// Longer than a click's ringing after a low-bitrate MP3 (a few ms), shorter
    /// than the double click's 50 ms gap, so the second click of a double is its
    /// own onset and the ringing of either is not.
    var refractorySec: Double = 0.015
    /// How long after an onset the peak is still attributed to it.
    var peakWindowSec: Double = 0.005

    private(set) var events: [ClickEvent] = []
    /// Times the timeline jumped (a new run). Counted, and the refractory state
    /// is dropped so a jump backwards cannot hide a click.
    private(set) var discontinuities = 0
    private var lastOnsetSec = -Double.infinity
    private var expectedNextStartSec: Double?

    init() {}

    init(threshold: Float, refractorySec: Double) {
        self.threshold = threshold
        self.refractorySec = refractorySec
    }

    mutating func consume(_ samples: [Float], sampleRate: Double, startSec: Double, run: Int = 0) {
        guard sampleRate > 0, !samples.isEmpty else { return }
        let slack = 1.5 / sampleRate
        if let expected = expectedNextStartSec, abs(startSec - expected) > slack {
            discontinuities += 1
            lastOnsetSec = -Double.infinity
        }
        for (i, sample) in samples.enumerated() {
            let t = startSec + Double(i) / sampleRate
            let level = abs(sample)
            if level >= threshold, t - lastOnsetSec >= refractorySec {
                events.append(ClickEvent(countedSec: t, peak: level, run: run))
                lastOnsetSec = t
            } else if level > 0, !events.isEmpty, t - lastOnsetSec <= peakWindowSec,
                      level > events[events.count - 1].peak {
                events[events.count - 1].peak = level
            }
        }
        expectedNextStartSec = startSec + Double(samples.count) / sampleRate
    }
}

/// A click after grouping: a double click is reported once, at its first onset.
struct RulerClick: Equatable {
    var countedSec: Double
    var isDouble: Bool
    var run = 0
}

enum ClickRuler {
    /// Pairs onsets `doubleGapSec` apart (within `toleranceSec`) in the same run
    /// into one double click; every other onset is a single click.
    static func group(_ events: [ClickEvent], doubleGapSec: Double, toleranceSec: Double = 0.010) -> [RulerClick] {
        var out: [RulerClick] = []
        var i = 0
        while i < events.count {
            let e = events[i]
            if i + 1 < events.count, events[i + 1].run == e.run,
               abs(events[i + 1].countedSec - e.countedSec - doubleGapSec) <= toleranceSec {
                out.append(RulerClick(countedSec: e.countedSec, isDouble: true, run: e.run))
                i += 2
            } else {
                out.append(RulerClick(countedSec: e.countedSec, isDouble: false, run: e.run))
                i += 1
            }
        }
        return out
    }

    /// A run's first sample, located in the file's decoded timeline.
    struct RunStart: Equatable {
        /// Where the run's first sample really is (decoded timeline, seconds).
        var startSec: Double
        /// The ten-second content mark the double click was read as.
        var markSec: Double
        /// The run's first sample was this far before the double click.
        var offsetInRunSec: Double
        /// True when the label-based guess of WHICH mark is within a second of
        /// being the other one (an error near 5 s): reported, never trusted.
        var ambiguous: Bool
    }

    /// Step 3 of the method above. `doubleCountedSec` is the double click's
    /// counted time and `runAnchorSec` its run's first-sample label, so
    /// `offsetInRun` is a pure frame count; the label enters only through the
    /// choice of the nearest mark.
    static func runStart(
        doubleCountedSec: Double,
        runAnchorSec: Double,
        delaySec: Double,
        doubleEverySec: Double
    ) -> RunStart {
        let offset = doubleCountedSec - runAnchorSec
        let guess = (doubleCountedSec - delaySec) / doubleEverySec
        let mark = guess.rounded() * doubleEverySec
        let distance = abs(guess - guess.rounded()) * doubleEverySec
        return RunStart(
            startSec: mark + delaySec - offset,
            markSec: mark,
            offsetInRunSec: offset,
            ambiguous: distance > 0.4 * doubleEverySec)
    }

    /// The decoder's delay: where the first click (authored at `firstClickSec`)
    /// lands, counted from the stream's first sample when played from zero.
    static func delay(firstClickCountedSec: Double, runAnchorSec: Double, firstClickSec: Double) -> Double {
        (firstClickCountedSec - runAnchorSec) - firstClickSec
    }

    /// Worst distance, in seconds, of any click of the run from the whole second
    /// of content it should sit on, given the run's located start. Small means
    /// the reading is self-consistent; large means the detector is seeing
    /// something other than the ruler (a lost or doubled click).
    static func residualSec(_ clicks: [RulerClick], run: Int, runAnchorSec: Double, start: RunStart, delaySec: Double) -> Double {
        clicks
            .filter { $0.run == run }
            .map { click -> Double in
                let content = start.startSec + (click.countedSec - runAnchorSec) - delaySec
                return abs(content - content.rounded())
            }
            .max() ?? 0
    }
}

/// Places each tap buffer on the timeline by COUNTING frames from the start of
/// a contiguous run, not by trusting each buffer's own label.
///
/// WHY. Run 35963652605 showed the per-buffer `timeRange` labels jitter by a few
/// milliseconds against the samples: a double click's 50 ms gap read 45 ms, and
/// one click's ringing read as two onsets 7.5 ms apart because the label jumped
/// between them. The working assumption is that the samples are contiguous and
/// the labels approximate, so a run is anchored at its first label and counted
/// from there, and a new run starts only on a jump no jitter explains (a seek,
/// a flush). The label's drift from the count is kept and reported, and the
/// WAV control checks the assumption end to end: its measured delay must come
/// out at the detector's own bias (one sample).
struct BufferTimeline {
    /// A label further than this from where counting says the buffer starts is
    /// a new run. Label jitter measured in run 35964966803 peaked at 11.5 ms; the
    /// smallest real jump the tests make is a seek of seconds.
    var jumpSec = 0.1
    /// The label each run started at, in order; a run's index is its position.
    private(set) var runAnchors: [Double] = []
    private(set) var maxAbsDriftSec = 0.0
    private var framesInRun = 0

    init() {}

    var runs: Int { runAnchors.count }
    /// The index of the run the last placed buffer belongs to.
    var currentRun: Int { max(0, runAnchors.count - 1) }

    /// The counted start of a buffer of `frames` frames whose label is
    /// `labelSec` (nil when the tap gave no valid range), or nil when there is
    /// nothing to count from yet.
    mutating func place(labelSec: Double?, frames: Int, sampleRate: Double) -> Double? {
        guard sampleRate > 0 else { return nil }
        if let label = labelSec {
            if let anchor = runAnchors.last {
                let counted = anchor + Double(framesInRun) / sampleRate
                let drift = label - counted
                if abs(drift) > jumpSec {
                    startRun(at: label)
                } else {
                    maxAbsDriftSec = max(maxAbsDriftSec, abs(drift))
                }
            } else {
                startRun(at: label)
            }
        }
        guard let anchor = runAnchors.last else { return nil }
        let start = anchor + Double(framesInRun) / sampleRate
        framesInRun += frames
        return start
    }

    private mutating func startRun(at label: Double) {
        runAnchors.append(label)
        framesInRun = 0
    }
}

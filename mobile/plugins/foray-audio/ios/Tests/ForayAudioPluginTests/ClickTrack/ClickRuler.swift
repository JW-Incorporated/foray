import Foundation

/// The pure half of NE-25a's measurement (docs/native-engine-plan.md, card
/// NE-25a): finding clicks in rendered audio and reading the click track's
/// ruler. Nothing here touches AVFoundation, so `ClickRulerTests` pins every
/// rule against synthetic buffers, and a wrong rule shows up there rather than
/// as a plausible-looking number in the measurements doc.
///
/// THE TWO TIMELINES. `believedSec` is where AVFoundation says a sample is: the
/// tap's `timeRange.start` plus the sample's offset in the buffer. The click
/// track's CONTENT says where it really is: a double click is always at a
/// multiple of ten seconds. For a precise seek on a local file the two agree;
/// for an approximate seek into a VBR MP3 with no TOC they need not, and the
/// difference is exactly the landing error the engine would play with.

/// One onset: where AVFoundation believed it was, and how loud it came out
/// (a codec that smears the click shows up here as a lower peak).
struct ClickEvent: Equatable {
    var believedSec: Double
    var peak: Float
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
    /// Times the buffer timeline jumped (a seek, a flush). Counted, and the
    /// refractory state is dropped so a jump backwards cannot hide a click.
    private(set) var discontinuities = 0
    private var lastOnsetSec = -Double.infinity
    private var expectedNextStartSec: Double?

    init() {}

    init(threshold: Float, refractorySec: Double) {
        self.threshold = threshold
        self.refractorySec = refractorySec
    }

    mutating func consume(_ samples: [Float], sampleRate: Double, startSec: Double) {
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
                events.append(ClickEvent(believedSec: t, peak: level))
                lastOnsetSec = t
            } else if level > 0, !events.isEmpty, t - lastOnsetSec <= peakWindowSec,
                      level > events[events.count - 1].peak {
                events[events.count - 1].peak = level
            }
        }
        expectedNextStartSec = startSec + Double(samples.count) / sampleRate
    }

    mutating func removeEvents() {
        events.removeAll()
    }
}

/// A click after grouping: a double click is reported once, at its first onset.
struct RulerClick: Equatable {
    var believedSec: Double
    var isDouble: Bool
}

enum ClickRuler {
    /// Pairs onsets `doubleGapSec` apart (within `toleranceSec`) into one double
    /// click; every other onset is a single click.
    static func group(_ events: [ClickEvent], doubleGapSec: Double, toleranceSec: Double = 0.010) -> [RulerClick] {
        var out: [RulerClick] = []
        var i = 0
        while i < events.count {
            let t = events[i].believedSec
            if i + 1 < events.count, abs(events[i + 1].believedSec - t - doubleGapSec) <= toleranceSec {
                out.append(RulerClick(believedSec: t, isDouble: true))
                i += 2
            } else {
                out.append(RulerClick(believedSec: t, isDouble: false))
                i += 1
            }
        }
        return out
    }

    /// What the content says about the belief: `believed - true`, in seconds,
    /// read from the first double click at or after `fromBelievedSec`.
    ///
    /// `contentOffsetSec` (d0) is where the file's decoded timeline puts its
    /// content: a click authored at `n` s plays at `n + d0` when the file is
    /// played from zero (an MP3's encoder delay; 0 for the WAV). The double
    /// click's true stream time is `10k + d0` for the k nearest the belief, so
    /// the answer is only unambiguous while the belief is within half a double
    /// period (5 s) of the truth; `ambiguous` says when it is too close to call.
    static func beliefError(
        _ clicks: [RulerClick],
        fromBelievedSec: Double,
        contentOffsetSec: Double,
        doubleEverySec: Double
    ) -> (errorSec: Double, doubleBelievedSec: Double, ambiguous: Bool)? {
        guard let double = clicks.first(where: { $0.isDouble && $0.believedSec >= fromBelievedSec }) else {
            return nil
        }
        let content = double.believedSec - contentOffsetSec
        let mark = (content / doubleEverySec).rounded() * doubleEverySec
        let error = double.believedSec - (mark + contentOffsetSec)
        return (error, double.believedSec, abs(error) > 0.4 * doubleEverySec)
    }

    /// Worst distance, in seconds, of any click after `fromBelievedSec` from the
    /// whole second the ruler says it should sit on, once `errorSec` is taken
    /// out. Small means the identification is self-consistent; a large residual
    /// means the detector is seeing something other than the ruler.
    static func residualSec(
        _ clicks: [RulerClick],
        fromBelievedSec: Double,
        errorSec: Double,
        contentOffsetSec: Double
    ) -> Double {
        clicks
            .filter { $0.believedSec >= fromBelievedSec }
            .map { click -> Double in
                let content = click.believedSec - errorSec - contentOffsetSec
                return abs(content - content.rounded())
            }
            .max() ?? 0
    }
}

/// Places each tap buffer on the timeline by COUNTING frames from the start of
/// a contiguous run, not by trusting each buffer's own label.
///
/// WHY. Run 35963652605 showed the per-buffer `timeRange` labels jitter by a few
/// milliseconds against the samples they carry: one CBR click read 1.2 ms off
/// its neighbours, a double click's 50 ms gap read 45 ms, and a single click's
/// ringing came out as two onsets 7.5 ms apart because the label jumped between
/// them. The working assumption is that the samples are contiguous and the
/// labels approximate, so a run is anchored at its first label and counted from
/// there, and a new run starts only on a jump no jitter explains (a seek, a
/// flush). The label's drift from the count is kept and reported, which is
/// what checks the assumption: a drift that grew with time would mean the
/// count, not the label, is wrong.
struct BufferTimeline {
    /// A label further than this from where counting says the buffer starts is
    /// a new run. Jitter measured in run 35963652605 was a few ms; the
    /// smallest real jump the tests make is a seek of seconds.
    var jumpSec = 0.1
    private(set) var runs = 0
    private(set) var maxAbsDriftSec = 0.0
    private var anchorSec: Double?
    private var framesInRun = 0

    init() {}

    /// The counted start of a buffer of `frames` frames whose label is
    /// `labelSec` (nil when the tap gave no valid range), or nil when there is
    /// nothing to count from yet.
    mutating func place(labelSec: Double?, frames: Int, sampleRate: Double) -> Double? {
        guard sampleRate > 0 else { return nil }
        if let label = labelSec {
            if let anchor = anchorSec {
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
        guard let anchor = anchorSec else { return nil }
        let start = anchor + Double(framesInRun) / sampleRate
        framesInRun += frames
        return start
    }

    private mutating func startRun(at label: Double) {
        anchorSec = label
        framesInRun = 0
        runs += 1
    }
}

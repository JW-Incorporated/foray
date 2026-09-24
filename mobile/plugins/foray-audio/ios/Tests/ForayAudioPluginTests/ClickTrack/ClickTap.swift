import AVFoundation
import MediaToolbox

/// The MTAudioProcessingTap NE-25a listens through (docs/native-engine-plan.md,
/// card NE-25a): it sees every buffer the player renders from the item, with the
/// source time range AVFoundation assigns it, places the buffer on the timeline
/// (`BufferTimeline`: counted from the run's first label) and feeds it to a
/// `ClickDetector`. It changes nothing: the audio passes through untouched.
///
/// WHY A TAP AND NOT A TIMER. The question is what was RENDERED, and where
/// AVFoundation thought it was when it rendered it. `currentTime` answers only
/// the second half. The tap answers both, per buffer.
///
/// WHAT IT CANNOT SEE. The tap runs where the render pipeline PULLS audio, which
/// is ahead of the speaker by the output latency. So "the last buffer the tap
/// processed" is an upper bound on what was heard, not the heard edge itself.
/// The measurements doc reports it as `pulledEndSec` and never as overshoot.
final class ClickTapRecorder {
    struct Snapshot {
        var events: [ClickEvent]
        var discontinuities: Int
        var buffers: Int
        var invalidRanges: Int
        var unsupportedFormat: Bool
        var sampleRate: Double
        var firstPulledSec: Double?
        var pulledEndSec: Double?
        /// Contiguous runs the timeline saw (a seek starts one), and the worst
        /// distance between a buffer's label and where counting put it.
        var runAnchors: [Double]
        var maxLabelDriftSec: Double
        var format: String
    }

    private let lock = NSLock()
    private var detector = ClickDetector()
    private var timeline = BufferTimeline()
    private var format = "not prepared"
    private var sampleRate = 0.0
    private var isFloat = true
    private var isInterleaved = false
    private var channels = 1
    private var bytesPerSample = 4
    private var unsupportedFormat = false
    private var buffers = 0
    private var invalidRanges = 0
    private var firstPulledSec: Double?
    private var pulledEndSec: Double?

    func prepare(_ format: AudioStreamBasicDescription) {
        lock.lock(); defer { lock.unlock() }
        sampleRate = format.mSampleRate
        isFloat = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
        isInterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        channels = max(1, Int(format.mChannelsPerFrame))
        bytesPerSample = Int(format.mBitsPerChannel / 8)
        unsupportedFormat = format.mFormatID != kAudioFormatLinearPCM
            || !((isFloat && bytesPerSample == 4) || (!isFloat && bytesPerSample == 2))
        let kind: String = isFloat ? "float" : "int"
        let layout: String = isInterleaved ? "interleaved" : "non-interleaved"
        self.format = "\(Int(format.mSampleRate)) Hz, \(channels) ch, \(format.mBitsPerChannel)-bit \(kind), \(layout)"
    }

    func process(_ list: UnsafeMutablePointer<AudioBufferList>, frames: Int, range: CMTimeRange) {
        let buffersList = UnsafeMutableAudioBufferListPointer(list)
        guard frames > 0, let first = buffersList.first, let data = first.mData else { return }
        lock.lock(); defer { lock.unlock() }
        buffers += 1
        guard !unsupportedFormat, sampleRate > 0 else { return }
        let label: Double? = range.start.isValid && range.start.isNumeric ? range.start.seconds : nil
        if label == nil { invalidRanges += 1 }
        guard let start = timeline.place(labelSec: label, frames: frames, sampleRate: sampleRate) else { return }
        /* Channel 0 only: the fixtures are mono, and a mono file rendered
           through a stereo path carries the same samples on both channels. */
        let stride = isInterleaved ? channels : 1
        var samples = [Float](repeating: 0, count: frames)
        if isFloat {
            let p = data.assumingMemoryBound(to: Float.self)
            for i in 0..<frames { samples[i] = p[i * stride] }
        } else {
            let p = data.assumingMemoryBound(to: Int16.self)
            for i in 0..<frames { samples[i] = Float(p[i * stride]) / 32768 }
        }
        if firstPulledSec == nil { firstPulledSec = start }
        let end = start + Double(frames) / sampleRate
        pulledEndSec = max(pulledEndSec ?? end, end)
        detector.consume(samples, sampleRate: sampleRate, startSec: start, run: timeline.currentRun)
    }

    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(
            events: detector.events,
            discontinuities: detector.discontinuities,
            buffers: buffers,
            invalidRanges: invalidRanges,
            unsupportedFormat: unsupportedFormat,
            sampleRate: sampleRate,
            firstPulledSec: firstPulledSec,
            pulledEndSec: pulledEndSec,
            runAnchors: timeline.runAnchors,
            maxLabelDriftSec: timeline.maxAbsDriftSec,
            format: format
        )
    }
}

private func recorder(of tap: MTAudioProcessingTap) -> ClickTapRecorder {
    Unmanaged<ClickTapRecorder>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
}

/* The callbacks are C function pointers, so they capture nothing: the recorder
   travels as the tap's storage, retained at creation and released in finalize. */
private let tapInit: MTAudioProcessingTapInitCallback = { _, clientInfo, tapStorageOut in
    tapStorageOut.pointee = clientInfo
}

private let tapFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
    Unmanaged<ClickTapRecorder>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
}

private let tapPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
    recorder(of: tap).prepare(format.pointee)
}

private let tapUnprepare: MTAudioProcessingTapUnprepareCallback = { _ in }

private let tapProcess: MTAudioProcessingTapProcessCallback = { tap, numberFrames, _, bufferListInOut, numberFramesOut, flagsOut in
    var range = CMTimeRange.invalid
    let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, &range, numberFramesOut)
    guard status == noErr else { return }
    recorder(of: tap).process(bufferListInOut, frames: Int(numberFramesOut.pointee), range: range)
}

enum ClickTap {
    struct CreationFailed: Error { let status: OSStatus }

    /// An audio mix that routes `track` through a tap feeding `recorder`.
    static func audioMix(for track: AVAssetTrack, recorder: ClickTapRecorder) throws -> AVAudioMix {
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(recorder).toOpaque()),
            init: tapInit,
            finalize: tapFinalize,
            prepare: tapPrepare,
            unprepare: tapUnprepare,
            process: tapProcess)
        var tap: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap)
        guard status == noErr, let tap else {
            Unmanaged.passUnretained(recorder).release()
            throw CreationFailed(status: status)
        }
        let parameters = AVMutableAudioMixInputParameters(track: track)
        parameters.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [parameters]
        return mix
    }
}

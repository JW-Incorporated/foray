import AVFoundation

/* NE-25a's measuring rig (docs/native-engine-plan.md, card NE-25a). It is
   deliberately NOT the engine's AVDeck (NE-15): it exists to measure the
   AVFoundation behaviour AVDeck and DeckPair will be built on, so it follows
   the plan's load pipeline (§4.3) step for step and times each step, and it
   carries no policy of its own.

   EVERYTHING RUNS ON THE MAIN THREAD. XCTest calls a synchronous test on main;
   AVFoundation delivers KVO, completion handlers, boundary observers and the
   watchdog's timer on main (queue: .main); `spin` turns the main run loop until
   a condition holds. One thread means no actor annotations and no races between
   a layer firing and the test reading what it recorded. */

func nowMs() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
}

/// Turns the main run loop (which also drains the main dispatch queue) until
/// `condition` holds or `timeoutSec` passes. Returns whether it held.
@discardableResult
func spin(timeoutSec: Double, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeoutSec)
    while !condition() {
        if Date() >= deadline { return condition() }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.001))
    }
    return true
}

/// A mutable cell a completion handler can write through. AVFoundation's
/// handlers are `@Sendable` in current SDKs, and a `@Sendable` closure may not
/// mutate a captured `var`; it may mutate a class instance it captured. Every
/// write happens on main (the handlers hop there), so there is no race.
final class Cell<Value> {
    var value: Value
    init(_ value: Value) { self.value = value }
}

func cmTime(_ seconds: Double) -> CMTime {
    CMTime(seconds: seconds, preferredTimescale: 1_000_000)
}

final class MeasuredDeck {
    /// The plan's "time to ready" (§4.3 steps 1-7), split so each cost is
    /// visible. `assetMs` covers creating the asset and loading its duration
    /// and tracks (the tap needs the track); `readyMs` waiting for both
    /// statuses; `seekMs` the zero-tolerance seek; `prerollMs` the preroll.
    struct LoadTiming: Encodable {
        var assetMs = 0.0
        var readyMs = 0.0
        var seekMs = 0.0
        var prerollMs = 0.0
        var totalMs = 0.0
        var seekFinished = true
        var prerollFinished = false
        var durationSec = 0.0
    }

    enum LoadError: Error, CustomStringConvertible {
        case assetFailed(String)
        case noAudioTrack
        case notReady(String)
        case timedOut(String)

        var description: String {
            switch self {
            case .assetFailed(let why): return "asset failed to load: \(why)"
            case .noAudioTrack: return "no audio track"
            case .notReady(let why): return "item never became ready: \(why)"
            case .timedOut(let step): return "timed out waiting for \(step)"
            }
        }
    }

    let player = AVPlayer()
    let recorder = ClickTapRecorder()
    private(set) var item: AVPlayerItem?

    init() {
        /* The plan's deck settings (§4.3). */
        player.actionAtItemEnd = .pause
        player.automaticallyWaitsToMinimizeStalling = true
    }

    /// Steps 1-7 of the plan's load pipeline, readiness-gated: preroll is only
    /// ever issued after both statuses are `.readyToPlay` and while the rate is
    /// 0 (a preroll before readiness raises an uncatchable exception).
    func load(_ url: URL, precise: Bool, seekToSec: Double?, rate: Float) throws -> LoadTiming {
        var timing = LoadTiming()
        let t0 = nowMs()
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: precise])
        let loaded = Cell(false)
        asset.loadValuesAsynchronously(forKeys: ["duration", "tracks"]) {
            DispatchQueue.main.async { loaded.value = true }
        }
        guard spin(timeoutSec: 30, until: { loaded.value }) else { throw LoadError.timedOut("duration and tracks") }
        for key in ["duration", "tracks"] {
            var error: NSError?
            if asset.statusOfValue(forKey: key, error: &error) != .loaded {
                throw LoadError.assetFailed("\(key): \(error?.localizedDescription ?? "not loaded")")
            }
        }
        timing.durationSec = asset.duration.seconds
        guard let track = asset.tracks(withMediaType: .audio).first else { throw LoadError.noAudioTrack }

        let item = AVPlayerItem(asset: asset)
        item.audioTimePitchAlgorithm = .timeDomain
        item.audioMix = try ClickTap.audioMix(for: track, recorder: recorder)
        self.item = item
        let t1 = nowMs()
        timing.assetMs = t1 - t0

        player.replaceCurrentItem(with: item)
        let ready = spin(timeoutSec: 30) {
            item.status == .failed || (player.status == .readyToPlay && item.status == .readyToPlay)
        }
        guard ready, item.status == .readyToPlay, player.status == .readyToPlay else {
            throw LoadError.notReady(item.error?.localizedDescription ?? "status \(item.status.rawValue)")
        }
        let t2 = nowMs()
        timing.readyMs = t2 - t1

        if let target = seekToSec {
            let finished = Cell<Bool?>(nil)
            player.seek(to: cmTime(target), toleranceBefore: .zero, toleranceAfter: .zero) { ok in
                DispatchQueue.main.async { finished.value = ok }
            }
            guard spin(timeoutSec: 30, until: { finished.value != nil }) else { throw LoadError.timedOut("seek") }
            timing.seekFinished = finished.value ?? false
        }
        let t3 = nowMs()
        timing.seekMs = t3 - t2

        if player.rate == 0 {
            let finished = Cell<Bool?>(nil)
            player.preroll(atRate: rate) { ok in
                DispatchQueue.main.async { finished.value = ok }
            }
            guard spin(timeoutSec: 30, until: { finished.value != nil }) else { throw LoadError.timedOut("preroll") }
            timing.prerollFinished = finished.value ?? false
        }
        let t4 = nowMs()
        timing.prerollMs = t4 - t3
        timing.totalMs = t4 - t0
        return timing
    }

    /// Where the player believes it is, in seconds.
    var currentSec: Double { player.currentTime().seconds }

    func tearDown() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        item = nil
    }

    /// For a report when something did not happen: what the player was doing.
    func stateDescription() -> String {
        let snapshot = recorder.snapshot()
        let waiting: String = player.reasonForWaitingToPlay?.rawValue ?? "-"
        let itemError: String = item?.error?.localizedDescription ?? "-"
        let parts: [String] = [
            "timeControlStatus=\(player.timeControlStatus.rawValue)",
            "waiting=\(waiting)",
            "rate=\(player.rate)",
            "t=\(String(format: "%.3f", currentSec))",
            "itemError=\(itemError)",
            "tapBuffers=\(snapshot.buffers)",
            "invalidRanges=\(snapshot.invalidRanges)",
            "unsupportedFormat=\(snapshot.unsupportedFormat)",
            "tapRate=\(snapshot.sampleRate)",
            "events=\(snapshot.events.count)",
        ]
        return parts.joined(separator: " ")
    }
}

/// Who fired, where the player believed it was, and when; first one wins.
final class FireLog {
    struct Fire: Encodable {
        let layer: String
        let mediaSec: Double
        let hostMs: Double
    }

    private(set) var fires: [Fire] = []

    /// Records a layer's fire; true when it is the first.
    @discardableResult
    func record(_ layer: String, mediaSec: Double) -> Bool {
        fires.append(Fire(layer: layer, mediaSec: mediaSec, hostMs: nowMs()))
        return fires.count == 1
    }
}

/// The plan's third out-point layer (§4.3): one timer at
/// `(end - currentTime) / rate - lead`, then a 250 ms poll only inside the last
/// window, so a 51-minute Foray costs a few wakeups rather than ~12,000.
final class WindowedWatchdog {
    let leadSec: Double
    let pollSec: Double
    private(set) var armDelaySec = 0.0
    private(set) var ticks = 0
    private var timer: DispatchSourceTimer?

    init(leadSec: Double = 1.5, pollSec: Double = 0.25) {
        self.leadSec = leadSec
        self.pollSec = pollSec
    }

    func arm(player: AVPlayer, endSec: Double, rate: Double, onFire: @escaping (Double) -> Void) {
        cancel()
        armDelaySec = max(0, (endSec - player.currentTime().seconds) / rate - leadSec)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + armDelaySec, repeating: pollSec, leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self, weak player] in
            guard let self, let player else { return }
            self.ticks += 1
            let t = player.currentTime().seconds
            if t >= endSec {
                self.cancel()
                onFire(t)
            }
        }
        self.timer = timer
        timer.resume()
    }

    func cancel() {
        timer?.cancel()
        timer = nil
    }
}

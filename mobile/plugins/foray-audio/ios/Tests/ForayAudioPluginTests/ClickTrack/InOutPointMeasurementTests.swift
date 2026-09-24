import AVFoundation
import XCTest

/// NE-25a (docs/native-engine-plan.md §4.3 and card NE-25a): measure, on the
/// Simulator, where AVFoundation really lands an in-point and how far past an
/// out-point it really stops, against click tracks whose content is a ruler
/// (`tools/audio/make-click-tracks.py`).
///
/// THESE TESTS MEASURE; THEY ASSERT ONLY ONE-SIDED RULES. A Simulator is not a
/// phone and a local file is not a CDN, so no number here is a pass mark
/// (DV-5 repeats the measurement on real CDNs in M2). What IS asserted:
///   - every trial produced a measurement (a silent rig is a failure, not a
///     skip: it would otherwise publish an empty table as a result);
///   - NEVER EARLY: no out-point layer fires, and the player never settles,
///     before the out-point. An early stop cuts content the listener was
///     promised; a late one plays a little of the next thing. The plan's
///     out-point is "never early" (P-2), and this is where that is first
///     checked against the real AVFoundation.
/// Everything else is reported to the job summary and `NE-25a-json` log lines
/// (`MeasurementReport`), and copied into docs/ios-native-engine-measurements.md
/// with the run id.
final class InOutPointMeasurementTests: XCTestCase {
    /// Each is 0.35 s before a double click, so a landing within [-9.65, +0.35] s
    /// of the request hears that double click within a second. WAV (60 s) uses
    /// the ones that fit.
    static let inPointsSec = [9.65, 19.65, 49.65, 79.65]
    /// 5 ms after a whole-second click, inside the WAV's 60 s too.
    static let outPointSec = 55.005
    /// Playback starts this long before the out-point: past the watchdog's 1.5 s
    /// lead at both rates, so its one-shot timer is armed for real.
    static let leadInSec = 4.0
    static let rates: [Float] = [1.0, 2.0]

    /// The pad NE-32 adds to `forwardPlaybackEndTime` (`end + stopPad`). Zero
    /// until a measured early stop says otherwise; card NE-25a: "if an early stop
    /// is measured, the doc records it and NE-32's stopPad is set from it".
    static let stopPadSec = 0.0
    /// One millisecond of slack for CMTime rounding on top of the pad, and no
    /// more: `tools/audio/click-tracks.test.mjs` pins both numbers, so loosening
    /// the rule is an edit somebody has to make in two places, on purpose.
    static let neverEarlyToleranceSec = 0.001 + stopPadSec

    enum Layer: String, CaseIterable, Encodable {
        case forwardEnd = "forwardPlaybackEndTime"
        case boundary = "boundaryObserver"
        case watchdog = "windowedWatchdog"
    }

    static let layerSets: [[Layer]] = [[.forwardEnd], [.boundary], [.watchdog], Layer.allCases]

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    // MARK: - (1) in-point landing error and time to ready

    struct InPointTrial: Encodable {
        let fixture: String
        let mode: String
        let requestedSec: Double
        let timing: MeasuredDeck.LoadTiming
        /// What AVFoundation reports after the seek (it reports the request).
        let currentTimeAfterSeekSec: Double
        let delaySec: Double
        /// The label of the landing run's first buffer: where AVFoundation said
        /// the first sample the listener hears was.
        let runLabelSec: Double?
        /// Where that first sample really was (ClickRuler.runStart).
        let runStartSec: Double?
        /// runStart - requested: positive = the listener starts LATE (misses the
        /// start of the segment), negative = EARLY (hears what precedes it).
        let landingErrorSec: Double?
        let markSec: Double?
        let ambiguous: Bool
        let residualSec: Double?
        let clicksHeard: Int
        let minPeak: Float?
        /// The landing run's first onsets, [seconds into the run, peak], so a
        /// weak or missing click after a seek can be read back from the log.
        let firstEvents: [[Double]]
        let discontinuities: Int
        let invalidRanges: Int
        let tapFormat: String
        let runAnchors: [Double]
        let maxLabelDriftSec: Double
        let state: String
    }

    func testInPointLandingErrorAndTimeToReadyPreciseVsApproximate() throws {
        let descriptor = try ClickTrackDescriptor.load()
        var rows: [[String]] = []
        var delays: [String] = []
        var tapFormats: Set<String> = []
        var worstDriftSec = 0.0
        for fixture in descriptor.fixtures {
            let url = try descriptor.url(of: fixture)
            /* THE DECODER'S DELAY, counted from the stream's first sample
               (ClickRuler.swift, step 3). For the WAV it must come out at the
               detector's one-sample bias (0.125 ms): that is the end-to-end
               check that counting frames is right. For an MP3 it is the encoder
               delay as AVFoundation's decoder presents it. */
            let delay = try streamDelay(url, descriptor: descriptor)
            delays.append("\(fixture.file): delay \(ms(delay.delaySec)) ms from the stream's first sample "
                + "(that run's first label: \(ms(delay.runLabelSec)) ms)")
            guard let delaySec = delay.delaySec else {
                XCTFail("\(fixture.file): no click heard playing from zero: \(delay.state)")
                continue
            }

            for precise in [true, false] {
                for requested in Self.inPointsSec where requested + 2 < fixture.durationSec {
                    let trial = try measureInPoint(
                        url, fixture: fixture.file, precise: precise, requestedSec: requested,
                        delaySec: delaySec, descriptor: descriptor)
                    MeasurementReport.json(trial)
                    tapFormats.insert(trial.tapFormat)
                    worstDriftSec = max(worstDriftSec, trial.maxLabelDriftSec)
                    XCTAssertNotNil(trial.landingErrorSec,
                        "\(fixture.file) \(trial.mode) @\(requested): no landing measured: \(trial.state)")
                    let landing: String = ms(trial.landingErrorSec) + (trial.ambiguous ? " (ambiguous)" : "")
                    let label: Double? = trial.runLabelSec.map { $0 - requested }
                    let finished: String = "\(trial.timing.seekFinished)/\(trial.timing.prerollFinished)"
                    var row: [String] = [fixture.file, trial.mode, String(format: "%.2f", requested), landing]
                    row.append(ms(label))
                    row.append(ms(trial.currentTimeAfterSeekSec - requested))
                    row.append(msValue(trial.timing.totalMs))
                    row.append(msValue(trial.timing.assetMs))
                    row.append(msValue(trial.timing.readyMs))
                    row.append(msValue(trial.timing.seekMs))
                    row.append(msValue(trial.timing.prerollMs))
                    row.append(finished)
                    row.append(ms(trial.residualSec))
                    rows.append(row)
                }
            }
        }
        MeasurementReport.table(
            title: "NE-25a (1): in-point landing error and time to ready",
            columns: ["fixture", "timing", "in-point s", "landing error ms (first sample heard - in-point)",
                      "first buffer's label - in-point ms", "currentTime - in-point ms",
                      "ready total ms", "asset ms", "ready ms", "seek ms", "preroll ms",
                      "seek/preroll finished", "ruler residual ms"],
            rows: rows,
            notes: delays + [
                "Seeks are zero-tolerance; 'precise' is AVURLAssetPreferPreciseDurationAndTimingKey=true.",
                "Landing error: where the first sample the listener hears really is, minus the in-point. It is COUNTED in frames back from the first double click after the landing (a whole ten seconds of content) and the file's decoder delay; no buffer label enters it. Positive = the listener starts late, negative = early (they hear audio from before the in-point).",
                "Tap format: \(tapFormats.sorted().joined(separator: "; ")). Worst label-vs-count drift in any trial: \(ms(worstDriftSec)) ms.",
                "Local files on a Simulator: DV-5 repeats this on real CDNs in M2.",
            ])
    }

    /// Plays from zero and counts, from the stream's first sample, to the first
    /// click (authored at `firstClickSec`).
    private func streamDelay(_ url: URL, descriptor: ClickTrackDescriptor) throws -> (delaySec: Double?, runLabelSec: Double?, state: String) {
        let deck = MeasuredDeck()
        defer { deck.tearDown() }
        _ = try deck.load(url, precise: true, seekToSec: nil, rate: 1)
        deck.player.playImmediately(atRate: 1)
        let first: () -> (event: ClickEvent, anchor: Double)? = {
            let snapshot = deck.recorder.snapshot()
            for event in snapshot.events where snapshot.runAnchors.indices.contains(event.run) {
                let anchor = snapshot.runAnchors[event.run]
                if event.countedSec - anchor >= descriptor.firstClickSec - 0.5 { return (event, anchor) }
            }
            return nil
        }
        spin(timeoutSec: descriptor.firstClickSec + 3) { first() != nil }
        deck.player.pause()
        guard let found = first() else { return (nil, nil, deck.stateDescription()) }
        let delay = ClickRuler.delay(
            firstClickCountedSec: found.event.countedSec, runAnchorSec: found.anchor, firstClickSec: descriptor.firstClickSec)
        return (abs(delay) < 0.5 ? delay : nil, found.anchor, deck.stateDescription())
    }

    private func measureInPoint(
        _ url: URL, fixture: String, precise: Bool, requestedSec: Double,
        delaySec: Double, descriptor: ClickTrackDescriptor
    ) throws -> InPointTrial {
        let deck = MeasuredDeck()
        defer { deck.tearDown() }
        let timing = try deck.load(url, precise: precise, seekToSec: requestedSec, rate: 1)
        let afterSeek = deck.currentSec
        /* The landing run is one that STARTED near where AVFoundation believes
           it landed; a run pulled from 0 before the seek is not evidence. */
        let landingDouble: () -> (click: RulerClick, anchor: Double)? = {
            let snapshot = deck.recorder.snapshot()
            let clicks = ClickRuler.group(snapshot.events, doubleGapSec: descriptor.doubleGapSec)
            for click in clicks where click.isDouble && snapshot.runAnchors.indices.contains(click.run) {
                let anchor = snapshot.runAnchors[click.run]
                if abs(anchor - afterSeek) < 1.0 { return (click, anchor) }
            }
            return nil
        }
        deck.player.playImmediately(atRate: 1)
        spin(timeoutSec: descriptor.doubleEverySec + 2) { landingDouble() != nil }
        /* A little more, so the residual has single clicks after the double. */
        spin(timeoutSec: 1.2) { false }
        deck.player.pause()

        let snapshot = deck.recorder.snapshot()
        let clicks = ClickRuler.group(snapshot.events, doubleGapSec: descriptor.doubleGapSec)
        let found = landingDouble()
        let start: ClickRuler.RunStart? = found.map {
            ClickRuler.runStart(doubleCountedSec: $0.click.countedSec, runAnchorSec: $0.anchor,
                                delaySec: delaySec, doubleEverySec: descriptor.doubleEverySec)
        }
        var residual: Double?
        if let found, let start {
            residual = ClickRuler.residualSec(clicks, run: found.click.run, runAnchorSec: found.anchor,
                                              start: start, delaySec: delaySec)
        }
        let run: Int? = found?.click.run
        let heard = snapshot.events.filter { $0.run == run }
        let anchor: Double = found?.anchor ?? 0
        return InPointTrial(
            fixture: fixture,
            mode: precise ? "precise" : "approximate",
            requestedSec: requestedSec,
            timing: timing,
            currentTimeAfterSeekSec: afterSeek,
            delaySec: delaySec,
            runLabelSec: found?.anchor,
            runStartSec: start?.startSec,
            landingErrorSec: start.map { $0.startSec - requestedSec },
            markSec: start?.markSec,
            ambiguous: start?.ambiguous ?? false,
            residualSec: residual,
            clicksHeard: heard.count,
            minPeak: heard.map(\.peak).min(),
            firstEvents: heard.prefix(8).map { [$0.countedSec - anchor, Double($0.peak)] },
            discontinuities: snapshot.discontinuities,
            invalidRanges: snapshot.invalidRanges,
            tapFormat: snapshot.format,
            runAnchors: snapshot.runAnchors,
            maxLabelDriftSec: snapshot.maxLabelDriftSec,
            state: deck.stateDescription())
    }

    // MARK: - (2) out-point overshoot, three layers, 1x and 2x, never early

    struct OutPointTrial: Encodable {
        let fixture: String
        let rate: Float
        let layers: [Layer]
        let endSec: Double
        let startBelievedSec: Double
        let fires: [FireLog.Fire]
        let firstLayer: String?
        let settledSec: Double
        let pulledEndSec: Double?
        let watchdogArmDelaySec: Double?
        let watchdogTicks: Int?
        let maxLabelDriftSec: Double
        let state: String
    }

    func testOutPointOvershootAtOneAndTwoTimesAndNeverEarly() throws {
        let descriptor = try ClickTrackDescriptor.load()
        let end = Self.outPointSec
        var rows: [[String]] = []
        var early: [String] = []
        for fixture in descriptor.fixtures where end + 1 < fixture.durationSec {
            let url = try descriptor.url(of: fixture)
            for rate in Self.rates {
                for layers in Self.layerSets {
                    let trial = try measureOutPoint(url, fixture: fixture.file, rate: rate, layers: layers, endSec: end)
                    MeasurementReport.json(trial)
                    let label = "\(fixture.file) \(rate)x [\(layers.map(\.rawValue).joined(separator: "+"))]"

                    XCTAssertFalse(trial.fires.isEmpty, "\(label): no out-point layer fired: \(trial.state)")
                    for fire in trial.fires where fire.mediaSec < end - Self.neverEarlyToleranceSec {
                        early.append("\(label): \(fire.layer) fired at \(fire.mediaSec) s, \(ms(end - fire.mediaSec)) ms EARLY")
                    }
                    if !trial.fires.isEmpty, trial.settledSec < end - Self.neverEarlyToleranceSec {
                        early.append("\(label): settled at \(trial.settledSec) s, \(ms(end - trial.settledSec)) ms EARLY")
                    }

                    func overshoot(_ layer: Layer) -> String {
                        guard layers.contains(layer) else { return "" }
                        guard let fire = trial.fires.first(where: { $0.layer == layer.rawValue }) else { return "did not fire" }
                        return ms(fire.mediaSec - end)
                    }
                    let armed: String = layers.count == Layer.allCases.count ? "all three" : layers[0].rawValue
                    let pulled: Double? = trial.pulledEndSec.map { $0 - end }
                    var row: [String] = [fixture.file, String(format: "%.0fx", Double(rate)), armed, trial.firstLayer ?? "none"]
                    row.append(overshoot(.forwardEnd))
                    row.append(overshoot(.boundary))
                    row.append(overshoot(.watchdog))
                    row.append(ms(trial.settledSec - end))
                    row.append(ms(pulled))
                    row.append(ms(trial.watchdogArmDelaySec))
                    row.append(laterFires(trial))
                    rows.append(row)
                }
            }
        }
        MeasurementReport.table(
            title: "NE-25a (2): out-point overshoot (ms past the out-point; negative = EARLY)",
            columns: ["fixture", "rate", "layers armed", "fired first",
                      "forwardPlaybackEndTime ms", "boundary observer ms", "windowed watchdog ms",
                      "settled currentTime ms", "tap pulled-to ms (upper bound)", "watchdog one-shot delay ms",
                      "later fires (host ms after the first)"],
            rows: rows,
            notes: [
                "Out-point \(end) s, playback started \(Self.leadInSec) s before it, precise timing, zero-tolerance seek.",
                "A layer's number is the player's currentTime when it fired, minus the out-point. The first layer to fire stops playback (forwardPlaybackEndTime by itself; the others by pause()).",
                "The watchdog is armed at play: one timer at (end - t)/rate - 1.5 s, then a 250 ms poll.",
                "'tap pulled-to' is where the render pipeline had PULLED audio to, which is ahead of the speaker: an upper bound on audible overshoot, not the overshoot itself.",
                "Never-early tolerance: \(ms(Self.neverEarlyToleranceSec)) ms (stopPad \(ms(Self.stopPadSec)) ms).",
                early.isEmpty ? "No early stop was measured." : "EARLY STOPS MEASURED: " + early.joined(separator: "; "),
            ])
        XCTAssertEqual(early, [], "an out-point layer stopped EARLY (never-early, plan §4.3 P-2): record it and set NE-32's stopPad from it")
    }

    /// "boundaryObserver +3.1, windowedWatchdog +120.4": how long after the
    /// first layer each other layer reported, on the host clock. It is what
    /// says whether a slower layer is a backstop or merely a duplicate.
    private func laterFires(_ trial: OutPointTrial) -> String {
        guard let first = trial.fires.first else { return "-" }
        let later = trial.fires.dropFirst().map { "\($0.layer) +\(msValue($0.hostMs - first.hostMs))" }
        return later.isEmpty ? "-" : later.joined(separator: ", ")
    }

    private func measureOutPoint(_ url: URL, fixture: String, rate: Float, layers: [Layer], endSec: Double) throws -> OutPointTrial {
        let deck = MeasuredDeck()
        let log = FireLog()
        let watchdog = WindowedWatchdog()
        var boundaryToken: Any?
        var endObserver: NSObjectProtocol?
        defer {
            watchdog.cancel()
            if let boundaryToken { deck.player.removeTimeObserver(boundaryToken) }
            if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
            deck.tearDown()
        }
        _ = try deck.load(url, precise: true, seekToSec: endSec - Self.leadInSec, rate: rate)
        guard let item = deck.item else { throw MeasuredDeck.LoadError.noAudioTrack }
        let player = deck.player
        let startBelieved = deck.currentSec

        /* The first layer to fire wins, as it will per load token in NE-32:
           forwardPlaybackEndTime pauses by itself (actionAtItemEnd = .pause);
           the other two pause the player. Later fires are still recorded. */
        let fired: (Layer, Double) -> Void = { layer, mediaSec in
            if log.record(layer.rawValue, mediaSec: mediaSec), layer != .forwardEnd {
                player.pause()
            }
        }
        if layers.contains(.forwardEnd) {
            item.forwardPlaybackEndTime = cmTime(endSec)
            endObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
            ) { _ in
                fired(.forwardEnd, item.currentTime().seconds)
            }
        }
        if layers.contains(.boundary) {
            boundaryToken = player.addBoundaryTimeObserver(forTimes: [NSValue(time: cmTime(endSec))], queue: .main) {
                fired(.boundary, player.currentTime().seconds)
            }
        }

        player.playImmediately(atRate: rate)
        if layers.contains(.watchdog) {
            watchdog.arm(player: player, endSec: endSec, rate: Double(rate)) { mediaSec in
                fired(.watchdog, mediaSec)
            }
        }
        spin(timeoutSec: Self.leadInSec / Double(rate) + 3) { !log.fires.isEmpty }
        /* Let the stop settle, and give the layers that lost a chance to report. */
        spin(timeoutSec: 1.0) { false }
        let settled = deck.currentSec
        let snapshot = deck.recorder.snapshot()
        return OutPointTrial(
            fixture: fixture,
            rate: rate,
            layers: layers,
            endSec: endSec,
            startBelievedSec: startBelieved,
            fires: log.fires,
            firstLayer: log.fires.first?.layer,
            settledSec: settled,
            pulledEndSec: snapshot.pulledEndSec,
            watchdogArmDelaySec: layers.contains(.watchdog) ? watchdog.armDelaySec : nil,
            watchdogTicks: layers.contains(.watchdog) ? watchdog.ticks : nil,
            maxLabelDriftSec: snapshot.maxLabelDriftSec,
            state: deck.stateDescription())
    }
}
